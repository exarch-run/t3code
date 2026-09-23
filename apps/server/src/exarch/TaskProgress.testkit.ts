import type { TaskProgressCardV2, TaskProgressRecordV2, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { NormalizedTaskProgressInput } from "./TaskProgressInput.ts";
import {
  makeTaskProgress,
  type TaskProgressCommands,
  type TaskProgressShape,
} from "./TaskProgressRuntime.ts";

/** A task-progress service bound to the given commands, as the orchestrator binds its own. */
export const boundTaskProgress = (
  commands: TaskProgressCommands,
  enabled: Effect.Effect<boolean> = Effect.succeed(true),
): TaskProgressShape =>
  Effect.runSync(
    Effect.gen(function* () {
      const service = yield* makeTaskProgress(enabled);
      const scope = yield* Scope.make();
      yield* service.bind(commands).pipe(Scope.provide(scope));
      return service;
    }),
  );

/** Card commands over one in-memory record; each write advances the revision. */
export const memoryCards = (initial: TaskProgressCardV2 | null = null) => {
  const written: Array<{ threadId: ThreadId; content: NormalizedTaskProgressInput }> = [];
  let record: TaskProgressRecordV2 | null =
    initial === null
      ? null
      : {
          card: initial,
          revision: initial.revision,
          updatedAt: initial.updatedAt,
          generation: "g",
          turnId: null,
        };
  const commands: TaskProgressCommands = {
    write: (threadId, content) =>
      Effect.sync(() => {
        written.push({ threadId, content });
        const revision = (record?.revision ?? 0) + 1;
        const updatedAt = "2026-01-01T00:00:00.000Z";
        record = {
          card:
            content.markdown === undefined && content.steps === undefined
              ? null
              : { version: 2, revision, updatedAt, ...content },
          revision,
          updatedAt,
          generation: "g",
          turnId: null,
        };
        return record;
      }),
    read: () => Effect.sync(() => record),
  };
  return { commands, written };
};
