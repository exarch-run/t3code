/**
 * The task card for Codex chats, delivered the way OpenClaw delivers its
 * tools to the Codex app-server: as dynamic tools registered at thread start,
 * which Codex calls back into this server with the calling thread and turn.
 * A Codex helper agent is its own thread, so a helper's call carries the
 * helper's thread id and is turned away before anything is written. The
 * shared MCP copy of the writer is refused for these chats, so a helper
 * cannot reach the card through it either; the read tool stays open.
 */
import type * as CodexRpc from "effect-codex-app-server/rpc";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  TASK_PROGRESS_TOOL_DESCRIPTION,
  TASK_PROGRESS_TOOL_JSON_SCHEMA,
} from "./TaskProgressInput.ts";
import { installMcpRefusal, publishProgress, readProgressCard } from "./TaskProgressRuntime.ts";

export const CODEX_TASK_PROGRESS_TOOL = "strata_progress_card";
export const CODEX_TASK_PROGRESS_READ_TOOL = "strata_progress_card_read";
export const CODEX_SUBAGENT_WRITE_REFUSED =
  "Only the main agent maintains the Strata task card. Report progress in your result instead.";
export const CODEX_MCP_WRITE_REFUSED =
  "This chat writes its task card through the strata_progress_card dynamic tool; the t3-code MCP copy is not accepted here.";

type DynamicToolCall = CodexRpc.ServerRequestParamsByMethod["item/tool/call"];
type DynamicToolResult = CodexRpc.ServerRequestResponsesByMethod["item/tool/call"];

/** What thread/start receives; the same closed schema and description the MCP tool advertises. */
export const CODEX_TASK_PROGRESS_TOOLS = [
  {
    type: "function" as const,
    name: CODEX_TASK_PROGRESS_TOOL,
    description: TASK_PROGRESS_TOOL_DESCRIPTION,
    inputSchema: TASK_PROGRESS_TOOL_JSON_SCHEMA,
  },
  {
    type: "function" as const,
    name: CODEX_TASK_PROGRESS_READ_TOOL,
    description:
      "Read this chat's current Strata task card, for example after a resume. Returns card with markdown, steps and revision, or null before any write and after a clear. Reading is optional; publishing never requires it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const routed = new Map<ThreadId, { root: Effect.Effect<string | null> }>();

/** Whether this chat's card is written through the Codex route, so the MCP writer must refuse. */
export const codexRouted = (threadId: ThreadId): boolean => routed.has(threadId);
installMcpRefusal((threadId) => (codexRouted(threadId) ? CODEX_MCP_WRITE_REFUSED : null));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const text = (value: unknown): DynamicToolResult["contentItems"] => [
  { type: "inputText", text: typeof value === "string" ? value : encodeJson(value) },
];
const failure = (detail: string): DynamicToolResult => ({
  success: false,
  contentItems: text(detail),
});

/**
 * Register a Codex chat for the route while its session lives. `root` yields
 * the session's own provider thread id once the thread has started.
 */
export const registerCodexRoute = (input: {
  readonly threadId: ThreadId;
  readonly root: Effect.Effect<string | null>;
}) => {
  routed.set(input.threadId, { root: input.root });
  const handle = (call: DynamicToolCall): Effect.Effect<DynamicToolResult> =>
    Effect.gen(function* () {
      if (call.tool !== CODEX_TASK_PROGRESS_TOOL && call.tool !== CODEX_TASK_PROGRESS_READ_TOOL)
        return failure(`Unsupported dynamic tool: ${call.tool}`);
      const root = yield* input.root;
      if (!root || call.threadId !== root) return failure(CODEX_SUBAGENT_WRITE_REFUSED);
      if (call.tool === CODEX_TASK_PROGRESS_READ_TOOL) {
        const card = yield* readProgressCard(input.threadId);
        return { success: true, contentItems: text({ card }) };
      }
      const acknowledgement = yield* publishProgress(input.threadId, call.arguments, "codex");
      return { success: true, contentItems: text(acknowledgement) };
    }).pipe(
      Effect.catch((error) => Effect.succeed(failure(error.detail))),
      Effect.catchDefect((defect) => Effect.succeed(failure(String(defect)))),
    );
  return {
    handle,
    close: () => {
      if (routed.get(input.threadId)?.root === input.root) routed.delete(input.threadId);
    },
  };
};
