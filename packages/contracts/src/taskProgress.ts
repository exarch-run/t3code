import { PositiveInt, NonNegativeInt } from "./baseSchemas.ts";
import * as Schema from "effect/Schema";

/**
 * Task progress card. Version 2 is the canonical record and follows
 * OpenClaw's progress card (commit 11921d88, MIT, see
 * exarch/THIRD_PARTY_NOTICES.md): a session-durable card with optional
 * Markdown and an optional ordered checklist, replaced whole on every write
 * and cleared by an empty write.
 */
export const TASK_PROGRESS_MAX_MARKDOWN_UTF8_BYTES = 8192;
export const TASK_PROGRESS_MAX_STEPS = 50;
export const TASK_PROGRESS_MAX_STEP_UTF8_BYTES = 512;

export const TaskProgressStepStatus = Schema.Literals(["pending", "in_progress", "completed"]);
export type TaskProgressStepStatus = typeof TaskProgressStepStatus.Type;

export const TaskProgressStep = Schema.Struct({
  step: Schema.String,
  status: TaskProgressStepStatus,
});
export type TaskProgressStep = typeof TaskProgressStep.Type;

export const TaskProgressCardV2 = Schema.Struct({
  version: Schema.Literal(2),
  revision: PositiveInt,
  updatedAt: Schema.String,
  markdown: Schema.optionalKey(Schema.String),
  steps: Schema.optionalKey(Schema.Array(TaskProgressStep)),
});
export type TaskProgressCardV2 = typeof TaskProgressCardV2.Type;

/**
 * The canonical session record. `card` is null after a clear, while
 * `revision`, `updatedAt` and `generation` keep the ordering a reader needs to
 * tell a clear from an older snapshot. `turnId` is always written null; it
 * stays because stored records carry it.
 */
export const TaskProgressRecordV2 = Schema.Struct({
  card: Schema.NullOr(TaskProgressCardV2),
  revision: NonNegativeInt,
  updatedAt: Schema.NullOr(Schema.String),
  generation: Schema.String,
  turnId: Schema.NullOr(Schema.String),
});
export type TaskProgressRecordV2 = typeof TaskProgressRecordV2.Type;

/** What the writer tool answers: a sentence, the revision and the checklist counts. */
export const TaskProgressAcknowledgement = Schema.Struct({
  message: Schema.String,
  revision: Schema.NullOr(PositiveInt),
  steps: Schema.NullOr(Schema.Struct({ completed: NonNegativeInt, total: PositiveInt })),
});
export type TaskProgressAcknowledgement = typeof TaskProgressAcknowledgement.Type;
