import type {
  OrchestrationCommand,
  OrchestrationEvent,
  TaskProgressCard,
  TaskProgressRecordV2,
  TaskProgressStep,
} from "@t3tools/contracts";
import {
  TaskProgressCard as CardSchema,
  TaskProgressReceipt,
  TaskProgressStep as StepSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { progressEnabled } from "./TaskProgressRuntime.ts";
import {
  legacyCardFor,
  recordFromLegacyCard,
  type LegacyTurnFacts,
} from "./TaskProgressCompatibility.ts";

const encodeCard = Schema.encodeSync(Schema.fromJsonString(CardSchema));
const decodeReceipt = Schema.decodeUnknownSync(Schema.fromJsonString(TaskProgressReceipt));
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(TaskProgressReceipt));
const decodeSteps = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(StepSchema)));
const encodeSteps = Schema.encodeSync(Schema.fromJsonString(Schema.Array(StepSchema)));

interface RecordRow {
  thread_id: string;
  revision: number;
  generation: string;
  markdown: string | null;
  steps_json: string | null;
  turn_id: string | null;
  updated_at: string | null;
}

/** The stored row as the canonical record; a cleared row is a record with a null card. */
export function recordFromRow(row: RecordRow): TaskProgressRecordV2 {
  const steps: ReadonlyArray<TaskProgressStep> | undefined = row.steps_json
    ? decodeSteps(row.steps_json)
    : undefined;
  const hasContent = Boolean(row.markdown) || Boolean(steps?.length);
  return {
    card:
      hasContent && row.updated_at
        ? {
            version: 2,
            revision: row.revision,
            updatedAt: row.updated_at,
            ...(row.markdown ? { markdown: row.markdown } : {}),
            ...(steps && steps.length > 0 ? { steps } : {}),
          }
        : null,
    revision: row.revision,
    updatedAt: row.updated_at,
    generation: row.generation,
    turnId: row.turn_id,
  };
}

export const readProgressRecord = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<RecordRow>`SELECT thread_id, revision, generation, markdown, steps_json, turn_id, updated_at FROM strata_task_progress_v2 WHERE thread_id = ${threadId}`.pipe(
    Effect.map((rows) => (rows[0] ? recordFromRow(rows[0]) : null)),
    Effect.mapError(toPersistenceSqlError("task-progress.read")),
  );

const writeRecord = (sql: SqlClient.SqlClient, threadId: string, record: TaskProgressRecordV2) =>
  sql`INSERT INTO strata_task_progress_v2 (thread_id, revision, generation, markdown, steps_json, turn_id, updated_at)
      VALUES (${threadId}, ${record.revision}, ${record.generation}, ${record.card?.markdown ?? null}, ${record.card?.steps ? encodeSteps(record.card.steps) : null}, ${record.turnId}, ${record.updatedAt})
      ON CONFLICT(thread_id) DO UPDATE SET revision = excluded.revision, generation = excluded.generation, markdown = excluded.markdown, steps_json = excluded.steps_json, turn_id = excluded.turn_id, updated_at = excluded.updated_at`;

/** The turn a version 1 projection is attributed to, from the turn projection. */
export const readLegacyTurn = (sql: SqlClient.SqlClient, threadId: string, turnId: string) =>
  sql<{
    state: string;
    completed_at: string | null;
  }>`SELECT state, completed_at FROM projection_turns WHERE thread_id = ${threadId} AND turn_id = ${turnId}`.pipe(
    Effect.map((rows): LegacyTurnFacts | null =>
      rows[0] ? { turnId, state: rows[0].state, completedAt: rows[0].completed_at } : null,
    ),
    Effect.mapError(toPersistenceSqlError("task-progress.turn")),
  );

export const readProgressReceipt = (sql: SqlClient.SqlClient, commandId: string) =>
  sql<{
    digest: string;
    receipt_json: string;
  }>`SELECT digest, receipt_json FROM strata_task_receipts WHERE command_id = ${commandId}`.pipe(
    Effect.map((rows) => rows[0] ?? null),
    Effect.mapError(toPersistenceSqlError("task-progress.receipt")),
  );

export const isProgressCommand = (command: OrchestrationCommand) =>
  command.type === "thread.task-progress.write" || command.type === "thread.task-progress.publish";

export const validateProgressCommand = (sql: SqlClient.SqlClient, command: OrchestrationCommand) =>
  Effect.gen(function* () {
    if (!isProgressCommand(command)) return;
    if (!(yield* progressEnabled()))
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "Task progress is disabled in Agents and models.",
      });
    if (command.type !== "thread.task-progress.publish") return;
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
    if (event.type === "thread.task-progress-v2-updated") {
      yield* writeRecord(sql, event.payload.threadId, event.payload.record);
    } else if (event.type === "thread.task-progress-updated") {
      // Version 1 history lands in the canonical record and its old tables.
      const { threadId, card, digest } = event.payload;
      yield* writeRecord(sql, threadId, recordFromLegacyCard(card));
      yield* sql`INSERT INTO strata_task_progress (thread_id, card_json) VALUES (${threadId}, ${encodeCard(card)}) ON CONFLICT(thread_id) DO UPDATE SET card_json = excluded.card_json`;
      const receipt = {
        revision: card.revision,
        generation: card.generation,
        updatedAt: card.updatedAt,
        sequence: event.sequence,
      };
      yield* sql`INSERT INTO strata_task_receipts (command_id, thread_id, digest, receipt_json) VALUES (${event.commandId}, ${threadId}, ${digest}, ${encodeReceipt(receipt)}) ON CONFLICT(command_id) DO NOTHING`;
    } else if (event.type === "thread.deleted") {
      yield* sql`DELETE FROM strata_task_progress_v2 WHERE thread_id = ${event.payload.threadId}`;
      yield* sql`DELETE FROM strata_task_progress WHERE thread_id = ${event.payload.threadId}`;
      yield* sql`DELETE FROM strata_task_receipts WHERE thread_id = ${event.payload.threadId}`;
    }
  }).pipe(Effect.mapError(toPersistenceSqlError("task-progress.project")));

/** The canonical record for the command read model and the shell. */
export const readProgressFields = (sql: SqlClient.SqlClient, threadId: string) =>
  readProgressRecord(sql, threadId).pipe(
    Effect.map((record) => (record ? { taskProgressV2: record } : {})),
  );

/**
 * Thread detail carries the canonical record once the chat has one and, when
 * the old shape can hold it, the version 1 card. A reader that negotiated
 * version 1 uses only the latter; its absence is the shipped reader's "no card".
 */
export const readProgressSnapshotFields = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    const record = yield* readProgressRecord(sql, threadId);
    if (!record) return {};
    const turn =
      record.card && record.turnId ? yield* readLegacyTurn(sql, threadId, record.turnId) : null;
    const legacy: TaskProgressCard | null = legacyCardFor(record, turn);
    return { taskProgressV2: record, ...(legacy ? { taskProgress: legacy } : {}) };
  });
