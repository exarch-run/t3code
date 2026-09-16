import type { QuestionResponse } from "@t3tools/contracts";

/**
 * What the provider reads when the owner answers asynchronous questions: an
 * envelope that names the content as answers, then the record as JSON so a
 * question or answer holding newlines, quotes, or label-like text cannot be
 * confused with the envelope. Transport only; never stored as the owner's
 * words, shown as the chat answer, or read by synthesis.
 */
export function formatQuestionResponseForProvider(response: QuestionResponse): string {
  const record = {
    requestId: response.requestId,
    answers: response.answers.map((entry) => ({
      questionId: entry.questionId,
      question: entry.question,
      answer: entry.answer,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      ...(entry.attachments !== undefined && entry.attachments.length > 0
        ? { attachments: entry.attachments.map((file) => ({ id: file.id, name: file.name })) }
        : {}),
    })),
  };
  return [
    "The user answered the questions you asked earlier. Each entry pairs one of your questions with the user's exact answer; `attachments` lists files the user attached to that answer.",
    "```json",
    JSON.stringify(record, null, 2),
    "```",
  ].join("\n");
}
