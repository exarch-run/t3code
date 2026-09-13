/**
 * The main agent owns the task card (PRD §6.19, after OpenClaw's subagent
 * tool policy, which leaves progress_card out of every subagent's tools).
 * Claude's SDK runs PreToolUse hooks before a tool executes, in every
 * permission mode, and marks calls made from inside a subagent with
 * `agent_id`; this hook turns those calls away at that boundary.
 */
import type { HookCallback, HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";

/** The writer as Claude names it once the `t3-code` MCP server is attached. */
export const CLAUDE_TASK_PROGRESS_TOOL = "mcp__t3-code__strata_progress_card";
export const SUBAGENT_WRITE_REFUSED =
  "Only the main agent maintains the Strata task card. Report progress in your result instead.";

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
