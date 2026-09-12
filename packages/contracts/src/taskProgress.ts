import { PositiveInt, NonNegativeInt } from "./baseSchemas.ts";
import * as Schema from "effect/Schema";

export const TaskProgressContent = Schema.Struct({
  markdown: Schema.NullOr(Schema.String),
  plan: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      status: Schema.Literals(["pending", "in_progress", "completed"]),
    }),
  ),
});
export type TaskProgressContent = typeof TaskProgressContent.Type;
export const TaskProgressCard = Schema.Struct({
  ...TaskProgressContent.fields,
  version: Schema.Literal(1),
  revision: PositiveInt,
  generation: Schema.String,
  runId: Schema.String,
  providerTurnId: Schema.String,
  updatedAt: Schema.String,
  outcome: Schema.NullOr(Schema.Literals(["completed", "failed", "stopped"])),
  endedAt: Schema.NullOr(Schema.String),
});
export type TaskProgressCard = typeof TaskProgressCard.Type;
export const TaskProgressPublishFields = {
  writerId: Schema.String,
  providerTurnId: Schema.String,
  writeId: Schema.String,
  digest: Schema.String,
  content: TaskProgressContent,
};

export const TaskProgressReceipt = Schema.Struct({
  revision: PositiveInt,
  generation: Schema.String,
  updatedAt: Schema.String,
  sequence: NonNegativeInt,
});
