import {
  TASK_PROGRESS_INSTRUCTIONS,
  CLAUDE_TASK_PROGRESS_INSTRUCTIONS,
} from "../exarch/TaskProgressInstructions.ts";
import type { ProviderDriverKind } from "@t3tools/contracts";

/**
 * Which Exarch tool families this session can actually call. Every adapter
 * derives these from its McpProviderSession rather than a setting, so the
 * standing text never describes a tool the turn does not have.
 */
export interface ExarchCapabilities {
  /** The `t3-code` MCP server is attached; without it no Exarch tool exists. */
  readonly t3Mcp: boolean;
  /** The `preview_*` browser tools are attached. */
  readonly browser: boolean;
  /** The `device_*` simulator and emulator tools are attached. */
  readonly device: boolean;
}

export const EXARCH_GUIDE_TOOL = "exarch_guide";

/** The fixed guide topics `exarch_guide` accepts; Exarch serves one tracked file per topic. */
export const EXARCH_GUIDE_TOPICS = [
  "browser",
  "rendering",
  "documents",
  "layout",
  "delegation",
  "chats",
  "workspaces",
  "schedules",
  "skills",
  "plugins",
  "private",
  "devices",
] as const;
export type ExarchGuideTopic = (typeof EXARCH_GUIDE_TOPICS)[number];

const BROWSER_RULE =
  "- Interactive browser work: Use Exarch's `preview_*` tools and the browser guide. Check status and open the browser before declaring it unavailable. Run existing suites through project runners; honor an explicitly required browser. Respect disabled access and user takeover.";

const DEVICE_RULE =
  "- Device work: Use Exarch's `device_*` discovery and the devices guide; retain the returned session identity. Use project runners for suites and alternatives for explicit requirements or confirmed gaps. Respect disabled access and takeover.";

/**
 * The approved standing orientation (instruction review, standing draft 3).
 * Wording changes go back to the owner; this file only decides which
 * capability-bound rules apply. Detailed procedures live in the guides
 * `exarch_guide` returns, and component syntax in `exarch_components`.
 */
export function exarchStandingInstructions(capabilities: ExarchCapabilities): string {
  const rules = [
    ...(capabilities.browser ? [BROWSER_RULE] : []),
    ...(capabilities.device ? [DEVICE_RULE] : []),
    "- Presenting information: Simple answer → prose; alternatives → table/matrix; relationships/process → diagram; change → before-and-after; useful input/state exploration → interactive HTML. Follow the user's requested format. For components or HTML, read the rendering guide; keep the main conclusion visible.",
    "- Collaborating on an open document: Use Exarch document tools and the documents guide, including the live unsaved buffer. Edits change tracked wording immediately. Ordinary repository file work uses normal file tools.",
    "- Showing deliverables or related work: Use the layout guide to open relevant work in the calling group, or the requested group. Preserve existing placement and focus. Reading a supporting file does not require opening a tab.",
    "- Delegating: Use native subagents for ordinary subtasks they can handle. Matching configured helper tasks use their configured route. For a requested family unavailable natively, inspect `orchestrator_capabilities` and the delegation guide. Select by actual model family, not driver.",
    '- Delegation unavailable or restricted: Report the actual limitation without silently substituting models or creating ordinary chats. Exarch Helpers settings govern those routes; native controls are separate. "No subagents" applies to both. Open helper tabs only on request.',
    "- Reading or coordinating chats: Use `t3_thread_*` tools and the chats guide. Send only requested coordination. Create a separate conversation only when explicitly requested.",
    "- Settling, snoozing, archiving, restoring: Act only on explicit requests, for the requested chat/group. Use the chats guide. Task completion does not authorize settlement.",
    "- Launching work in another workspace: Use the workspaces guide and bind the workspace before starting the agent; shell directory changes do not rebind a chat. Preserve the user's checkout and unrelated changes.",
    "- Future or recurring work: Use `schedule_task` and the schedules guide for an explicit request. Snoozing a chat does not schedule work.",
    "- Skills, instructions, plugins, services: Discover through `exarch_library`; read the skills or plugins guide for the relevant task before managing them. Create skills or install/connect plugins only with user direction or permission. Keep bundled originals and user customizations distinct.",
    "- Private work: Read the private guide. Use the inference-route and storage facts from `exarch_session` separately; private inference does not relocate ordinary project storage. Preserve applicable boundaries through helpers. Report private inference failures without ordinary-route fallback. Export private content only when authorized.",
  ];
  return `<exarch_instructions>
You are working in Exarch through its T3 engine. Use the supplied capability state: \`exarch_session\` for this chat's project, group, inference route, and storage, and \`orchestrator_capabilities\` for helper routes with their model families and unavailability reasons. A missing tool alone does not establish why a feature is unavailable; discover deferred tools before reporting absence. Read the named workflow guide with \`${EXARCH_GUIDE_TOOL}\` before using that Exarch workflow, unless it is already in context. Plain replies and ordinary native subtasks need no guide.

${rules.join("\n")}

For PRs you create or work on, immediately register each with \`link_pull_request\`, including each stack layer. Before finishing, use \`list_thread_pull_requests\` and register missing ones. Exclude background-only references; report linking failures.

Show useful evidence through accessible saved artifacts. Markdown absolute paths embed images/video. Keep routine captures out of replies.
</exarch_instructions>`;
}

export interface RuntimeInstructionsInput {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** The project's rendered session files (Exarch), placed after the runtime block. */
  readonly sessionContext?: string | undefined;
  /** The adapter's driver, for text that applies to one provider. */
  readonly driver?: ProviderDriverKind | undefined;
  /** Whether the owner's setting lets this session write the task card; omitted means no. */
  readonly taskProgress?: boolean | undefined;
  /** Omitted means the `t3-code` MCP server is not attached to this session. */
  readonly capabilities?: ExarchCapabilities | undefined;
}

/**
 * The separately measured parts of the runtime block, in delivery order.
 * Empty strings mark parts this session does not receive.
 */
export interface RuntimeInstructionSections {
  readonly runtimeInfo: string;
  readonly standing: string;
  readonly taskProgress: string;
  readonly sessionContext: string;
}

export function runtimeInstructionSections(
  runtime: RuntimeInstructionsInput,
): RuntimeInstructionSections {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const capabilities = runtime.capabilities;
  const taskProgress =
    runtime.taskProgress === true
      ? `${TASK_PROGRESS_INSTRUCTIONS}${runtime.driver === "claudeAgent" ? `\n${CLAUDE_TASK_PROGRESS_INSTRUCTIONS}` : ""}`
      : "";
  return {
    runtimeInfo: `<runtime_info>In case you're asked: you are running in Exarch through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise.</runtime_info>`,
    standing:
      capabilities !== undefined && capabilities.t3Mcp
        ? exarchStandingInstructions(capabilities)
        : "",
    taskProgress,
    sessionContext: runtime.sessionContext?.trim() ?? "",
  };
}

/** Shared runtime context; omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: RuntimeInstructionsInput): string {
  const sections = runtimeInstructionSections(runtime);
  return [sections.runtimeInfo, sections.standing, sections.taskProgress, sections.sessionContext]
    .filter((section) => section.length > 0)
    .join("\n\n");
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
