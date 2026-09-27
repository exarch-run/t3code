import type { ProviderSessionId, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { ProviderAdapterV2Event } from "../orchestration-v2/ProviderAdapter.ts";
import type { ProviderEventIngestorV2Shape } from "../orchestration-v2/ProviderEventIngestor.ts";

type IngestInput = Parameters<ProviderEventIngestorV2Shape["ingestNormalized"]>[0];
type ChildThreadEventRun = {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
};
type ChildEntity = {
  /** Emission sequence of the newest event written for this entity. */
  lastWritten: number;
  /** Settles when the write in flight for this entity finishes. */
  writing: Deferred.Deferred<void> | undefined;
};
type SessionWrites = {
  /** Live runs subscribed to the session, the only ones that can deliver its older events. */
  live: number;
  /** Events already written in this session. */
  readonly written: WeakSet<ProviderAdapterV2Event>;
  readonly entities: Map<string, ChildEntity>;
};

let lastSequence = 0;
const sequenceByEvent = new WeakMap<ProviderAdapterV2Event, number>();

/**
 * Stamp an adapter event with its place in emission order. The provider
 * session manager calls this once per event, just before handing it to every
 * subscribed run, so a run that subscribes late or lags behind can still tell
 * which of two updates is newer.
 */
export function stampProviderEventSequence(event: ProviderAdapterV2Event): void {
  lastSequence += 1;
  sequenceByEvent.set(event, lastSequence);
}

export function providerEventSequence(event: ProviderAdapterV2Event): number | undefined {
  return sequenceByEvent.get(event);
}

/**
 * Every live run of a chat subscribes to the provider session and routes its
 * subagents' child-thread events, and a run stays live while a background
 * subagent works. Left alone, each child-thread event is written once per live
 * run, and a lagging run lands a stale copy after a newer one.
 *
 * Only a run that writes an event claims it; a run whose streaming filter
 * drops an event leaves it for the others. Writes for one child entity (a turn
 * item, node, message, and so on) run one at a time. An event is skipped when
 * another run already wrote it, or when a newer update for the same entity has
 * been written, so an entity never goes back to an older state even when a
 * run subscribed after a backlog built up in another. A failed or interrupted
 * write claims nothing, so another run writes the event. Runs still route and
 * track every event themselves, so starting, stopping, and settling are
 * unchanged. The run's own provider-thread snapshot and every other
 * root-thread event are never claimed.
 *
 * What was written is remembered per provider session while any run
 * subscribed to it is live. Only those runs can deliver the session's older
 * events; a run that subscribes later receives only newer ones. The last run
 * to leave releases the session's memory.
 */
export function makeChildThreadEventWrites(ingestor: ProviderEventIngestorV2Shape) {
  const sessions = new Map<ProviderSessionId, SessionWrites>();

  const writeInOrder = (
    session: SessionWrites,
    event: ProviderAdapterV2Event,
    key: string,
    input: IngestInput,
  ): ReturnType<ProviderEventIngestorV2Shape["ingestNormalized"]> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        let entity = session.entities.get(key);
        if (entity?.writing !== undefined) {
          return restore(
            Deferred.await(entity.writing).pipe(
              Effect.andThen(() => writeInOrder(session, event, key, input)),
            ),
          );
        }
        const sequence = sequenceByEvent.get(event);
        if (
          session.written.has(event) ||
          (sequence !== undefined && entity !== undefined && sequence <= entity.lastWritten)
        ) {
          return Effect.succeed([]);
        }
        if (entity === undefined) {
          entity = { lastWritten: 0, writing: undefined };
          session.entities.set(key, entity);
        }
        const current = entity;
        const writing = Deferred.makeUnsafe<void>();
        current.writing = writing;
        return restore(ingestor.ingestNormalized(input)).pipe(
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit)) {
              session.written.add(event);
              if (sequence !== undefined) {
                current.lastWritten = Math.max(current.lastWritten, sequence);
              }
            }
            current.writing = undefined;
            return Deferred.succeed(writing, undefined);
          }),
        );
      }),
    );

  return {
    /**
     * Join a provider session when a run subscribes to its events. The run
     * writes through `ingestorFor` and calls `leave` once its subscription
     * closes.
     */
    join: (providerSessionId: ProviderSessionId) => {
      let session = sessions.get(providerSessionId);
      if (session === undefined) {
        session = { live: 0, written: new WeakSet(), entities: new Map() };
        sessions.set(providerSessionId, session);
      }
      const joined = session;
      joined.live += 1;
      let left = false;
      return {
        /** The ingestor the run uses to write this event. */
        ingestorFor: (
          event: ProviderAdapterV2Event,
          run: ChildThreadEventRun,
        ): ProviderEventIngestorV2Shape => {
          const key = childEntityKey(event, run);
          if (key === null) return ingestor;
          return {
            ...ingestor,
            ingestNormalized: (input: IngestInput) => writeInOrder(joined, event, key, input),
          };
        },
        leave: Effect.sync(() => {
          if (left) return;
          left = true;
          joined.live -= 1;
          if (joined.live === 0 && sessions.get(providerSessionId) === joined) {
            sessions.delete(providerSessionId);
          }
        }),
      };
    },
  };
}

/**
 * The entity a child-thread event updates, or null when the event is written
 * to the run's own thread.
 */
export function childEntityKey(
  event: ProviderAdapterV2Event,
  run: ChildThreadEventRun,
): string | null {
  if (
    event.type === "provider_thread.updated" &&
    event.providerThread.id === run.providerThreadId
  ) {
    return null;
  }
  const [threadId, key] = eventTarget(event);
  return threadId !== null && threadId !== run.threadId ? key : null;
}

/** The thread the ingestor writes the event to, and the entity it updates. */
function eventTarget(event: ProviderAdapterV2Event): readonly [ThreadId | null, string] {
  switch (event.type) {
    case "app_thread.created":
      return [event.appThread.id, `app_thread:${event.appThread.id}`];
    case "provider_thread.updated":
      return [event.providerThread.appThreadId, `provider_thread:${event.providerThread.id}`];
    case "provider_turn.updated":
      return [event.threadId ?? null, `provider_turn:${event.providerTurn.id}`];
    case "runtime_request.updated":
      return [event.threadId ?? null, `runtime_request:${event.runtimeRequest.id}`];
    case "node.updated":
      return [event.node.threadId, `node:${event.node.id}`];
    case "subagent.updated":
      return [event.subagent.threadId, `subagent:${event.subagent.id}`];
    case "message.updated":
      return [event.message.threadId, `message:${event.message.id}`];
    case "turn_item.updated":
      return [event.turnItem.threadId, `turn_item:${event.turnItem.id}`];
    case "plan.updated":
      return [event.plan.threadId, `plan:${event.plan.id}`];
    case "provider_session.updated":
      return [null, "provider_session"];
    case "turn.terminal":
      return [null, "turn.terminal"];
  }
}
