import type {
  TaskProgressAcknowledgement,
  TaskProgressCardV2,
  TaskProgressRecordV2,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import type { ProjectionStoreV2Error } from "../orchestration-v2/ProjectionStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  normalizeTaskProgressInput,
  type NormalizedTaskProgressInput,
} from "./TaskProgressInput.ts";

/**
 * Task progress for every session, after OpenClaw's progress card (commit
 * 11921d88, MIT; see exarch/THIRD_PARTY_NOTICES.md). The tools live on the
 * shared Exarch toolkit, so whoever holds a chat's credential can publish to
 * that chat's one durable card: the chat comes from the credential the engine
 * issued at session start and stays valid while the session lives, whether or
 * not a turn is running. Each write replaces the whole card; an empty write
 * clears it. The card's status on screen comes from runtime facts the reader
 * already has, never from anything stored with the card.
 */

/**
 * The orchestrator's two card operations: the command port the orchestrator
 * binds once it is built. The service holds the port instead of the
 * orchestrator, so the provider adapters the orchestrator depends on can hold
 * the service without a layer cycle.
 */
export interface TaskProgressCommands {
  /** Commits a write; the record comes from this write's own receipt, not a later read. */
  readonly write: (
    threadId: ThreadId,
    content: NormalizedTaskProgressInput,
  ) => Effect.Effect<TaskProgressRecordV2 | null, OrchestratorV2Error>;
  readonly read: (
    threadId: ThreadId,
  ) => Effect.Effect<TaskProgressRecordV2 | null, ProjectionStoreV2Error>;
}

export interface TaskProgressShape {
  /** The owner's setting, read on every call so a change applies at once. */
  readonly enabled: Effect.Effect<boolean>;
  /** Replace or clear the chat's card from a session's tool call; the acknowledgement is the tool's answer. */
  readonly publish: (
    threadId: ThreadId,
    rawInput: unknown,
  ) => Effect.Effect<TaskProgressAcknowledgement, TaskProgressRefusedError>;
  /** The chat's current card, or null before any write and after a clear. */
  readonly read: (
    threadId: ThreadId,
  ) => Effect.Effect<TaskProgressCardV2 | null, TaskProgressRefusedError>;
  /** Called by the orchestrator: the commands serve every call for the life of the calling scope. */
  readonly bind: (commands: TaskProgressCommands) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Marks the chat's card as written through the provider's own tool until
   * the returned release runs, so the shared MCP writer refuses it. Codex
   * holds this for each chat it serves, because Codex helpers share the
   * chat's MCP credential (see TaskProgressOwnership).
   */
  readonly claimWriter: (threadId: ThreadId) => () => void;
  /** Whether a provider's own tool writes this chat's card, so the MCP writer must refuse. */
  readonly claimed: (threadId: ThreadId) => boolean;
}

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

const notAvailable = () =>
  new TaskProgressRefusedError({ detail: "Task progress is not available on this engine." });

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

/** One task-progress service; `enabled` is how its callers read the owner's setting. */
export const makeTaskProgress = (enabled: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    const bound = yield* Ref.make<TaskProgressCommands | undefined>(undefined);
    const claims = new Map<ThreadId, number>();
    const commands = Ref.get(bound).pipe(
      Effect.flatMap((value) => (value ? Effect.succeed(value) : Effect.fail(notAvailable()))),
    );
    const service: TaskProgressShape = {
      enabled,
      publish: (threadId, rawInput) =>
        Effect.gen(function* () {
          const port = yield* commands;
          const input = yield* Effect.try({
            try: () => normalizeTaskProgressInput(rawInput),
            catch: refused,
          });
          const record = yield* port.write(threadId, input).pipe(Effect.mapError(refused));
          return acknowledge(record?.card ?? null);
        }).pipe(Effect.catchDefect((defect) => Effect.fail(refused(defect)))),
      read: (threadId) =>
        commands.pipe(
          Effect.flatMap((port) => port.read(threadId).pipe(Effect.mapError(refused))),
          Effect.map((record) => record?.card ?? null),
          Effect.catchDefect((defect) => Effect.fail(refused(defect))),
        ),
      bind: (value) =>
        Effect.acquireRelease(Ref.set(bound, value), () =>
          Ref.update(bound, (current) => (current === value ? undefined : current)),
        ),
      claimWriter: (threadId) => {
        claims.set(threadId, (claims.get(threadId) ?? 0) + 1);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          const remaining = (claims.get(threadId) ?? 1) - 1;
          if (remaining > 0) claims.set(threadId, remaining);
          else claims.delete(threadId);
        };
      },
      claimed: (threadId) => claims.has(threadId),
    };
    return service;
  });

/** Without the live layer every call is refused, so nothing is written to a card nobody reads. */
const unavailable: TaskProgressShape = {
  enabled: Effect.succeed(false),
  publish: () => Effect.fail(notAvailable()),
  read: () => Effect.fail(notAvailable()),
  bind: () => Effect.void,
  claimWriter: () => () => {},
  claimed: () => false,
};

/**
 * One service per server, shared by the orchestrator, the provider adapters
 * and the MCP toolkit. Each provides `layer` by this same reference so layer
 * memoization builds it once, as ProviderContinuationRequests does.
 */
export class TaskProgress extends Context.Reference<TaskProgressShape>("t3/exarch/TaskProgress", {
  defaultValue: () => unavailable,
}) {}

export const layer = Layer.effect(
  TaskProgress,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    return yield* makeTaskProgress(
      settings.getSettings.pipe(
        Effect.map((value) => value.enableTaskProgress),
        Effect.orElseSucceed(() => false),
      ),
    );
  }),
);
