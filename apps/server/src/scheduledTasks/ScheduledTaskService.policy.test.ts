import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { ThreadLaunchResult } from "../orchestration-v2/ThreadLaunchService.ts";
import type { ThreadManagementSendResult } from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ScheduledTaskService,
  layer as scheduledTaskServiceLayer,
} from "./ScheduledTaskService.ts";

const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

/** Only activeRunId is read by the overlap check; the rest of the shell is not consulted. */
const shellWithActiveRun = (activeRunId: string | null) =>
  ({ activeRunId }) as unknown as OrchestrationV2ThreadShell;

const baseInput: ScheduledTaskUpsertInput = {
  title: "Policy task",
  prompt: "Do the recurring work",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: ProjectId.make("project:policy"),
  threadId: ThreadId.make("thread:bound"),
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

type Row = {
  readonly next_run_at: string | null;
  readonly last_run_status: string;
  readonly run_count: number;
  readonly last_outcome_kind: string | null;
  readonly last_outcome_message: string | null;
  readonly last_run_thread_id: string | null;
};

const readRow = (sql: SqlClient.SqlClient, id: string) =>
  sql<Row>`
    SELECT next_run_at, last_run_status, run_count, last_outcome_kind, last_outcome_message, last_run_thread_id
    FROM scheduled_tasks WHERE task_id = ${id}
  `.pipe(Effect.map((rows) => rows[0]!));

/** Receipt that the poll recorded an outcome: the list stream re-emits after every change. */
const awaitOutcome = (service: ScheduledTaskService["Service"], id: string, kind: string) =>
  service.subscribeList().pipe(
    Stream.takeUntil((list) =>
      list.tasks.some((task) => task.id === id && task.lastOutcome?.kind === kind),
    ),
    Stream.runDrain,
  );

it.effect("skips and records a due run while the bound chat is still working", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = Date.parse("2026-09-09T12:00:00.000Z");
    yield* TestClock.setTime(now);
    const chatBusy = yield* Ref.make(true);
    const sends = yield* Ref.make(0);
    const deps = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Ref.get(chatBusy).pipe(Effect.map((busy) => shellWithActiveRun(busy ? "run-1" : null))),
        sendToThread: () =>
          Ref.update(sends, (n) => n + 1).pipe(
            Effect.as({ delivery: "started" } as ThreadManagementSendResult),
          ),
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService;
        const { task } = yield* service.upsert(baseInput);
        // Make the task due before the first poll tick.
        yield* sql`UPDATE scheduled_tasks SET next_run_at = ${isoAt(now)} WHERE task_id = ${task.id}`;
        const receipt = yield* Effect.forkChild(awaitOutcome(service, task.id, "skipped_overlap"));
        yield* TestClock.adjust("6 seconds");
        yield* Fiber.join(receipt);

        const skipped = yield* readRow(sql, task.id);
        assert.equal(skipped.last_outcome_kind, "skipped_overlap");
        assert.include(skipped.last_outcome_message, "thread:bound");
        // A skip is not a run: nothing was sent, queued, or counted, and the
        // task is aimed at its next occurrence instead of firing on the next tick.
        assert.equal(yield* Ref.get(sends), 0);
        assert.equal(skipped.run_count, 0);
        assert.equal(skipped.last_run_status, "never");
        assert.equal(skipped.next_run_at, isoAt(now + 5_000 + 60_000));
        const listed = (yield* service.list()).tasks[0]!;
        assert.equal(listed.lastOutcome?.kind, "skipped_overlap");
        assert.equal(listed.lastOutcome?.at, isoAt(now + 5_000));

        // A manual run is refused rather than steered into the busy turn.
        const refused = yield* service.runNow({ id: task.id }).pipe(Effect.flip);
        assert.include(refused.message, "still active in chat thread:bound");
        assert.equal(yield* Ref.get(sends), 0);

        // Once the chat is idle the same task runs and records where it landed.
        yield* Ref.set(chatBusy, false);
        const ran = yield* service.runNow({ id: task.id });
        assert.equal(yield* Ref.get(sends), 1);
        assert.equal(ran.task.lastOutcome?.kind, "ran");
        assert.equal(ran.task.lastRunStatus, "succeeded");
        const after = yield* readRow(sql, task.id);
        assert.equal(after.last_run_thread_id, "thread:bound");
        assert.equal(after.run_count, 1);
      }).pipe(Effect.provide(scheduledTaskServiceLayer.pipe(Layer.provide(deps)))),
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("watches the chat its last run launched for a fresh-chat task", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = Date.parse("2026-09-09T12:00:00.000Z");
    yield* TestClock.setTime(now);
    const launches = yield* Ref.make(0);
    const shellReads = yield* Ref.make<string[]>([]);
    const deps = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: () =>
          Ref.update(launches, (n) => n + 1).pipe(
            Effect.as({ threadId: ThreadId.make("thread:launched") } as ThreadLaunchResult),
          ),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Ref.update(shellReads, (reads) => [...reads, threadId]).pipe(
            Effect.as(shellWithActiveRun("run-still-going")),
          ),
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService;
        const { task } = yield* service.upsert({ ...baseInput, threadId: null });
        // First run: no previous chat, so nothing to check and the launch goes out.
        const first = yield* service.runNow({ id: task.id });
        assert.equal(first.task.lastOutcome?.kind, "ran");
        assert.equal(yield* Ref.get(launches), 1);
        assert.deepEqual(yield* Ref.get(shellReads), []);
        assert.equal((yield* readRow(sql, task.id)).last_run_thread_id, "thread:launched");

        // Second run: the launched chat is still busy, so it is skipped.
        const refused = yield* service.runNow({ id: task.id }).pipe(Effect.flip);
        assert.include(refused.message, "thread:launched");
        assert.deepEqual(yield* Ref.get(shellReads), ["thread:launched"]);
        assert.equal(yield* Ref.get(launches), 1);
      }).pipe(Effect.provide(scheduledTaskServiceLayer.pipe(Layer.provide(deps)))),
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("records a fixed-time run missed while the engine was off instead of replaying it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const dueAt = "2026-09-09T09:00:00.000Z";
    const now = Date.parse("2026-09-09T12:00:00.000Z");
    yield* TestClock.setTime(now);
    const sends = yield* Ref.make(0);
    const deps = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(shellWithActiveRun(null)),
        sendToThread: () =>
          Ref.update(sends, (n) => n + 1).pipe(
            Effect.as({ delivery: "started" } as ThreadManagementSendResult),
          ),
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService;
        const { task } = yield* service.upsert({
          ...baseInput,
          schedule: { type: "fixed_time", timeOfDay: "09:00", timeZone: "UTC" },
        });
        // The engine was off across the 09:00 slot: the row still points at it.
        yield* sql`UPDATE scheduled_tasks SET next_run_at = ${dueAt} WHERE task_id = ${task.id}`;
        const receipt = yield* Effect.forkChild(awaitOutcome(service, task.id, "skipped_missed"));
        yield* TestClock.adjust("6 seconds");
        yield* Fiber.join(receipt);

        const row = yield* readRow(sql, task.id);
        assert.equal(row.last_outcome_kind, "skipped_missed");
        assert.include(row.last_outcome_message, dueAt);
        assert.equal(row.next_run_at, "2026-09-10T09:00:00.000Z");
        assert.equal(row.run_count, 0);
        assert.equal(row.last_run_status, "never");
        assert.equal(yield* Ref.get(sends), 0);
      }).pipe(Effect.provide(scheduledTaskServiceLayer.pipe(Layer.provide(deps)))),
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("pausing future runs leaves the run already in flight alone", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* TestClock.setTime(Date.parse("2026-09-09T12:00:00.000Z"));
    const dispatched = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const deps = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(shellWithActiveRun(null)),
        // interruptThread is deliberately unmocked: calling it would defect
        // and the run would record as failed instead of succeeded.
        sendToThread: () =>
          Deferred.succeed(dispatched, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ delivery: "started" } as ThreadManagementSendResult),
          ),
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService;
        const { task } = yield* service.upsert(baseInput);
        const run = yield* Effect.forkChild(service.runNow({ id: task.id }));
        yield* Deferred.await(dispatched);
        assert.equal((yield* readRow(sql, task.id)).last_run_status, "running");

        const paused = yield* service.setEnabled({ id: task.id, enabled: false });
        assert.isFalse(paused.task.enabled);
        assert.isNull(paused.task.nextRunAt);

        yield* Deferred.succeed(release, undefined);
        const finished = yield* Fiber.join(run);
        // The in-flight run completed normally and, because the task is now
        // paused, did not aim a next run.
        assert.equal(finished.task.lastRunStatus, "succeeded");
        assert.equal(finished.task.runCount, 1);
        assert.isNull(finished.task.nextRunAt);
        const row = yield* readRow(sql, task.id);
        assert.equal(row.last_outcome_kind, "ran");
        assert.isNull(row.next_run_at);
      }).pipe(Effect.provide(scheduledTaskServiceLayer.pipe(Layer.provide(deps)))),
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("changing the cadence updates the task in place", () =>
  Effect.gen(function* () {
    const now = Date.parse("2026-09-09T12:00:00.000Z");
    yield* TestClock.setTime(now);
    const deps = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService;
        const { task } = yield* service.upsert(baseInput);
        assert.equal(task.nextRunAt, isoAt(now + 60_000));
        const updated = yield* service.upsert({
          ...baseInput,
          id: ScheduledTaskId.make(task.id),
          schedule: { type: "interval", everyMs: 3_600_000 },
        });
        assert.equal(updated.task.id, task.id);
        assert.equal(updated.task.nextRunAt, isoAt(now + 3_600_000));
        const { tasks } = yield* service.list();
        assert.equal(tasks.length, 1);
        assert.deepEqual(tasks[0]?.schedule, { type: "interval", everyMs: 3_600_000 });
      }).pipe(Effect.provide(scheduledTaskServiceLayer.pipe(Layer.provide(deps)))),
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
