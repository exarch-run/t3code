import { count, eq, gte, lt, min } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayAiReports } from "../persistence/schema.ts";

// The report shape, limits and allowlist match Exarch's
// src/shared/mobile-report.ts, which the phone uses to build and check a
// report before sending it. Change both together; the fixtures in
// AiReports.test.ts are shared with Exarch's apps/mobile/test/report-contract.test.ts.
export const REPORT_REASONS = ["Harmful content", "Misleading content", "Something else"] as const;
export const REPORT_TEXT_LIMIT = 8_000;
export const REPORT_NOTES_LIMIT = 2_000;
export const REPORT_BODY_LIMIT = 64_000;
// Delete resolved reports immediately; this is the maximum unresolved review window.
export const REPORT_RETENTION_DAYS = 7;
export const REPORT_CAPACITY = 10_000;
export const REPORT_HOURLY_LIMIT = 100;

export const AiReport = Schema.Struct({
  id: Schema.String.check(
    Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i),
  ),
  reason: Schema.Literals(REPORT_REASONS),
  excerpt: Schema.String.check(Schema.isMaxLength(REPORT_TEXT_LIMIT)),
  notes: Schema.String.check(Schema.isMaxLength(REPORT_NOTES_LIMIT)),
});
export type AiReport = typeof AiReport.Type;

const decodeReportJson = Schema.decodeUnknownEffect(Schema.fromJsonString(AiReport));

/** Why a report was refused. The HTTP route maps each to a status. */
export class ReportRejected extends Schema.TaggedError<ReportRejected>()("ReportRejected", {
  reason: Schema.Literals(["invalid", "conflict", "rate_limited", "unavailable"]),
}) {}

export class ReportStorageError extends Schema.TaggedError<ReportStorageError>()(
  "ReportStorageError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Report storage failed during '${this.operation}'`;
  }
}

export interface StoredReport extends AiReport {
  readonly receivedAt: string;
}

export interface ReportSummary {
  readonly stored: number;
  readonly lastHour: number;
  readonly oldestReceivedAt: string | null;
  readonly capacity: number;
  readonly hourlyLimit: number;
  readonly retentionDays: number;
}

export class AiReportStore extends Context.Service<
  AiReportStore,
  {
    readonly find: (
      id: string,
    ) => Effect.Effect<{ readonly contentHash: string } | null, ReportStorageError>;
    /** Returns false when a report with this id already exists. */
    readonly insert: (
      row: AiReport & { readonly contentHash: string; readonly receivedAt: string },
    ) => Effect.Effect<boolean, ReportStorageError>;
    readonly counts: (input: {
      readonly since: string;
    }) => Effect.Effect<
      { readonly total: number; readonly since: number; readonly oldest: string | null },
      ReportStorageError
    >;
    readonly pruneBefore: (before: string) => Effect.Effect<void, ReportStorageError>;
    readonly list: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<StoredReport>, ReportStorageError>;
    readonly remove: (id: string) => Effect.Effect<boolean, ReportStorageError>;
  }
>()("t3code-relay/reports/AiReports/AiReportStore") {}

export class AiReports extends Context.Service<
  AiReports,
  {
    /** Accepts a raw JSON body. `created` is false when an identical report was already received. */
    readonly submit: (
      body: string,
    ) => Effect.Effect<
      { readonly id: string; readonly created: boolean },
      ReportRejected | ReportStorageError
    >;
    /** Whether a new report would be accepted now. For uptime monitors; reveals no counts. */
    readonly accepting: Effect.Effect<boolean, ReportStorageError>;
    readonly prune: Effect.Effect<void, ReportStorageError>;
    readonly summary: Effect.Effect<ReportSummary, ReportStorageError>;
    readonly list: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<StoredReport>, ReportStorageError>;
    readonly remove: (id: string) => Effect.Effect<boolean, ReportStorageError>;
  }
>()("t3code-relay/reports/AiReports") {}

const rejected = (reason: ReportRejected["reason"]) => new ReportRejected({ reason });

/** Parses exactly the four allowed fields. Anything else, including extra keys, is refused. */
export const parseReport = Effect.fn("relay.reports.parse")(function* (body: string) {
  const report = yield* decodeReportJson(body, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => rejected("invalid")),
  );
  if (!report.excerpt.trim() && !report.notes.trim()) return yield* rejected("invalid");
  return { ...report, id: report.id.toLowerCase() };
});

export const make = (options?: { readonly capacity?: number; readonly hourlyLimit?: number }) =>
  Effect.gen(function* () {
    const store = yield* AiReportStore;
    const crypto = yield* Crypto.Crypto;
    const capacity = options?.capacity ?? REPORT_CAPACITY;
    const hourlyLimit = options?.hourlyLimit ?? REPORT_HOURLY_LIMIT;

    const hash = (report: AiReport) =>
      crypto
        .digest(
          "SHA-256",
          // Length prefixes keep the excerpt/notes boundary unambiguous.
          new TextEncoder().encode(
            [report.id, report.reason, report.excerpt, report.notes]
              .map((part) => `${part.length}:${part}`)
              .join(""),
          ),
        )
        .pipe(
          Effect.map(Encoding.encodeBase64Url),
          Effect.mapError((cause) => new ReportStorageError({ operation: "hash", cause })),
        );

    const prune = Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* store.pruneBefore(
        DateTime.formatIso(DateTime.subtract(now, { days: REPORT_RETENTION_DAYS })),
      );
    });

    const counts = Effect.gen(function* () {
      const now = yield* DateTime.now;
      return yield* store.counts({
        since: DateTime.formatIso(DateTime.subtract(now, { hours: 1 })),
      });
    });

    /** A repeat with the same content gets its receipt again. Changed content under a used id is refused. */
    const matchExisting = Effect.fnUntraced(function* (id: string, contentHash: string) {
      const existing = yield* store.find(id);
      if (existing === null) return false;
      if (existing.contentHash !== contentHash) return yield* rejected("conflict");
      return true;
    });

    return AiReports.of({
      submit: Effect.fn("relay.reports.submit")(function* (body) {
        const report = yield* parseReport(body);
        const contentHash = yield* hash(report);
        yield* prune;
        // Checked before the limits, so a lost receipt can always be recovered.
        if (yield* matchExisting(report.id, contentHash)) {
          return { id: report.id, created: false };
        }
        const current = yield* counts;
        if (current.since >= hourlyLimit) return yield* rejected("rate_limited");
        if (current.total >= capacity) return yield* rejected("unavailable");
        const receivedAt = DateTime.formatIso(yield* DateTime.now);
        const inserted = yield* store.insert({ ...report, contentHash, receivedAt });
        if (!inserted) {
          // A concurrent submission of the same id won the insert.
          yield* matchExisting(report.id, contentHash);
          return { id: report.id, created: false };
        }
        yield* Effect.annotateCurrentSpan({ "relay.reports.accepted": true });
        return { id: report.id, created: true };
      }),
      accepting: Effect.map(
        counts,
        (current) => current.since < hourlyLimit && current.total < capacity,
      ),
      prune,
      summary: Effect.map(counts, (current) => ({
        stored: current.total,
        lastHour: current.since,
        oldestReceivedAt: current.oldest,
        capacity,
        hourlyLimit,
        retentionDays: REPORT_RETENTION_DAYS,
      })),
      list: (limit) => prune.pipe(Effect.andThen(() => store.list(limit))),
      remove: store.remove,
    });
  });

export const layer = Layer.effect(AiReports, make());

const storage =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new ReportStorageError({ operation, cause })));

export const storeLayer = Layer.effect(
  AiReportStore,
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    const t = relayAiReports;
    return AiReportStore.of({
      find: (id) =>
        db
          .select({ contentHash: t.contentHash })
          .from(t)
          .where(eq(t.id, id))
          .pipe(
            storage("find"),
            Effect.map(([row]) => row ?? null),
          ),
      insert: (row) =>
        db
          .insert(t)
          .values(row)
          .onConflictDoNothing()
          .returning({ id: t.id })
          .pipe(
            storage("insert"),
            Effect.map((rows) => rows.length > 0),
          ),
      counts: (input) =>
        Effect.all([
          db.select({ total: count(), oldest: min(t.receivedAt) }).from(t),
          db.select({ since: count() }).from(t).where(gte(t.receivedAt, input.since)),
        ]).pipe(
          storage("count"),
          Effect.map(([[all], [recent]]) => ({
            total: all?.total ?? 0,
            since: recent?.since ?? 0,
            oldest: all?.oldest ?? null,
          })),
        ),
      pruneBefore: (before) =>
        db.delete(t).where(lt(t.receivedAt, before)).pipe(storage("prune"), Effect.asVoid),
      list: (limit) =>
        db
          .select({
            id: t.id,
            reason: t.reason,
            excerpt: t.excerpt,
            notes: t.notes,
            receivedAt: t.receivedAt,
          })
          .from(t)
          .orderBy(t.receivedAt)
          .limit(limit)
          .pipe(
            storage("list"),
            Effect.map((rows) => rows as ReadonlyArray<StoredReport>),
          ),
      remove: (id) =>
        db
          .delete(t)
          .where(eq(t.id, id))
          .returning({ id: t.id })
          .pipe(
            storage("remove"),
            Effect.map((rows) => rows.length > 0),
          ),
    });
  }),
);
