/**
 * The task card for Codex chats, delivered the way OpenClaw delivers its
 * tools to the Codex app-server: as dynamic tools registered at thread start,
 * which Codex calls back into this server with the calling thread and turn.
 * A Codex helper agent is its own thread, so the adapter answers these calls
 * only for the chat's own thread and turns a helper's call away before
 * anything is written. The shared MCP copy of the writer is refused for these
 * chats, so a helper cannot reach the card through it either; the read tool
 * stays open.
 */
import type * as CodexRpc from "effect-codex-app-server/rpc";
import * as CodexSchema from "effect-codex-app-server/schema";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  TASK_PROGRESS_READ_TOOL,
  TASK_PROGRESS_READ_TOOL_DESCRIPTION,
  TASK_PROGRESS_TOOL,
  TASK_PROGRESS_TOOL_DESCRIPTION,
  TASK_PROGRESS_TOOL_JSON_SCHEMA,
} from "./TaskProgressInput.ts";
import type { TaskProgressShape } from "./TaskProgressRuntime.ts";

type DynamicToolCall = CodexRpc.ServerRequestParamsByMethod["item/tool/call"];
type DynamicToolResult = CodexRpc.ServerRequestResponsesByMethod["item/tool/call"];

/** What thread/start receives; the same closed schema and description the MCP tool advertises. */
export const CODEX_TASK_PROGRESS_TOOLS: ReadonlyArray<CodexSchema.V2ThreadStartParams__DynamicToolSpec> =
  [
    {
      type: "function",
      name: TASK_PROGRESS_TOOL,
      description: TASK_PROGRESS_TOOL_DESCRIPTION,
      inputSchema: TASK_PROGRESS_TOOL_JSON_SCHEMA,
    },
    {
      type: "function",
      name: TASK_PROGRESS_READ_TOOL,
      description: TASK_PROGRESS_READ_TOOL_DESCRIPTION,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];

/**
 * thread/start as the Codex app-server accepts it. The generated params omit
 * the experimental `dynamicTools` field and the typed client encodes through
 * them, so this extends the generated schema and sends the encoded result.
 */
const CodexThreadStartWithDynamicTools = Schema.Struct({
  ...CodexSchema.V2ThreadStartParams.fields,
  dynamicTools: Schema.Array(CodexSchema.V2ThreadStartParams__DynamicToolSpec),
});
const encodeThreadStart = Schema.encodeEffect(CodexThreadStartWithDynamicTools);
const decodeThreadStarted = Schema.decodeUnknownEffect(CodexSchema.V2ThreadStartResponse);

/** Starts a Codex thread that carries the card tools. */
export const startCodexThreadWithCardTools = <E>(
  request: (method: "thread/start", params: unknown) => Effect.Effect<unknown, E>,
  params: CodexSchema.V2ThreadStartParams,
) =>
  encodeThreadStart({ ...params, dynamicTools: CODEX_TASK_PROGRESS_TOOLS }).pipe(
    Effect.flatMap((encoded) => request("thread/start", encoded)),
    Effect.flatMap(decodeThreadStarted),
  );

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const text = (value: unknown): DynamicToolResult["contentItems"] => [
  { type: "inputText", text: typeof value === "string" ? value : encodeJson(value) },
];
export const codexToolFailure = (detail: string): DynamicToolResult => ({
  success: false,
  contentItems: text(detail),
});

/**
 * Answers a card tool call from the chat's own Codex thread. The adapter
 * calls this only for thread ids it started for the chat; everything else it
 * refuses itself.
 */
export const handleCodexCardCall = (
  taskProgress: TaskProgressShape,
  threadId: ThreadId,
  call: DynamicToolCall,
): Effect.Effect<DynamicToolResult> =>
  Effect.gen(function* () {
    if (call.tool === TASK_PROGRESS_READ_TOOL) {
      const card = yield* taskProgress.read(threadId);
      return { success: true, contentItems: text({ card }) };
    }
    if (call.tool !== TASK_PROGRESS_TOOL)
      return codexToolFailure(`Unsupported dynamic tool: ${call.tool}`);
    const acknowledgement = yield* taskProgress.publish(threadId, call.arguments);
    return { success: true, contentItems: text(acknowledgement) };
  }).pipe(
    Effect.catch((error) => Effect.succeed(codexToolFailure(error.detail))),
    Effect.catchDefect((defect) => Effect.succeed(codexToolFailure(String(defect)))),
  );
