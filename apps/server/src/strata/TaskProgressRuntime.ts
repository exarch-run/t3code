import { createHash } from "node:crypto";
import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import type { TaskProgressCard, TaskProgressContent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TaskProgressContent as ContentSchema, TaskProgressReceipt } from "@t3tools/contracts";

type Receipt = typeof TaskProgressReceipt.Type;

/**
 * Task progress for every session. The tools live on the shared Strata
 * toolkit, so whoever holds a chat's credential can publish while that chat
 * has a running turn. The chat comes from the credential the engine issued
 * at session start; the turn is the chat's active turn as the server records
 * it. There is no parent-versus-subagent check: the instruction tells the
 * main agent to keep the card, and its next write replaces anything else.
 */
export interface ProgressInvocation {
  threadId: ThreadId;
  providerTurnId: string;
  writeId: string;
  digest: string;
  content: TaskProgressContent;
}
interface Bridge {
  enabled: Effect.Effect<boolean>;
  activeTurn: (threadId: ThreadId) => Effect.Effect<string | null, PersistenceSqlError>;
  publish: (
    input: ProgressInvocation,
  ) => Effect.Effect<Receipt, OrchestrationDispatchError | PersistenceSqlError>;
  read: (threadId: ThreadId) => Effect.Effect<TaskProgressCard | null, PersistenceSqlError>;
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

/** What the model reads when a write or read is refused. */
export class TaskProgressRefusedError extends Schema.TaggedError<TaskProgressRefusedError>()(
  "TaskProgressRefusedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
const describe = (cause: unknown): string => {
  if (cause && typeof cause === "object") {
    const record = cause as { detail?: unknown; message?: unknown };
    if (typeof record.detail === "string" && record.detail) return record.detail;
    if (typeof record.message === "string" && record.message) return record.message;
  }
  return String(cause);
};
const refused = (cause: unknown) => new TaskProgressRefusedError({ detail: describe(cause) });

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

const NOT_AVAILABLE = "Task progress is not available on this engine.";
export const NO_ACTIVE_RUN = "No run is active in this chat, so the card was not changed.";

/** Replace the chat's card from a session's tool call; the receipt is the tool's answer. */
export const publishProgress = (
  threadId: ThreadId,
  input: unknown,
): Effect.Effect<Receipt, TaskProgressRefusedError> =>
  Effect.gen(function* () {
    const service = bridge;
    if (!service) return yield* new TaskProgressRefusedError({ detail: NOT_AVAILABLE });
    const normalized = yield* Effect.try({ try: () => normalizeProgress(input), catch: refused });
    const turn = yield* service.activeTurn(threadId).pipe(Effect.mapError(refused));
    if (!turn) return yield* new TaskProgressRefusedError({ detail: NO_ACTIVE_RUN });
    return yield* service
      .publish({ ...normalized, threadId, providerTurnId: turn })
      .pipe(Effect.mapError(refused));
  }).pipe(Effect.catchDefect((defect) => Effect.fail(refused(defect))));

/** The chat's current card, or null before any write. */
export const readProgressCard = (
  threadId: ThreadId,
): Effect.Effect<TaskProgressCard | null, TaskProgressRefusedError> =>
  Effect.gen(function* () {
    const service = bridge;
    if (!service) return yield* new TaskProgressRefusedError({ detail: NOT_AVAILABLE });
    return yield* service.read(threadId).pipe(Effect.mapError(refused));
  }).pipe(Effect.catchDefect((defect) => Effect.fail(refused(defect))));
