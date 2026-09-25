import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import * as AccountDeletions from "../account/AccountDeletions.ts";
import * as RelayConfiguration from "../Config.ts";
import * as AiReports from "./AiReports.ts";
import fixtures from "./report-contract.fixtures.json" with { type: "json" };
import { reportRoutes } from "./routes.ts";

type Stored = AiReports.StoredReport & { contentHash: string };

function memoryStore() {
  const rows = new Map<string, Stored>();
  const calls = { count: 0 };
  const store = AiReports.AiReportStore.of({
    find: (id) =>
      Effect.sync(() => {
        calls.count++;
        return rows.get(id) ?? null;
      }),
    insert: (row) =>
      Effect.sync(() => {
        calls.count++;
        if (rows.has(row.id)) return false;
        rows.set(row.id, row);
        return true;
      }),
    counts: (input) =>
      Effect.sync(() => {
        const all = [...rows.values()];
        return {
          total: all.length,
          since: all.filter((row) => row.receivedAt >= input.since).length,
          oldest: all.map((row) => row.receivedAt).sort()[0] ?? null,
        };
      }),
    pruneBefore: (before) =>
      Effect.sync(() => {
        for (const [id, row] of rows) if (row.receivedAt < before) rows.delete(id);
      }),
    list: (limit) => Effect.succeed([...rows.values()].slice(0, limit)),
    remove: (id) => Effect.sync(() => rows.delete(id)),
  });
  return { rows, calls, layer: Layer.succeed(AiReports.AiReportStore, store) };
}

const reportsLayer = (
  store: Layer.Layer<AiReports.AiReportStore>,
  options?: Parameters<typeof AiReports.make>[0],
) =>
  Layer.effect(AiReports.AiReports, AiReports.make(options)).pipe(
    Layer.provide(Layer.mergeAll(store, NodeCrypto.layer)),
  );

const withReports = <A, E>(
  layer: Layer.Layer<AiReports.AiReports>,
  body: (reports: AiReports.AiReports["Service"]) => Effect.Effect<A, E>,
) => AiReports.AiReports.pipe(Effect.flatMap(body), Effect.provide(layer));

const caseBody = (entry: (typeof fixtures.cases)[number]) => {
  const body = entry.body as Record<string, unknown>;
  if ("excerptRepeat" in entry) body.excerpt = "a".repeat(entry.excerptRepeat);
  if ("notesRepeat" in entry) body.notes = "a".repeat(entry.notesRepeat);
  return JSON.stringify(body);
};

const report = (id: string, excerpt = "said something harmful", extra: object = {}) =>
  JSON.stringify({ id, reason: "Harmful content", excerpt, notes: "", ...extra });
const operatorDeletionBody = JSON.stringify({ userId: "user_emailed" });

const ids = Array.from(
  { length: 12 },
  (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
);

describe("AiReports", () => {
  for (const entry of fixtures.cases) {
    it.effect(`contract: ${entry.name}`, () =>
      AiReports.parseReport(caseBody(entry)).pipe(
        Effect.result,
        Effect.map((result) => {
          expect(result._tag === "Success").toBe(entry.accepted);
          if (result._tag === "Success" && "normalizedId" in entry) {
            expect(result.success.id).toBe(entry.normalizedId);
          }
        }),
      ),
    );
  }

  it.effect("rejects malformed JSON as invalid", () =>
    AiReports.parseReport("{not json").pipe(
      Effect.flip,
      Effect.map((error) => expect(error.reason).toBe("invalid")),
    ),
  );

  it.effect(
    "returns the same receipt for a repeat and refuses changed content under the id",
    () => {
      const { rows, layer } = memoryStore();
      return withReports(reportsLayer(layer), (reports) =>
        Effect.gen(function* () {
          expect(yield* reports.submit(report(ids[0]!))).toEqual({ id: ids[0], created: true });
          expect(yield* reports.submit(report(ids[0]!))).toEqual({ id: ids[0], created: false });
          const changed = yield* reports.submit(report(ids[0]!, "different")).pipe(Effect.flip);
          expect(changed).toMatchObject({ _tag: "ReportRejected", reason: "conflict" });
          expect(rows.size).toBe(1);
          // Only the four allowed fields, a hash and the time are stored.
          expect(Object.keys(rows.get(ids[0]!)!).sort()).toEqual(
            ["contentHash", "excerpt", "id", "notes", "reason", "receivedAt"].sort(),
          );
        }),
      );
    },
  );

  it.effect("an uppercase repeat of a stored report matches it", () => {
    const { layer } = memoryStore();
    return withReports(reportsLayer(layer), (reports) =>
      Effect.gen(function* () {
        yield* reports.submit(report(ids[1]!));
        expect(yield* reports.submit(report(ids[1]!.toUpperCase()))).toEqual({
          id: ids[1],
          created: false,
        });
      }),
    );
  });

  it.effect("a lost receipt is recovered even after the hourly limit is reached", () => {
    const { layer } = memoryStore();
    return withReports(reportsLayer(layer, { hourlyLimit: 2 }), (reports) =>
      Effect.gen(function* () {
        yield* reports.submit(report(ids[0]!));
        yield* reports.submit(report(ids[1]!));
        const limited = yield* reports.submit(report(ids[2]!)).pipe(Effect.flip);
        expect(limited).toMatchObject({ reason: "rate_limited" });
        expect(yield* reports.accepting).toBe(false);
        expect(yield* reports.submit(report(ids[0]!))).toEqual({ id: ids[0], created: false });

        yield* TestClock.adjust("61 minutes");
        expect(yield* reports.submit(report(ids[2]!))).toEqual({ id: ids[2], created: true });
      }),
    );
  });

  it.effect("stops accepting at capacity without dropping stored reports", () => {
    const { rows, layer } = memoryStore();
    return withReports(reportsLayer(layer, { capacity: 2 }), (reports) =>
      Effect.gen(function* () {
        yield* reports.submit(report(ids[0]!));
        yield* reports.submit(report(ids[1]!));
        const full = yield* reports.submit(report(ids[2]!)).pipe(Effect.flip);
        expect(full).toMatchObject({ reason: "unavailable" });
        expect(rows.size).toBe(2);
      }),
    );
  });

  it.effect("does not reveal expired reports to operators even if the cron has not run", () => {
    const { rows, layer } = memoryStore();
    return withReports(reportsLayer(layer), (reports) =>
      Effect.gen(function* () {
        yield* reports.submit(report(ids[0]!));
        yield* TestClock.adjust("7 days");
        yield* TestClock.adjust("1 minute");
        expect(yield* reports.list(100)).toEqual([]);
        expect(rows.size).toBe(0);
      }),
    );
  });

  it.effect("deletes unresolved reports after seven days", () => {
    const { rows, layer } = memoryStore();
    return withReports(reportsLayer(layer), (reports) =>
      Effect.gen(function* () {
        yield* reports.submit(report(ids[0]!));
        yield* TestClock.adjust("6 days");
        yield* reports.prune;
        expect(rows.size).toBe(1);
        yield* TestClock.adjust("1 day");
        yield* TestClock.adjust("1 minute");
        yield* reports.prune;
        expect(rows.size).toBe(0);
        expect((yield* reports.summary).stored).toBe(0);
      }),
    );
  });
});

describe("report routes", () => {
  const operatorToken = "o".repeat(40);

  const serve = (options: { operatorToken?: string } = {}) => {
    const { rows, calls, layer } = memoryStore();
    const deletionRequests: Array<string> = [];
    const services = Layer.mergeAll(
      reportsLayer(layer, { hourlyLimit: 100 }),
      Layer.mock(AccountDeletions.AccountDeletions, {
        summary: Effect.succeed({ pending: 0, stalled: 0, oldestPendingRequestedAt: null }),
        requestByOperator: (userId: string) => {
          deletionRequests.push(userId);
          return Effect.succeed({
            status: "pending" as const,
            requestedAt: "2026-09-25T00:00:00.000Z",
          });
        },
      }),
      Layer.succeed(
        RelayConfiguration.RelayConfiguration,
        RelayConfiguration.make({
          relayIssuer: "https://relay.example.test",
          apns: null,
          clerkSecretKey: Redacted.make("sk"),
          clerkPublishableKey: "pk",
          clerkJwtAudience: "aud",
          apnsDeliveryJobSigningSecret: Redacted.make("s"),
          cloudMintPrivateKey: Redacted.make("k"),
          cloudMintPublicKey: "p",
          managedEndpointBaseDomain: undefined,
          managedEndpointNamespace: undefined,
          ...(options.operatorToken ? { operatorToken: Redacted.make(options.operatorToken) } : {}),
        }),
      ),
      NodeCrypto.layer,
    );
    const app = HttpRouter.toWebHandler(
      reportRoutes.pipe(Layer.provide(services), Layer.provide(HttpServer.layerServices)),
      { disableLogger: true },
    );
    return { app, rows, calls, deletionRequests };
  };

  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request("https://relay.example.test/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  it.effect("accepts a report, returns the receipt, and never caches", () =>
    Effect.gen(function* () {
      const { app, rows } = serve();
      const created = yield* Effect.promise(() => app.handler(post(report(ids[3]!))));
      expect(created.status).toBe(201);
      expect(created.headers.get("cache-control")).toBe("no-store");
      expect(yield* Effect.promise(() => created.json())).toEqual({ id: ids[3] });
      const repeated = yield* Effect.promise(() => app.handler(post(report(ids[3]!))));
      expect(repeated.status).toBe(200);
      expect(rows.size).toBe(1);
      yield* Effect.promise(() => app.dispose());
    }),
  );

  it.effect("refuses the wrong content type, oversized bodies and invalid reports", () =>
    Effect.gen(function* () {
      const { app, rows } = serve();
      const plain = yield* Effect.promise(() =>
        app.handler(post(report(ids[4]!), { "content-type": "text/plain" })),
      );
      expect(plain.status).toBe(415);
      const huge = yield* Effect.promise(() =>
        app.handler(post(report(ids[4]!, "a".repeat(AiReports.REPORT_BODY_LIMIT + 1)))),
      );
      expect(huge.status).toBe(413);
      const extra = yield* Effect.promise(() =>
        app.handler(post(report(ids[4]!, "x", { token: "secret" }))),
      );
      expect(extra.status).toBe(400);
      // Error bodies never echo the submitted text.
      expect(yield* Effect.promise(() => extra.text())).not.toContain("secret");
      expect(rows.size).toBe(0);
      yield* Effect.promise(() => app.dispose());
    }),
  );

  it.effect("stops reading an endless body without Content-Length at the limit", () =>
    Effect.gen(function* () {
      const { app, rows, calls } = serve();
      const chunk = new TextEncoder().encode(`{"notes":"${"a".repeat(16_000)}`);
      let pulled = 0;
      let cancelled = false;
      const endless = new ReadableStream<Uint8Array>({
        pull: (controller) => {
          pulled += chunk.length;
          controller.enqueue(chunk);
        },
        cancel: () => {
          cancelled = true;
        },
      });
      const request = new Request("https://relay.example.test/v1/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: endless,
        duplex: "half",
      } as RequestInit);
      expect(request.headers.get("content-length")).toBeNull();

      const response = yield* Effect.promise(() => app.handler(request));
      expect(response.status).toBe(413);
      expect(cancelled).toBe(true);
      // The stream is read to just past the limit, plus whatever it buffered ahead.
      expect(pulled).toBeLessThan(AiReports.REPORT_BODY_LIMIT + 4 * chunk.length);
      expect(calls.count).toBe(0);
      expect(rows.size).toBe(0);
      yield* Effect.promise(() => app.dispose());
    }),
  );

  it.effect("accepts a streamed body without Content-Length under the limit", () =>
    Effect.gen(function* () {
      const { app, rows } = serve();
      const bytes = new TextEncoder().encode(report(ids[6]!));
      const request = new Request("https://relay.example.test/v1/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(bytes.slice(0, 10));
            controller.enqueue(bytes.slice(10));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit);
      const response = yield* Effect.promise(() => app.handler(request));
      expect(response.status).toBe(201);
      expect(rows.size).toBe(1);
      yield* Effect.promise(() => app.dispose());
    }),
  );

  it.effect("health says whether reports are accepted, without counts", () =>
    Effect.gen(function* () {
      const { app } = serve();
      const response = yield* Effect.promise(() =>
        app.handler(new Request("https://relay.example.test/v1/reports/health")),
      );
      expect(yield* Effect.promise(() => response.json())).toEqual({ ok: true, accepting: true });
      yield* Effect.promise(() => app.dispose());
    }),
  );

  it.effect("operator routes are absent without a token and refuse a wrong one", () =>
    Effect.gen(function* () {
      const disabled = serve();
      const absent = yield* Effect.promise(() =>
        disabled.app.handler(new Request("https://relay.example.test/v1/operator/reports")),
      );
      expect(absent.status).toBe(404);
      yield* Effect.promise(() => disabled.app.dispose());

      const { app } = serve({ operatorToken });
      const wrong = yield* Effect.promise(() =>
        app.handler(
          new Request("https://relay.example.test/v1/operator/reports", {
            headers: { authorization: `Bearer ${"x".repeat(40)}` },
          }),
        ),
      );
      expect(wrong.status).toBe(401);
      yield* Effect.promise(() => app.dispose());
    }),
  );

  it.effect("the operator can list, delete a report early, and queue an emailed deletion", () =>
    Effect.gen(function* () {
      const { app, rows, deletionRequests } = serve({ operatorToken });
      const authorization = `Bearer ${operatorToken}`;
      yield* Effect.promise(() => app.handler(post(report(ids[5]!))));

      const listed = yield* Effect.promise(() =>
        app.handler(
          new Request("https://relay.example.test/v1/operator/reports", {
            headers: { authorization },
          }),
        ),
      );
      const body = (yield* Effect.promise(() => listed.json())) as {
        reports: Array<{ id: string }>;
      };
      expect(body.reports.map((entry) => entry.id)).toEqual([ids[5]]);

      const removed = yield* Effect.promise(() =>
        app.handler(
          new Request(`https://relay.example.test/v1/operator/reports/${ids[5]}`, {
            method: "DELETE",
            headers: { authorization },
          }),
        ),
      );
      expect(removed.status).toBe(200);
      expect(rows.size).toBe(0);

      const queued = yield* Effect.promise(() =>
        app.handler(
          new Request("https://relay.example.test/v1/operator/account-deletions", {
            method: "POST",
            headers: { authorization, "content-type": "application/json" },
            body: operatorDeletionBody,
          }),
        ),
      );
      expect(queued.status).toBe(202);
      expect(deletionRequests).toEqual(["user_emailed"]);
      yield* Effect.promise(() => app.dispose());
    }),
  );

  it.effect("serves the public pages as static HTML with strict headers", () =>
    Effect.gen(function* () {
      const { app } = serve();
      for (const path of ["/privacy", "/support", "/terms", "/delete-account"]) {
        const page = yield* Effect.promise(() =>
          app.handler(new Request(`https://relay.example.test${path}`)),
        );
        expect(page.status).toBe(200);
        expect(page.headers.get("content-type")).toContain("text/html");
        expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
        expect(page.headers.get("x-content-type-options")).toBe("nosniff");
        expect(yield* Effect.promise(() => page.text())).toContain("<!doctype html>");
      }
      const missing = yield* Effect.promise(() =>
        app.handler(new Request("https://relay.example.test/privacy-old")),
      );
      expect(missing.status).toBe(404);
      yield* Effect.promise(() => app.dispose());
    }),
  );
});
