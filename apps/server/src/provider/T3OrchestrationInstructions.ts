import type { ProviderInteractionMode } from "@t3tools/contracts";

/**
 * ACP-only text. Every other Exarch rule reaches agents through
 * `buildRuntimeInstructions`; this file holds the interaction-mode note ACP
 * needs because it has no mode channel, and the terminal fallback that only
 * ACP agents can use.
 */

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `## ACP tool fallback

Some ACP agents accept the injected MCP server but fail to expose its tools. When the T3 tools are absent and \`T3_ACP_MCP_NODE\` plus \`T3_ACP_MCP_ENTRYPOINT\` are present, call the same tools through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" "$T3_ACP_MCP_ENTRYPOINT" acp-mcp-call orchestrator_capabilities '{}'\`. Delegate with \`acp-mcp-call delegate_task '{"taskType":"<from orchestrator_capabilities>","task":"...","mode":"async","clientRequestId":"..."}'\`. This is the supported T3 transport fallback, not an ordinary shell-based substitute for delegation.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly browser: boolean;
  readonly device: boolean;
}

function sameAcpInstructionState(
  left: T3AcpInstructionState,
  right: T3AcpInstructionState,
): boolean {
  return (
    left.interactionMode === right.interactionMode &&
    left.hasT3Mcp === right.hasT3Mcp &&
    left.browser === right.browser &&
    left.device === right.device
  );
}

/**
 * ACP has no system/developer prompt field, so T3-owned context rides in the
 * first user prompt of a provider session and again only when the
 * interaction mode or the attached tools change. `runtimeInstructions` is the
 * adapter's `buildRuntimeInstructions` output for this session, session files
 * included, so those files are sent once per session rather than every turn.
 */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
  readonly runtimeInstructions: string;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState !== undefined &&
    sameAcpInstructionState(input.previousState, input.state)
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    input.runtimeInstructions.trim(),
    ...(input.state.hasT3Mcp ? [T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS] : []),
  ].filter((block) => block.length > 0);
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}
