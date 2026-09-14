import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ServerSettingsService } from "../serverSettings.ts";
import * as NodeCrypto from "node:crypto";
import { CommandId } from "@t3tools/contracts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";
import {
  installBridge,
  setProgressInstructionsEnabled,
  type ProgressWrite,
} from "./TaskProgressRuntime.ts";
import { readProgressRecord, readCommittedProgressRecord } from "./TaskProgressPersistence.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";

/**
 * Every tool call is its own command. The transport already answers each
 * call once; a model that retries after a dropped answer writes the same
 * content again and moves the revision on, as the reference does.
 */
const freshCommandId = () => CommandId.make(`strata-progress-${NodeCrypto.randomUUID()}`);

export const registerProgressBridge = (
  sql: SqlClient.SqlClient,
  dispatch: OrchestrationEngineShape["dispatch"],
) =>
  Effect.gen(function* () {
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    if (Option.isSome(settings)) {
      // The instruction builders read a plain flag; keep it at the setting.
      const changes = yield* settings.value.subscribeChanges;
      setProgressInstructionsEnabled(
        yield* settings.value.getSettings.pipe(
          Effect.map((value) => value.enableTaskProgress),
          Effect.orElseSucceed(() => true),
        ),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(changes, (value) =>
          Effect.sync(() => setProgressInstructionsEnabled(value.enableTaskProgress)),
        ),
      );
    }
    // The chat's active turn as the session projection records it. It only
    // attributes the write for version 1 readers; it never gates a write.
    const activeTurn = (threadId: string) =>
      sql<{
        active_turn_id: string | null;
        status: string;
      }>`SELECT active_turn_id, status FROM projection_thread_sessions WHERE thread_id = ${threadId}`.pipe(
        Effect.map((rows) =>
          rows[0]?.status === "running" && rows[0].active_turn_id ? rows[0].active_turn_id : null,
        ),
        Effect.mapError(toPersistenceSqlError("task-progress.active-turn")),
      );
    return yield* Effect.acquireRelease(
      Effect.sync(() =>
        installBridge({
          enabled: Option.isSome(settings)
            ? settings.value.getSettings.pipe(
                Effect.map((value) => value.enableTaskProgress),
                Effect.tap((value) => Effect.sync(() => setProgressInstructionsEnabled(value))),
                Effect.orElseSucceed(() => false),
              )
            : Effect.succeed(true),
          read: (threadId) => readProgressRecord(sql, threadId),
          write: (write: ProgressWrite) =>
            Effect.gen(function* () {
              const empty = write.input.markdown === undefined && write.input.steps === undefined;
              if (empty) {
                // Clearing a card that was never used writes nothing.
                const current = yield* readProgressRecord(sql, write.threadId);
                if (!current || current.revision === 0) return current;
              }
              const committed = yield* dispatch({
                type: "thread.task-progress.write",
                commandId: freshCommandId(),
                threadId: write.threadId,
                createdAt: yield* Effect.map(DateTime.now, DateTime.formatIso),
                ...(write.input.markdown !== undefined ? { markdown: write.input.markdown } : {}),
                ...(write.input.steps !== undefined ? { steps: write.input.steps } : {}),
                turnId: yield* activeTurn(write.threadId),
              });
              return yield* readCommittedProgressRecord(sql, write.threadId, committed.sequence);
            }),
        }),
      ),
      (close) => Effect.sync(close),
    );
  });
