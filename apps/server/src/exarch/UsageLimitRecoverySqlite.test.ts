// @effect-diagnostics nodeBuiltinImport:off
import { StatementSync } from "node:sqlite";

import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ProjectionStoreV2,
  layer as projectionStoreLayer,
} from "../orchestration-v2/ProjectionStore.ts";

// The Node that Exarch bundles (24.20) refuses to bind JS booleans; 24.21 and
// later store them as 1/0, so upstream's tests pass where Exarch's engine fails.
// For the length of a test this guard makes node:sqlite refuse booleans the way
// 24.20 does, on any Node.
const refuseBooleanBinds = Effect.acquireRelease(
  Effect.sync(() => {
    const methods = ["all", "get", "run", "iterate"] as const;
    const originals = methods.map((method) => [method, StatementSync.prototype[method]] as const);
    for (const [method, original] of originals) {
      const guarded = function (this: StatementSync, ...params: Array<unknown>) {
        const index = params.findIndex((param) => typeof param === "boolean");
        if (index !== -1) {
          throw new TypeError(`Provided value cannot be bound to SQLite parameter ${index + 1}.`);
        }
        return (original as (...args: Array<unknown>) => unknown).apply(this, params);
      };
      Object.assign(StatementSync.prototype, { [method]: guarded });
    }
    return originals;
  }),
  (originals) =>
    Effect.sync(() => {
      for (const [method, original] of originals) {
        Object.assign(StatementSync.prototype, { [method]: original });
      }
    }),
);

const TestLayer = projectionStoreLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const driver = ProviderDriverKind.make("codex");
const now = DateTime.makeUnsafe("2026-09-26T12:00:00.000Z");

/** A chat whose only run failed on a usage limit that resets at `resetAt`. */
const addLimitedChat = Effect.fn("addLimitedChat")(function* (input: {
  readonly name: string;
  readonly failedAt: DateTime.Utc;
  readonly resetAt: DateTime.Utc;
  readonly armed: boolean;
}) {
  const store = yield* ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:${input.name}`);
  const runId = RunId.make(`run:${input.name}`);
  const rootNodeId = NodeId.make(`node:${input.name}`);
  const resetAt = DateTime.formatIso(input.resetAt);
  const at = input.failedAt;
  const run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${input.name}`),
    rootNodeId,
    activeAttemptId: null,
    status: "running" as const,
    requestedAt: at,
    startedAt: at,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  yield* store.apply({
    id: EventId.make(`event:${input.name}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: at,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:limits"),
      title: input.name,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
      limitRecovery: input.armed ? { runId, resetAt, autoResume: true } : null,
    },
  });
  yield* store.apply({
    id: EventId.make(`event:${input.name}:run-created`),
    type: "run.created",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: at,
    payload: run,
  });
  yield* store.apply({
    id: EventId.make(`event:${input.name}:limit`),
    type: "turn-item.updated",
    threadId,
    occurredAt: at,
    payload: {
      id: TurnItemId.make(`item:${input.name}:limit`),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "failed",
      title: "Usage limit reached",
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "error",
      failure: {
        class: "usage_limit",
        message: "Plan limit reached.",
        resetAt,
        code: "usageLimitExceeded",
        retryable: null,
      },
    },
  });
  yield* store.apply({
    id: EventId.make(`event:${input.name}:run-failed`),
    type: "run.updated",
    threadId,
    occurredAt: at,
    payload: { ...run, status: "failed", completedAt: at },
  });
  return threadId;
});

it.effect("finds usage-limit recovery candidates when SQLite refuses boolean binds", () =>
  Effect.gen(function* () {
    yield* refuseBooleanBinds;
    const store = yield* ProjectionStoreV2;
    const recent = yield* addLimitedChat({
      name: "recent",
      failedAt: DateTime.subtract(now, { hours: 1 }),
      resetAt: DateTime.add(now, { hours: 4 }),
      armed: false,
    });
    const old = yield* addLimitedChat({
      name: "old",
      failedAt: DateTime.makeUnsafe("2026-08-25T12:00:00.000Z"),
      resetAt: DateTime.makeUnsafe("2026-09-01T00:00:00.000Z"),
      armed: false,
    });
    const armed = yield* addLimitedChat({
      name: "armed",
      failedAt: DateTime.subtract(now, { hours: 6 }),
      resetAt: DateTime.subtract(now, { hours: 1 }),
      armed: true,
    });

    const picked = (autoResume: boolean, snooze: boolean) =>
      store
        .getLimitRecoveryCandidates({ now, autoResume, snooze })
        .pipe(Effect.map((rows) => rows.map((row) => row.id).toSorted()));

    // An armed chat that is due resumes whatever the switches say. Auto-resume
    // arms every limited chat; snooze arms only resets still ahead.
    assert.deepEqual(yield* picked(false, false), [armed]);
    assert.deepEqual(yield* picked(true, false), [armed, old, recent].toSorted());
    assert.deepEqual(yield* picked(false, true), [armed, recent].toSorted());
    assert.deepEqual(yield* picked(true, true), [armed, old, recent].toSorted());
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
