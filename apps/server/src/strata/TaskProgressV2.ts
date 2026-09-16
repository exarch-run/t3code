import {
  CommandId,
  type TaskProgressRecordV2,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { randomUUID } from "node:crypto";
import type { OrchestratorV2Shape } from "../orchestration-v2/Orchestrator.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { normalizeTaskProgressInput } from "./TaskProgressInput.ts";
import { installBridge, setProgressInstructionsEnabled } from "./TaskProgressRuntime.ts";

/** Cards are part of the v2 thread record, committed and broadcast with the thread. */
export function nextTaskProgressRecord(input: {
  previous: TaskProgressRecordV2 | undefined;
  commandId: string;
  now: DateTime.Utc;
  content: unknown;
}): TaskProgressRecordV2 {
  const content = normalizeTaskProgressInput(input.content);
  const revision = (input.previous?.revision ?? 0) + 1;
  const updatedAt = DateTime.formatIso(input.now);
  return {
    card: content.markdown === undefined && content.steps === undefined
      ? null
      : { version: 2, revision, updatedAt, ...content },
    revision,
    updatedAt,
    generation: input.previous?.generation ?? input.commandId,
    turnId: null,
  };
}

export const taskProgressEnabled = Effect.gen(function* () {
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  return Option.isSome(settings)
    ? yield* settings.value.getSettings.pipe(Effect.map(value => value.enableTaskProgress))
    : true;
});

export const registerProgressBridge = Effect.fn("strata.registerV2ProgressBridge")(function* (
  dispatch: OrchestratorV2Shape["dispatch"],
  read: (threadId: ThreadId) => Effect.Effect<TaskProgressRecordV2 | null, unknown>,
) {
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const enabled = Option.isSome(settings)
    ? settings.value.getSettings.pipe(Effect.map(value => value.enableTaskProgress), Effect.orElseSucceed(() => false))
    : Effect.succeed(true);
  setProgressInstructionsEnabled(yield* enabled);
  if (Option.isSome(settings)) {
    const changes = yield* settings.value.subscribeChanges;
    yield* Effect.forkScoped(Stream.runForEach(changes, value =>
      Effect.sync(() => setProgressInstructionsEnabled(value.enableTaskProgress))));
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => installBridge({
      enabled,
      read,
      write: Effect.fn("strata.writeV2Progress")(function* ({ threadId, input }) {
        const result = yield* dispatch({
          type: "thread.task-progress.write",
          commandId: CommandId.make(`strata-progress-${randomUUID()}`),
          threadId,
          ...(input.markdown === undefined ? {} : { markdown: input.markdown }),
          ...(input.steps === undefined ? {} : { plan: input.steps }),
        });
        // A later concurrent write must not change this call's acknowledgement.
        for (const stored of result.storedEvents) {
          if (stored.event.type === "thread.metadata-updated") {
            return stored.event.payload.taskProgressV2 ?? null;
          }
        }
        return null;
      }),
    })),
    close => Effect.sync(close),
  );
});
