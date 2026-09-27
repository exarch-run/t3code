import { isDeepStrictEqual } from "node:util";
import type { ChatAttachment, OrchestrationV2TurnItem, QuestionResponse } from "@t3tools/contracts";

/** Generic edits keep the question link while making the message the answer owner. */
export function normalizeQueuedAnswerEdit(
  saved: {
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly questionResponse?: QuestionResponse | undefined;
  },
  edit: {
    readonly text: string;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
    readonly questionResponse?: QuestionResponse | undefined;
  },
): QuestionResponse | undefined {
  if (edit.questionResponse !== undefined) return edit.questionResponse;
  if (saved.questionResponse === undefined) return undefined;
  if (
    saved.text === edit.text &&
    isDeepStrictEqual(saved.attachments, edit.attachments ?? saved.attachments)
  ) {
    return saved.questionResponse;
  }
  return { requestId: saved.questionResponse.requestId, answers: [] };
}

/** Keep each selected question's canonical answer, including a removed queued run. */
export function linkedQueuedAnswerMessageIds(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): string[] {
  return items.flatMap((item) =>
    item.type === "user_input_request" ? [`async-answer:${item.requestId}`] : [],
  );
}
