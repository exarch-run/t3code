import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { TaskProgressReceipt } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { ServerSettingsService } from "../serverSettings.ts";
import { createHash } from "node:crypto";
import { CommandId } from "@t3tools/contracts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";
import { installBridge, type ProgressInvocation } from "./TaskProgressRuntime.ts";
import { readProgress, readProgressReceipt } from "./TaskProgressPersistence.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";

const commandIdFor = (input: ProgressInvocation) =>
  CommandId.make(
    `strata-progress-${createHash("sha256")
      .update(JSON.stringify([input.threadId, input.providerTurnId, input.writeId]))
      .digest("hex")}`,
  );
const decodeReceipt = Schema.decodeUnknownSync(Schema.fromJsonString(TaskProgressReceipt));

export const registerProgressBridge = (
  sql: SqlClient.SqlClient,
  dispatch: OrchestrationEngineShape["dispatch"],
) =>
  Effect.gen(function* () {
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    return yield* Effect.acquireRelease(
      Effect.sync(() =>
        installBridge({
          enabled: Option.isSome(settings)
            ? settings.value.getSettings.pipe(
                Effect.map((value) => value.enableTaskProgress),
                Effect.orElseSucceed(() => false),
              )
            : Effect.succeed(true),
          read: (threadId) => readProgress(sql, threadId),
          // The chat's active turn as the session projection records it: the
          // run a write is stamped with, and the gate that refuses idle chats.
          activeTurn: (threadId) =>
            sql<{
              active_turn_id: string | null;
              status: string;
            }>`SELECT active_turn_id, status FROM projection_thread_sessions WHERE thread_id = ${threadId}`.pipe(
              Effect.map((rows) =>
                rows[0]?.status === "running" && rows[0].active_turn_id
                  ? rows[0].active_turn_id
                  : null,
              ),
              Effect.mapError(toPersistenceSqlError("task-progress.active-turn")),
            ),
          publish: (input) =>
            Effect.gen(function* () {
              const commandId = commandIdFor(input);
              yield* dispatch({
                type: "thread.task-progress.publish",
                ...input,
                commandId,
                createdAt: yield* Effect.map(DateTime.now, DateTime.formatIso),
              });
              const receipt = yield* readProgressReceipt(sql, commandId);
              if (!receipt) throw new Error("Progress committed without a readable receipt.");
              return decodeReceipt(receipt.receipt_json);
            }),
        }),
      ),
      (close) => Effect.sync(close),
    );
  });
