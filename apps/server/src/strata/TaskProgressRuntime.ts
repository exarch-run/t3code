import type {
  TaskProgressAcknowledgement,
  TaskProgressCardV2,
  TaskProgressRecordV2,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import type { ProjectionStoreV2Error } from "../orchestration-v2/ProjectionStore.ts";
import {
  normalizeTaskProgressInput,
  TaskProgressInputError,
  type NormalizedTaskProgressInput,
} from "./TaskProgressInput.ts";

/**
 * Task progress for every session, after OpenClaw's progress card (commit
 * 11921d88, MIT; see strata/THIRD_PARTY_NOTICES.md). The tools live on the
 * shared Strata toolkit, so whoever holds a chat's credential can publish to
 * that chat's one durable card: the chat comes from the credential the engine
 * issued at session start and stays valid while the session lives, whether or
 * not a turn is running. Each write replaces the whole card; an empty write
 * clears it. The card's status on screen comes from runtime facts the reader
 * already has, never from anything stored with the card.
 */
export interface ProgressWrite {
  threadId: ThreadId;
  input: NormalizedTaskProgressInput;
}
export interface Bridge {
  enabled: Effect.Effect<boolean>;
  write: (input: ProgressWrite) => Effect.Effect<TaskProgressRecordV2 | null, OrchestratorV2Error>;
  read: (threadId: ThreadId) => Effect.Effect<TaskProgressRecordV2 | null, ProjectionStoreV2Error>;
}
let bridge: Bridge | undefined;
let instructionsEnabled = true;
export const installBridge = (value: Bridge) => {
  bridge = value;
  return () => {
    if (bridge === value) bridge = undefined;
  };
};
export const progressAvailable = () => bridge !== undefined;
export const progressEnabled = () => bridge?.enabled ?? Effect.succeed(false);
/** The setting as the instruction builders see it; the bridge keeps it current. */
export const setProgressInstructionsEnabled = (value: boolean) => {
  instructionsEnabled = value;
};
export const progressInstructionsEnabled = () => instructionsEnabled;

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

const NOT_AVAILABLE = "Task progress is not available on this engine.";

/** The reference acknowledgement: a sentence plus the revision and counts. */
export function acknowledge(card: TaskProgressCardV2 | null): TaskProgressAcknowledgement {
  const total = card?.steps?.length ?? 0;
  const completed = card?.steps?.filter((step) => step.status === "completed").length ?? 0;
  return {
    message: !card
      ? "Progress card cleared"
      : total > 0
        ? `Progress card updated (rev ${card.revision}, ${completed}/${total} done)`
        : `Progress card updated (rev ${card.revision})`,
    revision: card?.revision ?? null,
    steps: total > 0 ? { completed, total } : null,
  };
}

/** Where a write arrives from: the shared MCP toolkit, or the Codex dynamic-tool route. */
export type ProgressWriteSource = "mcp" | "codex";
let mcpRefusal: ((threadId: ThreadId) => string | null) | undefined;
/** The Codex route tells the MCP writer which chats it owns; installed once, at module load. */
export const installMcpRefusal = (check: (threadId: ThreadId) => string | null) => {
  mcpRefusal = check;
};

/** Replace or clear the chat's card from a session's tool call; the acknowledgement is the tool's answer. */
export const publishProgress = (
  threadId: ThreadId,
  rawInput: unknown,
  source: ProgressWriteSource = "mcp",
): Effect.Effect<TaskProgressAcknowledgement, TaskProgressRefusedError> =>
  Effect.gen(function* () {
    const service = bridge;
    if (!service) return yield* new TaskProgressRefusedError({ detail: NOT_AVAILABLE });
    const refusal = source === "mcp" ? mcpRefusal?.(threadId) : null;
    if (refusal) return yield* new TaskProgressRefusedError({ detail: refusal });
    const input = yield* Effect.try({
      try: () => normalizeTaskProgressInput(rawInput),
      catch: (error) => (error instanceof TaskProgressInputError ? refused(error) : refused(error)),
    });
    const record = yield* service.write({ threadId, input }).pipe(Effect.mapError(refused));
    return acknowledge(record?.card ?? null);
  }).pipe(Effect.catchDefect((defect) => Effect.fail(refused(defect))));

/** The chat's current card, or null before any write and after a clear. */
export const readProgressCard = (
  threadId: ThreadId,
): Effect.Effect<TaskProgressCardV2 | null, TaskProgressRefusedError> =>
  Effect.gen(function* () {
    const service = bridge;
    if (!service) return yield* new TaskProgressRefusedError({ detail: NOT_AVAILABLE });
    const record = yield* service.read(threadId).pipe(Effect.mapError(refused));
    return record?.card ?? null;
  }).pipe(Effect.catchDefect((defect) => Effect.fail(refused(defect))));
