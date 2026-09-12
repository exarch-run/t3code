import { createHash, randomUUID } from "node:crypto";
import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import type { TaskProgressContent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TaskProgressContent as ContentSchema } from "@t3tools/contracts";

export interface ProgressWriter {
  threadId: ThreadId;
  root: Effect.Effect<string | undefined>;
  current: (turnId: string) => Effect.Effect<boolean>;
}
const writers = new Map<string, ProgressWriter>();
export const registerWriter = (writer: ProgressWriter) => {
  const id = randomUUID();
  writers.set(id, writer);
  return { id, close: () => writers.delete(id) };
};
export const currentWriter = (id: string, threadId: string, turnId: string) => {
  const writer = writers.get(id);
  return writer?.threadId === threadId ? writer.current(turnId) : Effect.succeed(false);
};
export interface ProgressInvocation {
  threadId: ThreadId;
  writerId: string;
  providerTurnId: string;
  writeId: string;
  digest: string;
  content: TaskProgressContent;
}
interface Bridge {
  enabled: Effect.Effect<boolean>;
  publish: (
    input: ProgressInvocation,
  ) => Effect.Effect<unknown, OrchestrationDispatchError | PersistenceSqlError>;
  read: (
    threadId: ThreadId,
  ) => Effect.Effect<unknown, OrchestrationDispatchError | PersistenceSqlError>;
}
let bridge: Bridge | undefined;
export const installBridge = (value: Bridge) => {
  bridge = value;
  return () => {
    if (bridge === value) bridge = undefined;
  };
};
export const progressAvailable = () => bridge !== undefined;
export const progressEnabled = () => bridge?.enabled ?? Effect.succeed(false);
const text = (value: string) =>
  value
    .replace(/\r\n?/g, "\n")
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b\u200e-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,
      "",
    );
export function normalizeProgress(value: unknown): {
  writeId: string;
  content: TaskProgressContent;
  digest: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Progress requires a complete card and writeId.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["writeId", "markdown", "plan"].includes(key)))
    throw new Error("Unknown progress field.");
  if (typeof input.writeId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.writeId))
    throw new Error(
      "writeId must contain 1–128 letters, numbers, dots, colons, hyphens or underscores.",
    );
  if (
    Array.isArray(input.plan) &&
    input.plan.some(
      (step) =>
        step &&
        typeof step === "object" &&
        Object.keys(step).some((key) => !["text", "status"].includes(key)),
    )
  )
    throw new Error("Unknown plan step field.");
  const decoded = Schema.decodeUnknownSync(ContentSchema)({
    markdown: input.markdown ?? null,
    plan: input.plan ?? [],
  });
  const content = {
    markdown: decoded.markdown === null ? null : text(decoded.markdown).trim() || null,
    plan: decoded.plan.map((step) => ({ text: text(step.text).trim(), status: step.status })),
  };
  if (Buffer.byteLength(content.markdown ?? "", "utf8") > 8192)
    throw new Error("Progress Markdown exceeds 8 KiB.");
  if (
    content.plan.length > 50 ||
    content.plan.some((step) => !step.text || [...step.text].length > 500)
  )
    throw new Error("Use at most 50 steps, each 1–500 characters.");
  if (content.plan.filter((step) => step.status === "in_progress").length > 1)
    throw new Error("Only one step can be in progress.");
  if (!content.markdown && !content.plan.length)
    throw new Error("Supply a status note, plan, or both. Hiding never clears the card.");
  return {
    writeId: input.writeId,
    content,
    digest: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  };
}
export function invokeProgress(
  writerId: string,
  request: { threadId: string; turnId: string; tool: string; arguments: unknown },
) {
  return Effect.gen(function* () {
    const writer = writers.get(writerId),
      service = bridge;
    if (!writer || !service || request.threadId !== (yield* writer.root))
      throw new Error("Progress publishing is available only to the conversation's parent agent.");
    if (request.tool === "progress_card_read") return yield* service.read(writer.threadId);
    if (request.tool !== "progress_card")
      throw new Error(`Unsupported dynamic tool: ${request.tool}`);
    const normalized = normalizeProgress(request.arguments);
    return yield* service.publish({
      ...normalized,
      writerId,
      threadId: writer.threadId,
      providerTurnId: request.turnId,
    });
  }).pipe(
    Effect.matchCause({
      onSuccess: (result) => ({
        success: true,
        contentItems: [{ type: "inputText" as const, text: JSON.stringify(result) }],
      }),
      onFailure: (cause) => ({
        success: false,
        contentItems: [
          { type: "inputText" as const, text: `Progress not updated: ${String(cause)}` },
        ],
      }),
    }),
  );
}
export const taskTools = [
  {
    type: "function",
    name: "progress_card",
    description:
      "Keep Strata's task card current for substantial work. Write a general Markdown status, an ordered checklist, or both. Every call replaces the whole card; omitted parts are removed. Update at meaningful milestones and before ending, not on every turn. Do not duplicate note and checklist facts. Only the parent may publish. Use a fresh writeId for each new update and reuse it for a retry; await the receipt before another update. No read is required.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        writeId: { type: "string" },
        markdown: { type: "string" },
        plan: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["text", "status"],
          },
        },
      },
      required: ["writeId"],
    },
  },
  {
    type: "function",
    name: "progress_card_read",
    description:
      "Optionally recover the current Strata task card after resume. Reading is not required before publishing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;
