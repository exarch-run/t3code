/**
 * The main agent owns the task card (PRD §6.19, after OpenClaw's subagent
 * tool policy, which leaves progress_card out of every subagent's tools).
 * The MCP credential names the chat, not the native caller, so a helper that
 * shares its chat's credential reaches the card unless the provider marks
 * the call. Each adapter's decision:
 *
 * | Adapter | Card writes from helpers | How |
 * |---|---|---|
 * | Claude | Refused | This PreToolUse hook: Claude's SDK runs it before every tool call, in every permission mode, and marks calls made inside a subagent with `agent_id`. |
 * | Codex | Refused | The card is a dynamic tool the adapter answers only for the chat's own thread ids; a helper is its own thread. The shared MCP writer refuses the chat while its Codex session lives (`TaskProgressShape.claimWriter`). |
 * | OpenCode, Cursor, ACP (Grok, Antigravity, Devin and registry agents), Pi | Not guarded | Helpers share the chat's MCP credential, and none of these providers gives the engine a pre-tool hook that identifies the calling agent. A helper's write lands on the chat's card. |
 *
 * A per-session MCP capability cannot replace the Claude hook: it is decided
 * per credential, and a root agent and its helpers share one.
 */
import type { HookCallback, HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { SUBAGENT_WRITE_REFUSED, TASK_PROGRESS_TOOL } from "./TaskProgressInput.ts";

/** The writer as Claude names it once the `t3-code` MCP server is attached. */
export const CLAUDE_TASK_PROGRESS_TOOL = `mcp__t3-code__${TASK_PROGRESS_TOOL}`;

export const claudeTaskProgressOwnershipHook: HookCallback = async (input) => {
  if (
    input.hook_event_name !== "PreToolUse" ||
    input.tool_name !== CLAUDE_TASK_PROGRESS_TOOL ||
    !input.agent_id
  ) {
    return {};
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: SUBAGENT_WRITE_REFUSED,
    },
  };
};

export const claudeTaskProgressOwnershipHooks = (): Partial<
  Record<HookEvent, HookCallbackMatcher[]>
> => ({
  PreToolUse: [{ matcher: CLAUDE_TASK_PROGRESS_TOOL, hooks: [claudeTaskProgressOwnershipHook] }],
});
