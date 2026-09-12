import type {
  OrchestrationCommand,
  OrchestrationEvent,
  TaskProgressCard,
} from "@t3tools/contracts";
import { TaskProgressCard as CardSchema, TaskProgressReceipt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { progressEnabled } from "./TaskProgressRuntime.ts";

const encodeCard = Schema.encodeSync(Schema.fromJsonString(CardSchema));
const decodeCard = Schema.decodeUnknownSync(Schema.fromJsonString(CardSchema));
const decodeReceipt = Schema.decodeUnknownSync(Schema.fromJsonString(TaskProgressReceipt));
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(TaskProgressReceipt));

export const readProgress = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<{
    card_json: string;
  }>`SELECT card_json FROM strata_task_progress WHERE thread_id = ${threadId}`.pipe(
    Effect.map((rows) => (rows[0] ? decodeCard(rows[0].card_json) : null)),
    Effect.mapError(toPersistenceSqlError("task-progress.read")),
  );
export const readProgressReceipt = (sql: SqlClient.SqlClient, commandId: string) =>
  sql<{
    digest: string;
    receipt_json: string;
  }>`SELECT digest, receipt_json FROM strata_task_receipts WHERE command_id = ${commandId}`.pipe(
    Effect.map((rows) => rows[0] ?? null),
    Effect.mapError(toPersistenceSqlError("task-progress.receipt")),
  );
export const validateProgressCommand = (sql: SqlClient.SqlClient, command: OrchestrationCommand) =>
  Effect.gen(function* () {
    if (command.type !== "thread.task-progress.publish") return;
    if (!(yield* progressEnabled()))
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "Task progress is disabled in Agents and models.",
      });
    const previous = yield* readProgressReceipt(sql, command.commandId);
    if (previous) {
      if (previous.digest !== command.digest)
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "writeId was already used for different content. Use a fresh writeId for a new update.",
        });
      return decodeReceipt(previous.receipt_json);
    }
  });
export const projectTaskProgress = (sql: SqlClient.SqlClient, event: OrchestrationEvent) =>
  Effect.gen(function* () {
    if (event.type === "thread.task-progress-updated") {
      const { threadId, card, digest } = event.payload;
      yield* sql`INSERT INTO strata_task_progress (thread_id, card_json) VALUES (${threadId}, ${encodeCard(card)}) ON CONFLICT(thread_id) DO UPDATE SET card_json = excluded.card_json`;
      const receipt = {
        revision: card.revision,
        generation: card.generation,
        updatedAt: card.updatedAt,
        sequence: event.sequence,
      };
      yield* sql`INSERT INTO strata_task_receipts (command_id, thread_id, digest, receipt_json) VALUES (${event.commandId}, ${threadId}, ${digest}, ${encodeReceipt(receipt)}) ON CONFLICT(command_id) DO NOTHING`;
    } else if (event.type === "thread.deleted") {
      yield* sql`DELETE FROM strata_task_progress WHERE thread_id = ${event.payload.threadId}`;
      yield* sql`DELETE FROM strata_task_receipts WHERE thread_id = ${event.payload.threadId}`;
    } else if (event.aggregateKind === "thread") {
      // Runs are projected first. Persist this card's own source outcome even when
      // a later turn starts or the source leaves the paginated history.
      const card = yield* readProgress(sql, event.aggregateId);
      if (!card || card.outcome) return;
      const rows = yield* sql<{
        state: string;
        completed_at: string | null;
      }>`SELECT state, completed_at FROM projection_turns WHERE thread_id = ${event.aggregateId} AND turn_id = ${card.runId}`;
      const turn = rows[0];
      const outcome =
        turn?.state === "error"
          ? "failed"
          : turn?.state === "interrupted"
            ? "stopped"
            : turn?.state === "completed"
              ? "completed"
              : null;
      if (!outcome) return;
      yield* sql`UPDATE strata_task_progress SET card_json = ${encodeCard({ ...card, outcome, endedAt: turn?.completed_at ?? event.occurredAt } satisfies TaskProgressCard)} WHERE thread_id = ${event.aggregateId}`;
    }
  }).pipe(Effect.mapError(toPersistenceSqlError("task-progress.project")));

export const readProgressFields = (sql: SqlClient.SqlClient, threadId: string) =>
  readProgress(sql, threadId).pipe(Effect.map((card) => (card ? { taskProgress: card } : {})));
