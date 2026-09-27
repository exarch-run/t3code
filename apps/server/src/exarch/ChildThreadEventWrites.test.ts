import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import { CheckpointServiceV2 } from "../orchestration-v2/CheckpointService.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { layer as idAllocatorLayer } from "../orchestration-v2/IdAllocator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
} from "../orchestration-v2/ProviderAdapter.ts";
import {
  ProviderEventIngestorV2,
  ProviderEventPublishError,
  type ProviderEventIngestorV2Shape,
} from "../orchestration-v2/ProviderEventIngestor.ts";
import {
  layer as runExecutionServiceLayer,
  RunExecutionServiceV2,
} from "../orchestration-v2/RunExecutionService.ts";
import { makeChildThreadEventWrites } from "./ChildThreadEventWrites.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const providerInstanceId = ProviderInstanceId.make("claudeAgent");
const providerSessionId = ProviderSessionId.make("session:child-writes");
const parentThreadId = ThreadId.make("thread:child-writes");
const childThreadId = ThreadId.make("thread:child-writes:child");
const providerThreadId = ProviderThreadId.make("provider-thread:child-writes");
const childProviderThreadId = ProviderThreadId.make("provider-thread:child-writes:child");
const childProviderTurnId = ProviderTurnId.make("provider-turn:child-writes:child");
const childNodeId = NodeId.make("node:child-writes:child");
const childItemId = TurnItemId.make("turn-item:child-writes:child");

const runId = (ordinal: number) => RunId.make(`run:child-writes:${ordinal}`);
const attemptId = (ordinal: number) => RunAttemptId.make(`attempt:child-writes:${ordinal}`);
const rootTurnId = (ordinal: number) =>
  ProviderTurnId.make(`provider-turn:child-writes:${ordinal}`);

type IngestInput = Parameters<ProviderEventIngestorV2Shape["ingestNormalized"]>[0];

interface Write {
  readonly runId: RunId | undefined;
  readonly event: ProviderAdapterV2Event;
  readonly gated: boolean;
}

interface Subscriber {
  readonly queue: Queue.Queue<ProviderAdapterV2Event, Cause.Done>;
  readonly closed: Deferred.Deferred<void>;
}

/**
 * A provider session that hands each subscriber the same event objects, as
 * the session manager does, with delivery controlled per subscriber so a test
 * can make one run lag behind another.
 */
function makeHarness(options?: {
  readonly duringWrite?: (input: IngestInput) => Effect.Effect<void, ProviderEventPublishError>;
}) {
  return Effect.gen(function* () {
    const attempts = yield* Ref.make<ReadonlyArray<Write>>([]);
    const writes = yield* Ref.make<ReadonlyArray<Write>>([]);
    const finalized = yield* Queue.unbounded<RunId>();
    const subscribers: Array<Subscriber> = [];
    const record = (ref: Ref.Ref<ReadonlyArray<Write>>, input: IngestInput) =>
      Ref.update(ref, (current) => [
        ...current,
        {
          runId: input.runId,
          event: input.event,
          gated:
            input.writeIfRunCurrent !== undefined || input.writeIfProviderThreadOwner !== undefined,
        },
      ]);
    const layer = runExecutionServiceLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Effect.forEach(
                input.events.flatMap((event) =>
                  event.type === "run.updated" && event.runId !== undefined ? [event.runId] : [],
                ),
                (id) => Queue.offer(finalized, id),
              ).pipe(Effect.as([])),
            writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
          }),
          idAllocatorLayer,
          Layer.mock(ProviderEventIngestorV2)({
            ingestNormalized: (input) =>
              Effect.gen(function* () {
                yield* record(attempts, input);
                yield* options?.duringWrite?.(input) ?? Effect.void;
                yield* record(writes, input);
                return [];
              }),
          }),
          ServerSettingsService.layerTest(),
        ),
      ),
    );
    const session = {
      driver,
      events: Stream.empty,
      subscribeEvents: Effect.gen(function* () {
        const subscriber: Subscriber = {
          queue: yield* Queue.unbounded<ProviderAdapterV2Event, Cause.Done>(),
          closed: yield* Deferred.make<void>(),
        };
        subscribers.push(subscriber);
        return {
          events: Stream.fromQueue(subscriber.queue),
          close: Deferred.succeed(subscriber.closed, undefined).pipe(Effect.asVoid),
        };
      }),
      startTurn: () => Effect.void,
    } as unknown as ProviderAdapterV2SessionRuntime;

    /** Start live runs of the parent chat. Each has taken over the subagent's child thread. */
    const startRuns = (count: number) =>
      Effect.gen(function* () {
        const runExecution = yield* RunExecutionServiceV2;
        for (let ordinal = 1; ordinal <= count; ordinal += 1) {
          yield* runExecution.startRootRun({
            commandId: CommandId.make(`command:child-writes:${ordinal}`),
            appThread: { id: parentThreadId } as OrchestrationV2AppThread,
            providerSessionId,
            session,
            run: {
              id: runId(ordinal),
              threadId: parentThreadId,
              ordinal,
              providerInstanceId,
            } as OrchestrationV2Run,
            rootNode: {
              id: NodeId.make(`node:child-writes:${ordinal}`),
            } as OrchestrationV2ExecutionNode,
            checkpointScope: {
              id: CheckpointScopeId.make("checkpoint-scope:child-writes"),
            } as OrchestrationV2CheckpointScope,
            providerThread: { id: providerThreadId, driver } as OrchestrationV2ProviderThread,
            attempt: {
              id: attemptId(ordinal),
              providerTurnId: rootTurnId(ordinal),
            } as OrchestrationV2RunAttempt,
            attemptId: attemptId(ordinal),
            providerTurnOrdinal: ordinal,
            relatedThreadIds: [childThreadId],
            relatedProviderThreadIds: [childProviderThreadId],
            message: {
              messageId: MessageId.make(`message:child-writes:${ordinal}`),
              text: "Keep going while the subagent works.",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            },
            modelSelection: { instanceId: providerInstanceId, model: "claude-opus-5-5" },
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: process.cwd(),
              approvalPolicy: "never",
              sandboxPolicy: {
                type: "readOnly",
                access: { type: "fullAccess" },
                networkAccess: false,
              },
            },
          });
        }
      }).pipe(Effect.provide(layer));

    const publish = (to: ReadonlyArray<number>, ...events: ReadonlyArray<ProviderAdapterV2Event>) =>
      Effect.forEach(to, (index) => Queue.offerAll(subscribers[index]!.queue, events), {
        discard: true,
      });
    const endAndAwait = Effect.forEach(
      subscribers,
      (subscriber) =>
        Queue.end(subscriber.queue).pipe(Effect.andThen(Deferred.await(subscriber.closed))),
      { discard: true },
    );
    return { attempts, writes, finalized, subscribers, startRuns, publish, endAndAwait };
  });
}

const childThreadCreated = (): ProviderAdapterV2Event =>
  ({
    type: "app_thread.created",
    driver,
    appThread: {
      id: childThreadId,
      lineage: {
        parentThreadId,
        relationshipToParent: "subagent",
        rootThreadId: parentThreadId,
      },
    },
  }) as ProviderAdapterV2Event;

const childProviderThread = (): ProviderAdapterV2Event =>
  ({
    type: "provider_thread.updated",
    driver,
    providerThread: { id: childProviderThreadId, appThreadId: childThreadId },
  }) as ProviderAdapterV2Event;

const rootProviderThread = (): ProviderAdapterV2Event =>
  ({
    type: "provider_thread.updated",
    driver,
    providerThread: { id: providerThreadId, appThreadId: parentThreadId },
  }) as ProviderAdapterV2Event;

const childTurn = (status: "running" | "completed"): ProviderAdapterV2Event =>
  ({
    type: "provider_turn.updated",
    driver,
    threadId: childThreadId,
    providerTurn: {
      id: childProviderTurnId,
      providerThreadId: childProviderThreadId,
      nodeId: childNodeId,
      runAttemptId: null,
      status,
    },
  }) as ProviderAdapterV2Event;

const childTool = (status: "running" | "completed", ordinal: number): ProviderAdapterV2Event =>
  ({
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: childItemId,
      threadId: childThreadId,
      runId: null,
      providerTurnId: childProviderTurnId,
      ordinal,
      type: "command_execution",
      status,
    },
  }) as ProviderAdapterV2Event;

const rootTerminal = (ordinal: number): ProviderAdapterV2Event => ({
  type: "turn.terminal",
  driver,
  providerThreadId,
  providerTurnId: rootTurnId(ordinal),
  runOrdinal: ordinal,
  status: "completed",
  failure: null,
  threadDisposition: "reusable",
});

const writesOf = (writes: ReadonlyArray<Write>, event: ProviderAdapterV2Event) =>
  writes.filter((write) => write.event === event);

const toolWrites = (writes: ReadonlyArray<Write>) =>
  writes.flatMap((write) =>
    write.event.type === "turn_item.updated" && write.event.turnItem.id === childItemId
      ? [`${write.runId}:${write.event.turnItem.status}`]
      : [],
  );

it.effect("writes each child-thread event once while every live run routes and tracks it", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* harness.startRuns(3);
    const all = [0, 1, 2];
    const started = [
      childThreadCreated(),
      childProviderThread(),
      childTurn("running"),
      childTool("running", 1),
    ];
    const rootSnapshot = rootProviderThread();
    yield* harness.publish(
      all,
      ...started,
      rootSnapshot,
      rootTerminal(1),
      rootTerminal(2),
      rootTerminal(3),
    );

    const finalized = yield* Effect.forEach(all, () => Queue.take(harness.finalized));
    assert.sameMembers(finalized, [runId(1), runId(2), runId(3)]);
    // Every run settled its own turn and still holds its stream open for the
    // running subagent, including the runs that skipped the shared writes.
    for (const subscriber of harness.subscribers) {
      assert.isFalse(yield* Deferred.isDone(subscriber.closed));
    }

    const settled = [childTool("completed", 2), childTurn("completed")];
    yield* harness.publish(all, ...settled);
    // Each run releases its stream by itself once the subagent's work settles.
    yield* Effect.forEach(harness.subscribers, (subscriber) => Deferred.await(subscriber.closed), {
      discard: true,
    });

    const writes = yield* Ref.get(harness.writes);
    for (const event of [...started, ...settled]) {
      assert.lengthOf(writesOf(writes, event), 1, `${event.type} was not written exactly once`);
    }
    // The run's own provider-thread snapshot stays gated per run.
    const rootWrites = writesOf(writes, rootSnapshot);
    assert.sameMembers(
      rootWrites.map((write) => write.runId),
      [runId(1), runId(2), runId(3)],
    );
    assert.isTrue(rootWrites.every((write) => write.gated));
  }),
);

it.effect("a lagging run does not land a stale copy after the completed one", () =>
  Effect.gen(function* () {
    const running = childTool("running", 1);
    const completed = childTool("completed", 2);
    const completedWritten = yield* Deferred.make<void>();
    const harness = yield* makeHarness({
      duringWrite: (input) =>
        input.event === completed
          ? Deferred.succeed(completedWritten, undefined).pipe(Effect.asVoid)
          : Effect.void,
    });
    yield* harness.startRuns(2);

    yield* harness.publish([0], running, completed);
    yield* Deferred.await(completedWritten);
    yield* harness.publish([1], running, completed);
    yield* harness.endAndAwait;

    assert.deepEqual(toolWrites(yield* Ref.get(harness.writes)), [
      `${runId(1)}:running`,
      `${runId(1)}:completed`,
    ]);
  }),
);

it.effect("a run that reaches an event mid-write waits for it before writing later events", () =>
  Effect.gen(function* () {
    const running = childTool("running", 1);
    const completed = childTool("completed", 2);
    const release = yield* Deferred.make<void>();
    const log: Array<string> = [];
    const label = (input: IngestInput) =>
      input.event.type === "turn_item.updated"
        ? `${input.runId}:${input.event.turnItem.status}`
        : input.event.type;
    const writes = makeChildThreadEventWrites({
      normalize: () => Effect.succeed([]),
      ingestNormalized: (input) =>
        Effect.gen(function* () {
          log.push(`start ${label(input)}`);
          if (input.event === running) yield* Deferred.await(release);
          log.push(`done ${label(input)}`);
          return [];
        }),
    });
    const run = { threadId: parentThreadId, providerThreadId };
    const write = (id: RunId, event: ProviderAdapterV2Event) =>
      writes.ingestorFor(event, run, true).pipe(
        Effect.flatMap((ingestor) =>
          ingestor.ingestNormalized({
            providerSessionId,
            providerInstanceId,
            threadId: parentThreadId,
            runId: id,
            event,
          }),
        ),
      );

    // Each run's work starts at once and runs until it has to wait.
    const first = yield* write(runId(1), running).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    const second = yield* Effect.forEach([running, completed], (event) =>
      write(runId(2), event),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    assert.deepEqual(log, [`start ${runId(1)}:running`]);

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.deepEqual(log, [
      `start ${runId(1)}:running`,
      `done ${runId(1)}:running`,
      `start ${runId(2)}:completed`,
      `done ${runId(2)}:completed`,
    ]);
  }),
);

it.effect("a failed write releases its claim so another live run writes the event", () =>
  Effect.gen(function* () {
    const running = childTool("running", 1);
    const completed = childTool("completed", 2);
    const harness = yield* makeHarness({
      duringWrite: (input) =>
        input.event === running && input.runId === runId(1)
          ? Effect.fail(
              new ProviderEventPublishError({
                providerSessionId,
                eventCount: 1,
                cause: "disk full",
              }),
            )
          : Effect.void,
    });
    yield* harness.startRuns(2);

    yield* harness.publish([0], running);
    // The failed write ends the first run's ingestion.
    yield* Deferred.await(harness.subscribers[0]!.closed);
    yield* harness.publish([1], running, completed);
    yield* harness.endAndAwait;

    assert.deepEqual(
      writesOf(yield* Ref.get(harness.attempts), running).map((write) => write.runId),
      [runId(1), runId(2)],
    );
    assert.deepEqual(toolWrites(yield* Ref.get(harness.writes)), [
      `${runId(2)}:running`,
      `${runId(2)}:completed`,
    ]);
  }),
);
