import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as AccountDeletions from "./AccountDeletions.ts";

interface Row {
  status: "pending" | "completed";
  source: AccountDeletions.DeletionSource;
  requestedAt: string;
  nextAttemptAt: string;
  attempts: number;
  lastErrorCode: string | null;
}

/** Mirrors the SQL store's rules closely enough to test the processing decisions. */
function makeWorld() {
  const deletions = new Map<string, Row>();
  const environments = new Map<string, Array<string>>();
  const purged: Array<string> = [];
  const checked = new Map<string, string>();
  const identities = new Set<string>();
  const unlinked: Array<string> = [];
  const failures = { teardown: 0, identity: 0, storeRead: false, identityCheck: false };

  const store = AccountDeletions.AccountDeletionStore.of({
    request: (input) =>
      Effect.sync(() => {
        if (!deletions.has(input.userId)) {
          deletions.set(input.userId, {
            status: "pending",
            source: input.source,
            requestedAt: input.now,
            nextAttemptAt: input.now,
            attempts: 0,
            lastErrorCode: null,
          });
        }
        const row = deletions.get(input.userId)!;
        return { status: row.status, requestedAt: row.requestedAt };
      }),
    reopen: (input) =>
      Effect.sync(() => {
        const row = deletions.get(input.userId);
        if (row?.status === "completed") {
          row.status = "pending";
          row.nextAttemptAt = input.now;
        }
      }),
    isBlocked: (userId) =>
      failures.storeRead
        ? Effect.fail(
            new AccountDeletions.AccountDeletionPersistenceError({
              operation: "is-blocked",
              cause: new Error("down"),
            }),
          )
        : Effect.succeed(deletions.has(userId)),
    claimDue: (input) =>
      Effect.sync(() => {
        const due = [...deletions.entries()].filter(
          ([, row]) =>
            row.status === "pending" &&
            row.nextAttemptAt <= input.now &&
            row.requestedAt <= input.settledBefore,
        );
        return due.slice(0, input.limit).map(([userId, row]) => {
          row.attempts++;
          row.nextAttemptAt = input.leaseUntil;
          return { userId, attempts: row.attempts };
        });
      }),
    environmentIdsForUser: (userId) => Effect.succeed(environments.get(userId) ?? []),
    purgeUser: (input) =>
      Effect.sync(() => {
        purged.push(input.userId);
        environments.delete(input.userId);
      }),
    markCompleted: (input) =>
      Effect.sync(() => {
        const row = deletions.get(input.userId)!;
        row.status = "completed";
        row.lastErrorCode = null;
      }),
    recordFailure: (input) =>
      Effect.sync(() => {
        const row = deletions.get(input.userId)!;
        row.lastErrorCode = input.code;
        row.nextAttemptAt = input.nextAttemptAt;
      }),
    pruneCompleted: () => Effect.void,
    usersToCheck: (input) =>
      Effect.sync(() =>
        [...environments.keys()]
          .filter((userId) => deletions.get(userId)?.status !== "pending")
          .filter((userId) => (checked.get(userId) ?? "") < input.checkedBefore)
          .slice(0, input.limit),
      ),
    markChecked: (input) => Effect.sync(() => void checked.set(input.userId, input.now)),
    summary: (input) =>
      Effect.sync(() => {
        const pending = [...deletions.values()].filter((row) => row.status === "pending");
        return {
          pending: pending.length,
          stalled: pending.filter((row) => row.attempts >= input.stalledAttempts).length,
          oldestPendingRequestedAt: pending.map((row) => row.requestedAt).sort()[0] ?? null,
        };
      }),
  });

  const identityLayer = Layer.succeed(
    AccountDeletions.AccountIdentities,
    AccountDeletions.AccountIdentities.of({
      exists: (userId) =>
        failures.identityCheck
          ? Effect.fail(
              new AccountDeletions.AccountIdentityError({
                operation: "check",
                status: 503,
                cause: new Error("unavailable"),
              }),
            )
          : Effect.succeed(identities.has(userId)),
      remove: (userId) => {
        if (failures.identity > 0) {
          failures.identity--;
          return Effect.fail(
            new AccountDeletions.AccountIdentityError({
              operation: "delete",
              status: 500,
              cause: new Error("clerk down"),
            }),
          );
        }
        // Removing an identity that is already gone succeeds, as with Clerk's 404.
        identities.delete(userId);
        return Effect.void;
      },
    }),
  );

  const teardownLayer = Layer.succeed(
    AccountDeletions.EnvironmentTeardown,
    AccountDeletions.EnvironmentTeardown.of({
      unlink: (input) => {
        if (failures.teardown > 0) {
          failures.teardown--;
          return Effect.fail(new AccountDeletions.AccountTeardownError({ cause: new Error("cf") }));
        }
        unlinked.push(`${input.userId}/${input.environmentId}`);
        return Effect.void;
      },
    }),
  );

  const layer = AccountDeletions.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AccountDeletions.AccountDeletionStore, store),
        identityLayer,
        teardownLayer,
      ),
    ),
  );

  return { deletions, environments, purged, checked, identities, unlinked, failures, layer };
}

const run = <A, E>(
  world: ReturnType<typeof makeWorld>,
  body: (deletions: AccountDeletions.AccountDeletions["Service"]) => Effect.Effect<A, E>,
) => AccountDeletions.AccountDeletions.pipe(Effect.flatMap(body), Effect.provide(world.layer));

describe("AccountDeletions", () => {
  it.effect("a repeated request returns the first record and blocks the user at once", () => {
    const world = makeWorld();
    return run(world, (deletions) =>
      Effect.gen(function* () {
        const first = yield* deletions.request({ userId: "user_a", requestId: "r1" });
        yield* TestClock.adjust("1 minute");
        const again = yield* deletions.request({ userId: "user_a", requestId: "r2" });
        expect(again).toEqual(first);
        expect(first.status).toBe("pending");
        expect(yield* deletions.isBlocked("user_a")).toBe(true);
        expect(yield* deletions.isBlocked("user_b")).toBe(false);
      }),
    );
  });

  it.effect("waits out in-flight requests before cleaning up, then removes everything once", () => {
    const world = makeWorld();
    world.environments.set("user_a", ["env_1", "env_2"]);
    world.identities.add("user_a");
    return run(world, (deletions) =>
      Effect.gen(function* () {
        yield* deletions.request({ userId: "user_a", requestId: "r1" });
        const early = yield* deletions.processDue;
        expect(early).toEqual({ completed: 0, failed: 0 });
        expect(world.unlinked).toEqual([]);

        yield* TestClock.adjust(`${AccountDeletions.DELETION_SETTLE_SECONDS + 1} seconds`);
        expect(yield* deletions.processDue).toEqual({ completed: 1, failed: 0 });
        expect(world.unlinked).toEqual(["user_a/env_1", "user_a/env_2"]);
        expect(world.purged).toEqual(["user_a"]);
        expect(world.identities.has("user_a")).toBe(false);
        expect(world.deletions.get("user_a")?.status).toBe("completed");

        yield* TestClock.adjust("1 hour");
        expect(yield* deletions.processDue).toEqual({ completed: 0, failed: 0 });
        expect(world.purged).toEqual(["user_a"]);
        // The tombstone keeps refusing the user's remaining tokens.
        expect(yield* deletions.isBlocked("user_a")).toBe(true);
      }),
    );
  });

  it.effect("retries a failed step with growing delays and keeps the account blocked", () => {
    const world = makeWorld();
    world.environments.set("user_a", ["env_1"]);
    world.identities.add("user_a");
    world.failures.teardown = 1;
    world.failures.identity = 1;
    return run(world, (deletions) =>
      Effect.gen(function* () {
        yield* deletions.request({ userId: "user_a", requestId: "r1" });
        yield* TestClock.adjust("1 minute");

        expect(yield* deletions.processDue).toEqual({ completed: 0, failed: 1 });
        expect(world.deletions.get("user_a")?.lastErrorCode).toBe("environment_teardown");
        expect(world.purged).toEqual([]);

        yield* TestClock.adjust("4 minutes");
        expect(yield* deletions.processDue).toEqual({ completed: 0, failed: 0 });
        yield* TestClock.adjust("2 minutes");
        expect(yield* deletions.processDue).toEqual({ completed: 0, failed: 1 });
        expect(world.deletions.get("user_a")?.lastErrorCode).toBe("identity_500");
        // Relay rows are already gone. Only the sign-in identity remains to delete.
        expect(world.purged).toEqual(["user_a"]);
        expect(yield* deletions.isBlocked("user_a")).toBe(true);

        yield* TestClock.adjust("9 minutes");
        expect(yield* deletions.processDue).toEqual({ completed: 0, failed: 0 });
        yield* TestClock.adjust("2 minutes");
        expect(yield* deletions.processDue).toEqual({ completed: 1, failed: 0 });
        expect(world.identities.has("user_a")).toBe(false);
      }),
    );
  });

  it.effect("finds identities deleted outside the relay and queues their cleanup", () => {
    const world = makeWorld();
    world.environments.set("kept", ["env_1"]);
    world.environments.set("gone", ["env_2"]);
    world.identities.add("kept");
    return run(world, (deletions) =>
      Effect.gen(function* () {
        expect(yield* deletions.reconcileIdentities).toEqual({ checked: 2, missing: 1 });
        expect(world.deletions.get("gone")?.source).toBe("identity_missing");
        expect(world.deletions.has("kept")).toBe(false);
        expect(yield* deletions.isBlocked("gone")).toBe(true);

        // A checked user isn't asked about again until the interval passes.
        expect(yield* deletions.reconcileIdentities).toEqual({ checked: 0, missing: 0 });

        yield* TestClock.adjust("1 minute");
        expect(yield* deletions.processDue).toEqual({ completed: 1, failed: 0 });
        expect(world.unlinked).toEqual(["gone/env_2"]);
      }),
    );
  });

  it.effect("an unreachable identity provider never marks anyone missing", () => {
    const world = makeWorld();
    world.environments.set("user_a", ["env_1"]);
    world.failures.identityCheck = true;
    return run(world, (deletions) =>
      Effect.gen(function* () {
        expect(yield* deletions.reconcileIdentities).toEqual({ checked: 1, missing: 0 });
        expect(world.deletions.size).toBe(0);
        expect(world.checked.size).toBe(0);
      }),
    );
  });

  it.effect("rows written after a completed deletion reopen it", () => {
    const world = makeWorld();
    return run(world, (deletions) =>
      Effect.gen(function* () {
        yield* deletions.request({ userId: "user_a", requestId: "r1" });
        yield* TestClock.adjust("1 minute");
        yield* deletions.processDue;
        expect(world.deletions.get("user_a")?.status).toBe("completed");

        world.environments.set("user_a", ["env_late"]);
        yield* TestClock.adjust("25 hours");
        expect(yield* deletions.reconcileIdentities).toEqual({ checked: 1, missing: 1 });
        expect(world.deletions.get("user_a")?.status).toBe("pending");
        yield* TestClock.adjust("1 minute");
        expect(yield* deletions.processDue).toEqual({ completed: 1, failed: 0 });
        expect(world.unlinked).toEqual(["user_a/env_late"]);
      }),
    );
  });

  it.effect("the sign-in check fails open when storage is down", () => {
    const world = makeWorld();
    world.failures.storeRead = true;
    return run(world, (deletions) =>
      Effect.gen(function* () {
        expect(yield* deletions.isBlocked("user_a")).toBe(false);
      }),
    );
  });

  it.effect("reports stalled deletions by attempt count only", () => {
    const world = makeWorld();
    world.environments.set("user_a", ["env_1"]);
    world.failures.teardown = 100;
    return run(world, (deletions) =>
      Effect.gen(function* () {
        yield* deletions.request({ userId: "user_a", requestId: "r1" });
        for (let attempt = 1; attempt <= AccountDeletions.DELETION_STALLED_ATTEMPTS; attempt++) {
          yield* TestClock.adjust(`${AccountDeletions.retryDelayMinutes(attempt) + 1} minutes`);
          yield* deletions.processDue;
        }
        const summary = yield* deletions.summary;
        expect(summary.pending).toBe(1);
        expect(summary.stalled).toBe(1);
      }),
    );
  });

  it("backs off from five minutes to a six-hour ceiling", () => {
    expect([1, 2, 3, 4, 7, 20].map(AccountDeletions.retryDelayMinutes)).toEqual([
      5, 10, 20, 40, 320, 360,
    ]);
  });
});
