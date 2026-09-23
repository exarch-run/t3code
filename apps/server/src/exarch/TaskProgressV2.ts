import { CommandId, type TaskProgressRecordV2, type TaskProgressStep } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";
import type { OrchestratorV2Shape } from "../orchestration-v2/Orchestrator.ts";
import { validateTaskProgressContent } from "./TaskProgressInput.ts";
import type { TaskProgressCommands, TaskProgressShape } from "./TaskProgressRuntime.ts";

/** Cards are part of the v2 thread record, committed and broadcast with the thread. */
export function nextTaskProgressRecord(input: {
  previous: TaskProgressRecordV2 | undefined;
  commandId: string;
  now: DateTime.Utc;
  content: {
    readonly markdown?: string | undefined;
    readonly steps?: ReadonlyArray<TaskProgressStep> | undefined;
  };
}): TaskProgressRecordV2 {
  const content = validateTaskProgressContent(input.content);
  const revision = (input.previous?.revision ?? 0) + 1;
  const updatedAt = DateTime.formatIso(input.now);
  return {
    card:
      content.markdown === undefined && content.steps === undefined
        ? null
        : { version: 2, revision, updatedAt, ...content },
    revision,
    updatedAt,
    generation: input.previous?.generation ?? input.commandId,
    turnId: null,
  };
}

/**
 * Binds the orchestrator's card commands to the task-progress service for the
 * life of the orchestrator's scope.
 */
export const bindTaskProgressCommands = Effect.fn("exarch.bindTaskProgressCommands")(function* (
  taskProgress: TaskProgressShape,
  dispatch: OrchestratorV2Shape["dispatch"],
  read: TaskProgressCommands["read"],
) {
  yield* taskProgress.bind({
    read,
    write: Effect.fn("exarch.writeV2Progress")(function* (threadId, content) {
      const result = yield* dispatch({
        type: "thread.task-progress.write",
        commandId: CommandId.make(`exarch-progress-${NodeCrypto.randomUUID()}`),
        threadId,
        ...content,
      });
      // A later concurrent write must not change this call's acknowledgement.
      for (const stored of result.storedEvents) {
        if (stored.event.type === "thread.metadata-updated") {
          return stored.event.payload.taskProgressV2 ?? null;
        }
      }
      return null;
    }),
  });
});
