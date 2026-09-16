import * as Schema from "effect/Schema";
import { RuntimeRequestId } from "./baseSchemas.ts";
import { ChatImageAttachment, ChatFileAttachment } from "./chatAttachment.ts";

export const QuestionResponseAnswer = Schema.Struct({
  questionId: Schema.String,
  question: Schema.String,
  answer: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  label: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  attachments: Schema.optional(
    Schema.Array(Schema.Union([ChatImageAttachment, ChatFileAttachment])),
  ),
});
export type QuestionResponseAnswer = typeof QuestionResponseAnswer.Type;

/**
 * An owner's reply to asynchronous agent questions, kept on the user message
 * that carries it. The message's `text` holds only the owner's words; the
 * question is context here so no reader can mistake it for the owner's.
 */
export const QuestionResponse = Schema.Struct({
  requestId: RuntimeRequestId,
  answers: Schema.Array(QuestionResponseAnswer),
});
export type QuestionResponse = typeof QuestionResponse.Type;

/** The owner's words alone: each answer in question order, array selections joined with commas, blank when the owner sent only files. */
export function questionResponseText(response: QuestionResponse): string {
  return response.answers
    .map((entry) => (Array.isArray(entry.answer) ? entry.answer.join(", ") : entry.answer))
    .filter((text) => text.length > 0)
    .join("\n\n");
}
