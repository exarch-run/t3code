import { createClerkClient } from "@clerk/backend";
import { isClerkAPIResponseError } from "@clerk/backend/errors";
import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type { RelayAccountDeletionResponse } from "@t3tools/contracts/relay";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import {
  relayAccountDeletions,
  relayAgentActivityRows,
  relayDeliveryAttempts,
  relayEnvironmentCredentials,
  relayEnvironmentLinks,
  relayIdentityChecks,
  relayLiveActivities,
  relayManagedEndpointAllocations,
  relayManagedTunnelLimits,
  relayMobileDevices,
} from "../persistence/schema.ts";

// Requests in flight when the tombstone lands finish within the relay's 9s
// request deadline. Waiting longer than that before cleanup means no request
// authorized before the tombstone can write a row after cleanup has run.
export const DELETION_SETTLE_SECONDS = 30;
export const DELETION_LEASE_MINUTES = 10;
export const DELETION_STALLED_ATTEMPTS = 5;
// Relay tokens live 30 minutes and Clerk ends sessions when the user is
// deleted, so a completed tombstone has nothing left to refuse after a day.
export const COMPLETED_TOMBSTONE_HOURS = 24;
export const IDENTITY_CHECK_HOURS = 24;
const IDENTITY_CHECKS_PER_RUN = 20;
const DELETIONS_PER_RUN = 10;

export type DeletionSource = "user" | "identity_missing" | "operator";

export class AccountDeletionPersistenceError extends Schema.TaggedError<AccountDeletionPersistenceError>()(
  "AccountDeletionPersistenceError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Account deletion storage failed during '${this.operation}'`;
  }
}

export class AccountIdentityError extends Schema.TaggedError<AccountIdentityError>()(
  "AccountIdentityError",
  {
    operation: Schema.Literals(["check", "delete"]),
    status: Schema.optionalKey(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Identity provider call '${this.operation}' failed`;
  }
}

export class AccountTeardownError extends Schema.TaggedError<AccountTeardownError>()(
  "AccountTeardownError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Environment teardown failed";
  }
}

export interface DeletionSummary {
  readonly pending: number;
  readonly stalled: number;
  readonly oldestPendingRequestedAt: string | null;
}

/** Durable deletion state and the user-owned rows it removes. */
export class AccountDeletionStore extends Context.Service<
  AccountDeletionStore,
  {
    /** Records the tombstone. A repeat returns the existing record unchanged. */
    readonly request: (input: {
      readonly userId: string;
      readonly requestId: string;
      readonly source: DeletionSource;
      readonly now: string;
    }) => Effect.Effect<RelayAccountDeletionResponse, AccountDeletionPersistenceError>;
    /** Sends a completed deletion back to pending, for rows that appeared after cleanup. */
    readonly reopen: (input: {
      readonly userId: string;
      readonly now: string;
    }) => Effect.Effect<void, AccountDeletionPersistenceError>;
    readonly isBlocked: (userId: string) => Effect.Effect<boolean, AccountDeletionPersistenceError>;
    /** Leases due deletions so overlapping runs never process the same user. */
    readonly claimDue: (input: {
      readonly now: string;
      readonly settledBefore: string;
      readonly leaseUntil: string;
      readonly limit: number;
    }) => Effect.Effect<
      ReadonlyArray<{ readonly userId: string; readonly attempts: number }>,
      AccountDeletionPersistenceError
    >;
    readonly environmentIdsForUser: (
      userId: string,
    ) => Effect.Effect<ReadonlyArray<string>, AccountDeletionPersistenceError>;
    /**
     * Deletes every row keyed by the user in one transaction. Credentials and
     * activity for an environment go only when no other user still links it.
     */
    readonly purgeUser: (input: {
      readonly userId: string;
      readonly environmentIds: ReadonlyArray<string>;
      readonly now: string;
    }) => Effect.Effect<void, AccountDeletionPersistenceError>;
    readonly markCompleted: (input: {
      readonly userId: string;
      readonly now: string;
    }) => Effect.Effect<void, AccountDeletionPersistenceError>;
    readonly recordFailure: (input: {
      readonly userId: string;
      readonly code: string;
      readonly nextAttemptAt: string;
      readonly now: string;
    }) => Effect.Effect<void, AccountDeletionPersistenceError>;
    readonly pruneCompleted: (input: {
      readonly completedBefore: string;
    }) => Effect.Effect<void, AccountDeletionPersistenceError>;
    /** Users with relay rows whose identity hasn't been checked since `checkedBefore`. */
    readonly usersToCheck: (input: {
      readonly checkedBefore: string;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<string>, AccountDeletionPersistenceError>;
    readonly markChecked: (input: {
      readonly userId: string;
      readonly now: string;
    }) => Effect.Effect<void, AccountDeletionPersistenceError>;
    readonly summary: (input: {
      readonly stalledAttempts: number;
    }) => Effect.Effect<DeletionSummary, AccountDeletionPersistenceError>;
  }
>()("t3code-relay/account/AccountDeletions/AccountDeletionStore") {}

/** The sign-in identity behind a relay user id. */
export class AccountIdentities extends Context.Service<
  AccountIdentities,
  {
    readonly exists: (userId: string) => Effect.Effect<boolean, AccountIdentityError>;
    /** Deleting an identity that is already gone succeeds. */
    readonly remove: (userId: string) => Effect.Effect<void, AccountIdentityError>;
  }
>()("t3code-relay/account/AccountDeletions/AccountIdentities") {}

/** Revokes one environment link and releases its managed tunnel, as unlinking does. */
export class EnvironmentTeardown extends Context.Service<
  EnvironmentTeardown,
  {
    readonly unlink: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<void, AccountTeardownError>;
  }
>()("t3code-relay/account/AccountDeletions/EnvironmentTeardown") {}

export class AccountDeletions extends Context.Service<
  AccountDeletions,
  {
    readonly request: (input: {
      readonly userId: string;
      readonly requestId: string;
    }) => Effect.Effect<RelayAccountDeletionResponse, AccountDeletionPersistenceError>;
    /** Queues a deletion confirmed by email, by Clerk user id. */
    readonly requestByOperator: (
      userId: string,
    ) => Effect.Effect<RelayAccountDeletionResponse, AccountDeletionPersistenceError>;
    /** Fails open on storage errors; the identity check re-runs cleanup for anything that slips past. */
    readonly isBlocked: (userId: string) => Effect.Effect<boolean>;
    readonly processDue: Effect.Effect<
      { readonly completed: number; readonly failed: number },
      AccountDeletionPersistenceError
    >;
    readonly reconcileIdentities: Effect.Effect<
      { readonly checked: number; readonly missing: number },
      AccountDeletionPersistenceError
    >;
    readonly pruneCompleted: Effect.Effect<void, AccountDeletionPersistenceError>;
    readonly summary: Effect.Effect<DeletionSummary, AccountDeletionPersistenceError>;
  }
>()("t3code-relay/account/AccountDeletions") {}

/** Minutes to wait before retry `attempts` (1-based): 5, 10, 20 … capped at six hours. */
export function retryDelayMinutes(attempts: number): number {
  return Math.min(5 * 2 ** Math.max(0, attempts - 1), 360);
}

function failureCode(
  error: AccountTeardownError | AccountIdentityError | AccountDeletionPersistenceError,
) {
  switch (error._tag) {
    case "AccountTeardownError":
      return "environment_teardown";
    case "AccountIdentityError":
      return error.status ? `identity_${error.status}` : "identity_unavailable";
    case "AccountDeletionPersistenceError":
      return `storage_${error.operation}`;
  }
}

const isoAfter = (now: DateTime.Utc, parts: Partial<DateTime.DateTime.PartsForMath>) =>
  DateTime.formatIso(DateTime.add(now, parts));
const isoBefore = (now: DateTime.Utc, parts: Partial<DateTime.DateTime.PartsForMath>) =>
  DateTime.formatIso(DateTime.subtract(now, parts));

export const make = Effect.gen(function* () {
  const store = yield* AccountDeletionStore;
  const identities = yield* AccountIdentities;
  const teardown = yield* EnvironmentTeardown;

  const deleteOne = Effect.fn("relay.account_deletion.delete_user")(function* (userId: string) {
    const environmentIds = yield* store.environmentIdsForUser(userId);
    for (const environmentId of environmentIds) {
      yield* teardown.unlink({ userId, environmentId });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* store.purgeUser({ userId, environmentIds, now });
    yield* identities.remove(userId);
    yield* store.markCompleted({ userId, now: DateTime.formatIso(yield* DateTime.now) });
  });

  const processDue: AccountDeletions["Service"]["processDue"] = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const claimed = yield* store.claimDue({
      now: DateTime.formatIso(now),
      settledBefore: isoBefore(now, { seconds: DELETION_SETTLE_SECONDS }),
      leaseUntil: isoAfter(now, { minutes: DELETION_LEASE_MINUTES }),
      limit: DELETIONS_PER_RUN,
    });
    let completed = 0;
    let failed = 0;
    for (const { userId, attempts } of claimed) {
      const outcome = yield* deleteOne(userId).pipe(Effect.result);
      if (outcome._tag === "Success") {
        completed++;
        continue;
      }
      failed++;
      const code = failureCode(outcome.failure);
      // The code names the failing step only. Causes can carry request details.
      yield* Effect.logWarning("account deletion attempt failed", {
        "relay.account_deletion.attempts": attempts,
        "relay.account_deletion.failure": code,
      });
      const failedAt = yield* DateTime.now;
      yield* store.recordFailure({
        userId,
        code,
        nextAttemptAt: isoAfter(failedAt, { minutes: retryDelayMinutes(attempts) }),
        now: DateTime.formatIso(failedAt),
      });
    }
    yield* Effect.annotateCurrentSpan({
      "relay.account_deletion.claimed": claimed.length,
      "relay.account_deletion.completed": completed,
      "relay.account_deletion.failed": failed,
    });
    return { completed, failed };
  }).pipe(Effect.withSpan("relay.account_deletion.process_due"));

  const reconcileIdentities: AccountDeletions["Service"]["reconcileIdentities"] = Effect.gen(
    function* () {
      const now = yield* DateTime.now;
      const users = yield* store.usersToCheck({
        checkedBefore: isoBefore(now, { hours: IDENTITY_CHECK_HOURS }),
        limit: IDENTITY_CHECKS_PER_RUN,
      });
      let missing = 0;
      for (const userId of users) {
        const exists = yield* identities.exists(userId).pipe(Effect.result);
        // An unreachable identity provider proves nothing. Try again next run.
        if (exists._tag === "Failure") continue;
        const at = DateTime.formatIso(yield* DateTime.now);
        if (exists.success) {
          yield* store.markChecked({ userId, now: at });
          continue;
        }
        missing++;
        const recorded = yield* store.request({
          userId,
          requestId: `identity-missing-${at}`,
          source: "identity_missing",
          now: at,
        });
        // Rows can outlive a completed deletion only if written during cleanup.
        if (recorded.status === "completed") yield* store.reopen({ userId, now: at });
      }
      yield* Effect.annotateCurrentSpan({
        "relay.identity_check.checked": users.length,
        "relay.identity_check.missing": missing,
      });
      return { checked: users.length, missing };
    },
  ).pipe(Effect.withSpan("relay.account_deletion.reconcile_identities"));

  return AccountDeletions.of({
    request: Effect.fn("relay.account_deletion.request")(function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* store.request({ ...input, source: "user", now });
    }),
    requestByOperator: Effect.fn("relay.account_deletion.request_by_operator")(function* (userId) {
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* store.request({
        userId,
        requestId: `operator-${now}`,
        source: "operator",
        now,
      });
    }),
    isBlocked: (userId) =>
      store
        .isBlocked(userId)
        .pipe(
          Effect.catch(() =>
            Effect.annotateCurrentSpan({ "relay.account_deletion.check_failed": true }).pipe(
              Effect.as(false),
            ),
          ),
        ),
    processDue,
    reconcileIdentities,
    pruneCompleted: Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* store.pruneCompleted({
        completedBefore: isoBefore(now, { hours: COMPLETED_TOMBSTONE_HOURS }),
      });
    }),
    summary: store.summary({ stalledAttempts: DELETION_STALLED_ATTEMPTS }),
  });
});

export const layer = Layer.effect(AccountDeletions, make);

const persistence =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) => new AccountDeletionPersistenceError({ operation, cause })),
    );

const makeStore = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const transactions = yield* RelayDb.RelayTransactions;
  const t = relayAccountDeletions;

  const read = (userId: string) =>
    db
      .select({ status: t.status, requestedAt: t.requestedAt })
      .from(t)
      .where(eq(t.userId, userId))
      .pipe(persistence("read"));

  return AccountDeletionStore.of({
    request: Effect.fn("relay.account_deletion_store.request")(function* (input) {
      yield* db
        .insert(t)
        .values({
          userId: input.userId,
          requestId: input.requestId,
          source: input.source,
          status: "pending",
          attempts: 0,
          requestedAt: input.now,
          nextAttemptAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing()
        .pipe(persistence("request"));
      const [row] = yield* read(input.userId);
      if (!row) {
        return yield* new AccountDeletionPersistenceError({
          operation: "request",
          cause: new Error("Deletion record missing after insert"),
        });
      }
      return { status: row.status, requestedAt: row.requestedAt };
    }),
    reopen: (input) =>
      db
        .update(t)
        .set({
          status: "pending",
          nextAttemptAt: input.now,
          completedAt: null,
          updatedAt: input.now,
        })
        .where(and(eq(t.userId, input.userId), eq(t.status, "completed")))
        .pipe(persistence("reopen"), Effect.asVoid),
    isBlocked: (userId) =>
      db
        .select({ userId: t.userId })
        .from(t)
        .where(eq(t.userId, userId))
        .limit(1)
        .pipe(
          persistence("is-blocked"),
          Effect.map((rows) => rows.length > 0),
        ),
    claimDue: (input) => {
      const due = new QueryBuilder()
        .select({ userId: t.userId })
        .from(t)
        .where(
          and(
            eq(t.status, "pending"),
            lte(t.nextAttemptAt, input.now),
            lte(t.requestedAt, input.settledBefore),
          ),
        )
        .orderBy(t.nextAttemptAt)
        .limit(input.limit)
        .for("update", { skipLocked: true });
      return db
        .update(t)
        .set({
          attempts: sql`${t.attempts} + 1`,
          nextAttemptAt: input.leaseUntil,
          updatedAt: input.now,
        })
        .where(inArray(t.userId, due))
        .returning({ userId: t.userId, attempts: t.attempts })
        .pipe(persistence("claim"));
    },
    environmentIdsForUser: (userId) =>
      db
        .execute<{ environment_id: string }>(
          sql`SELECT ${relayEnvironmentLinks.environmentId} AS environment_id FROM ${relayEnvironmentLinks} WHERE ${relayEnvironmentLinks.userId} = ${userId}
              UNION
              SELECT ${relayManagedEndpointAllocations.environmentId} FROM ${relayManagedEndpointAllocations} WHERE ${relayManagedEndpointAllocations.userId} = ${userId}`,
          "objects",
        )
        .pipe(
          persistence("list-environments"),
          Effect.map((rows) => rows.map((row) => row.environment_id)),
        ),
    purgeUser: (input) =>
      transactions
        .withTransaction(
          Effect.gen(function* () {
            yield* db.delete(relayMobileDevices).where(eq(relayMobileDevices.userId, input.userId));
            yield* db
              .delete(relayLiveActivities)
              .where(eq(relayLiveActivities.userId, input.userId));
            yield* db
              .delete(relayDeliveryAttempts)
              .where(eq(relayDeliveryAttempts.userId, input.userId));
            yield* db
              .delete(relayManagedTunnelLimits)
              .where(eq(relayManagedTunnelLimits.userId, input.userId));
            yield* db
              .delete(relayManagedEndpointAllocations)
              .where(eq(relayManagedEndpointAllocations.userId, input.userId));
            yield* db
              .delete(relayEnvironmentLinks)
              .where(eq(relayEnvironmentLinks.userId, input.userId));
            yield* db
              .delete(relayIdentityChecks)
              .where(eq(relayIdentityChecks.userId, input.userId));
            for (const environmentId of input.environmentIds) {
              const [stillLinked] = yield* db
                .select({ userId: relayEnvironmentLinks.userId })
                .from(relayEnvironmentLinks)
                .where(eq(relayEnvironmentLinks.environmentId, environmentId))
                .limit(1);
              // Another account still uses this computer. Its credential and activity stay.
              if (stillLinked) continue;
              yield* db
                .update(relayEnvironmentCredentials)
                .set({ revokedAt: input.now, updatedAt: input.now })
                .where(
                  and(
                    eq(relayEnvironmentCredentials.environmentId, environmentId),
                    sql`${relayEnvironmentCredentials.revokedAt} IS NULL`,
                  ),
                );
              yield* db
                .delete(relayAgentActivityRows)
                .where(eq(relayAgentActivityRows.environmentId, environmentId));
            }
          }),
        )
        .pipe(persistence("purge")),
    markCompleted: (input) =>
      db
        .update(t)
        .set({
          status: "completed",
          completedAt: input.now,
          lastErrorCode: null,
          updatedAt: input.now,
        })
        .where(eq(t.userId, input.userId))
        .pipe(persistence("complete"), Effect.asVoid),
    recordFailure: (input) =>
      db
        .update(t)
        .set({
          lastErrorCode: input.code,
          nextAttemptAt: input.nextAttemptAt,
          updatedAt: input.now,
        })
        .where(and(eq(t.userId, input.userId), eq(t.status, "pending")))
        .pipe(persistence("record-failure"), Effect.asVoid),
    pruneCompleted: (input) =>
      db
        .delete(t)
        .where(and(eq(t.status, "completed"), lt(t.completedAt, input.completedBefore)))
        .pipe(persistence("prune"), Effect.asVoid),
    usersToCheck: (input) =>
      db
        .execute<{ user_id: string }>(
          sql`SELECT users.user_id FROM (
                SELECT ${relayEnvironmentLinks.userId} AS user_id FROM ${relayEnvironmentLinks}
                UNION SELECT ${relayMobileDevices.userId} FROM ${relayMobileDevices}
                UNION SELECT ${relayManagedEndpointAllocations.userId} FROM ${relayManagedEndpointAllocations}
              ) AS users
              LEFT JOIN ${relayIdentityChecks} ON ${relayIdentityChecks.userId} = users.user_id
              LEFT JOIN ${t} ON ${t.userId} = users.user_id AND ${t.status} = 'pending'
              WHERE ${t.userId} IS NULL
                AND (${relayIdentityChecks.checkedAt} IS NULL OR ${relayIdentityChecks.checkedAt} < ${input.checkedBefore})
              ORDER BY ${relayIdentityChecks.checkedAt} ASC NULLS FIRST
              LIMIT ${input.limit}`,
          "objects",
        )
        .pipe(
          persistence("users-to-check"),
          Effect.map((rows) => rows.map((row) => row.user_id)),
        ),
    markChecked: (input) =>
      db
        .insert(relayIdentityChecks)
        .values({ userId: input.userId, checkedAt: input.now })
        .onConflictDoUpdate({ target: relayIdentityChecks.userId, set: { checkedAt: input.now } })
        .pipe(persistence("mark-checked"), Effect.asVoid),
    summary: (input) =>
      db
        .execute<{ pending: string | number; stalled: string | number; oldest: string | null }>(
          sql`SELECT count(*) AS pending,
                count(*) FILTER (WHERE ${t.attempts} >= ${input.stalledAttempts}) AS stalled,
                min(${t.requestedAt}) AS oldest
              FROM ${t} WHERE ${t.status} = 'pending'`,
          "objects",
        )
        .pipe(
          persistence("summary"),
          Effect.map(([row]) => ({
            pending: Number(row?.pending ?? 0),
            stalled: Number(row?.stalled ?? 0),
            oldestPendingRequestedAt: row?.oldest ?? null,
          })),
        ),
  });
});

export const storeLayer = Layer.effect(AccountDeletionStore, makeStore);

const clerkStatus = (cause: unknown) => (isClerkAPIResponseError(cause) ? cause.status : undefined);

export const clerkIdentitiesLayer = Layer.effect(
  AccountIdentities,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const client = () =>
      createClerkClient({
        secretKey: Redacted.value(config.clerkSecretKey),
        publishableKey: config.clerkPublishableKey,
      });
    const call = <A>(operation: "check" | "delete", run: () => Promise<A>, onMissing: A) =>
      Effect.tryPromise({
        try: async () => {
          try {
            return await run();
          } catch (cause) {
            if (clerkStatus(cause) === 404) return onMissing;
            throw cause;
          }
        },
        catch: (cause) => {
          const status = clerkStatus(cause);
          return new AccountIdentityError({
            operation,
            ...(status === undefined ? {} : { status }),
            cause,
          });
        },
      });
    return AccountIdentities.of({
      exists: (userId) =>
        call("check", async () => Boolean(await client().users.getUser(userId)), false),
      remove: (userId) =>
        call("delete", async () => void (await client().users.deleteUser(userId)), undefined),
    });
  }),
);
