import type { HookCallback, HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type {
  OrchestrationV2ContextHandoff,
  OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HANDOFF_BYTE_CAP } from "../orchestration-v2/ContextHandoffBudget.ts";
import { deliverContextHandoffs } from "../orchestration-v2/ContextHandoffDelivery.ts";

// Claude replaces context outputs above 10,000 characters with a file preview.
// A numbered set carries the existing package ceiling without changing its bytes.
const PART_CHARACTERS = 9_000;
const PART_COUNT = Math.ceil(HANDOFF_BYTE_CAP / PART_CHARACTERS);

function splitContext(text: string): string[] {
  if (Buffer.byteLength(text) > HANDOFF_BYTE_CAP) {
    throw new RangeError("Claude handoff exceeds the existing context byte ceiling.");
  }
  const parts: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + PART_CHARACTERS, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

/** This state belongs to one live query, never to the adapter or a native-thread cache. */
export function createClaudeHandoffContext(
  initialContext: string | undefined,
  existingHooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>,
) {
  let current = { text: initialContext ?? "", parts: splitContext(initialContext ?? "") };
  const provided: Array<string | undefined> = Array.from({ length: PART_COUNT });
  const callbacks: HookCallback[] = Array.from(
    { length: PART_COUNT },
    (_, index) =>
      async (input, _toolUseId, { signal }) => {
        if (signal.aborted || input.agent_id) return {};
        const compact = input.hook_event_name === "SessionStart" && input.source === "compact";
        if (input.hook_event_name !== "UserPromptSubmit" && !compact) return {};
        const snapshot = current;
        const part = snapshot.parts[index];
        if (!part || (!compact && provided[index] === snapshot.text)) return {};
        provided[index] = snapshot.text;
        return {
          hookSpecificOutput: {
            hookEventName: input.hook_event_name,
            additionalContext: `Exarch handoff context, part ${index + 1} of ${snapshot.parts.length}. Parts in numeric order form one retained context package.\n${part}`,
          },
        };
      },
  );
  return {
    update(text: string | undefined) {
      text ??= "";
      if (text !== current.text) current = { text, parts: splitContext(text) };
    },
    complete(status: string, modelTurns: number | undefined, compact: boolean) {
      // Hook results are provisional until the prompt actually runs. Successful
      // native compaction may have zero model turns and already restored context.
      if (status !== "completed" || (modelTurns === 0 && !compact)) provided.fill(undefined);
    },
    hooks: {
      ...existingHooks,
      UserPromptSubmit: [...(existingHooks.UserPromptSubmit ?? []), { hooks: callbacks }],
      SessionStart: [
        ...(existingHooks.SessionStart ?? []),
        { matcher: "compact", hooks: callbacks },
      ],
    } satisfies Partial<Record<HookEvent, HookCallbackMatcher[]>>,
  };
}

/** Cold compaction restores only accepted context for this native conversation.
 * Rendering is read-only and uses the post-compaction allowance, not stale usage. */
export const restoreClaudeHandoffContext = (input: {
  readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
  readonly providerThread: OrchestrationV2ProviderThread;
}) =>
  deliverContextHandoffs({
    handoffs: input.handoffs.filter(
      (handoff) =>
        handoff.status === "ready" &&
        handoff.toProviderThreadId === input.providerThread.id &&
        input.providerThread.nativeThreadRef != null &&
        handoff.delivery?.nativeThreadId === input.providerThread.nativeThreadRef?.nativeId &&
        handoff.delivery?.contextChannel === "system" &&
        handoff.delivery.status !== "pending",
    ),
    providerThread: input.providerThread,
    contextChannel: "system",
    budget: HANDOFF_BYTE_CAP,
    alreadyDeliveredItemIds: new Set(),
    persist: () => Effect.void,
  }).pipe(Effect.map((delivery) => delivery.context));
