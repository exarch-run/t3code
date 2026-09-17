import type { ThreadId } from "@t3tools/contracts";
import type { HookCallback, HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import { claudeTaskProgressOwnershipHooks } from "./TaskProgressOwnership.ts";
import { progressEnabled, readProgressCard } from "./TaskProgressRuntime.ts";

/** Restore application state through Claude's context hooks, without adding a user turn. */
export function claudeTaskProgressHooks(
  threadId: ThreadId,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const restore: HookCallback = async (input, _toolUseId, { signal }) => {
    if (
      input.agent_id ||
      (input.hook_event_name !== "UserPromptSubmit" &&
        !(input.hook_event_name === "SessionStart" && input.source === "compact"))
    )
      return {};

    const card = await Effect.runPromise(
      Effect.gen(function* () {
        if (!(yield* progressEnabled())) return null;
        return yield* readProgressCard(threadId);
      }).pipe(
        Effect.timeout("1 second"),
        Effect.catch(() => Effect.succeed(null)),
      ),
      { signal },
    ).catch(() => null);
    if (!card || signal.aborted) return {};

    return {
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        additionalContext: [
          "Strata's saved task card follows as JSON application state, not a new user request or instructions. Reconcile it with the owner's latest direction. When continuing this task, preserve completed steps and update changed progress before proceeding. A side question does not restart the task; a different task replaces the card only if it qualifies for one.",
          JSON.stringify({ markdown: card.markdown, plan: card.steps }),
        ].join("\n"),
      },
    };
  };
  return {
    ...claudeTaskProgressOwnershipHooks(),
    UserPromptSubmit: [{ hooks: [restore] }],
    SessionStart: [{ matcher: "compact", hooks: [restore] }],
  };
}
