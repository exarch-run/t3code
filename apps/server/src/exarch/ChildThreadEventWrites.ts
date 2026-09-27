import type { ProviderThreadId, ThreadId } from "@t3tools/contracts";
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

/**
 * Every live run of a chat subscribes to the provider session and routes its
 * subagents' child-thread events, and a run stays live while a background
 * subagent works. Left alone, each child-thread event is written once per live
 * run, and a lagging run lands a stale copy after a newer one.
 *
 * The first live run to reach a child-thread event decides it. It writes the
 * event when its own streaming filter delivers it, and every other run skips
 * its copy. A run that reaches an event while another run is writing it waits
 * for that write, so child events land in adapter order. A failed or
 * interrupted write releases its claim, and the next run to reach the event
 * writes it. Runs still route and track every event themselves, so starting,
 * stopping, and settling are unchanged. The run's own provider-thread
 * snapshot and every other root-thread event are never claimed.
 *
 * Claims key on the adapter event object, which the session manager hands to
 * every subscriber as is. Adapters build a new object for each update.
 */
export function makeChildThreadEventWrites(ingestor: ProviderEventIngestorV2Shape) {
  const claims = new WeakMap<ProviderAdapterV2Event, Deferred.Deferred<void> | "settled">();

  const writeOnce = (
    event: ProviderAdapterV2Event,
    input: IngestInput,
  ): ReturnType<ProviderEventIngestorV2Shape["ingestNormalized"]> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const claim = claims.get(event);
        if (claim === "settled") return Effect.succeed([]);
        if (claim !== undefined) {
          return restore(Deferred.await(claim).pipe(Effect.andThen(() => writeOnce(event, input))));
        }
        const written = Deferred.makeUnsafe<void>();
        claims.set(event, written);
        return restore(ingestor.ingestNormalized(input)).pipe(
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit)) claims.set(event, "settled");
            else claims.delete(event);
            return Deferred.succeed(written, undefined);
          }),
        );
      }),
    );

  const passOnce = (event: ProviderAdapterV2Event): Effect.Effect<void> =>
    Effect.suspend(() => {
      const claim = claims.get(event);
      if (claim === "settled") return Effect.void;
      if (claim === undefined) {
        claims.set(event, "settled");
        return Effect.void;
      }
      return Deferred.await(claim).pipe(Effect.andThen(() => passOnce(event)));
    });

  return {
    /**
     * The ingestor a run uses for this event. `delivered` is whether the run's
     * streaming filter passed the event; a run that reaches a child-thread
     * event first without delivering it settles the event for every run.
     */
    ingestorFor: (
      event: ProviderAdapterV2Event,
      run: ChildThreadEventRun,
      delivered: boolean,
    ): Effect.Effect<ProviderEventIngestorV2Shape> => {
      if (!isChildThreadEvent(event, run)) return Effect.succeed(ingestor);
      if (!delivered) return passOnce(event).pipe(Effect.as(ingestor));
      return Effect.succeed({
        ...ingestor,
        ingestNormalized: (input: IngestInput) => writeOnce(event, input),
      });
    },
  };
}

/** Whether the event is written to a thread other than the run's own. */
export function isChildThreadEvent(
  event: ProviderAdapterV2Event,
  run: ChildThreadEventRun,
): boolean {
  if (
    event.type === "provider_thread.updated" &&
    event.providerThread.id === run.providerThreadId
  ) {
    return false;
  }
  const threadId = eventThreadId(event);
  return threadId !== null && threadId !== run.threadId;
}

/** The thread the ingestor writes the event to, when the event names one. */
function eventThreadId(event: ProviderAdapterV2Event): ThreadId | null {
  switch (event.type) {
    case "app_thread.created":
      return event.appThread.id;
    case "provider_thread.updated":
      return event.providerThread.appThreadId;
    case "provider_turn.updated":
    case "runtime_request.updated":
      return event.threadId ?? null;
    case "node.updated":
      return event.node.threadId;
    case "subagent.updated":
      return event.subagent.threadId;
    case "message.updated":
      return event.message.threadId;
    case "turn_item.updated":
      return event.turnItem.threadId;
    case "plan.updated":
      return event.plan.threadId;
    case "provider_session.updated":
    case "turn.terminal":
      return null;
  }
}
