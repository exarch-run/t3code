/**
 * Version 1 readers and the canonical version 2 record. A desktop that
 * negotiated version 1 keeps receiving the event type and card shape it
 * shipped with; the server projects each version 2 change into that shape
 * or, when the shape cannot carry it, into a fresh thread snapshot with the
 * card omitted, which the shipped reader already treats as "no card".
 */
import type {
  OrchestrationEvent,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadStreamItem,
  TaskProgressCard,
  TaskProgressCardV2,
  TaskProgressRecordV2,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export type TaskProgressReaderVersion = 1 | 2 | undefined;

export interface LegacyTurnFacts {
  readonly turnId: string;
  readonly state: string;
  readonly completedAt: string | null;
}

// The shipped version 1 reader's own limits (Strata src/shared/task-progress.ts
// at 0.0.41-strata.6): markdown at most 8192 UTF-8 bytes, at most 50 steps of
// 1–500 code points, at most one in_progress step, and a non-empty card.
const LEGACY_MARKDOWN_MAX_BYTES = 8192;
const LEGACY_MAX_STEPS = 50;
const LEGACY_STEP_MAX_CODE_POINTS = 500;

export function legacyRepresentable(card: TaskProgressCardV2): boolean {
  const steps = card.steps ?? [];
  if (
    card.markdown !== undefined &&
    Buffer.byteLength(card.markdown, "utf8") > LEGACY_MARKDOWN_MAX_BYTES
  )
    return false;
  if (steps.length > LEGACY_MAX_STEPS) return false;
  if (
    steps.some(
      (step) => step.step.length === 0 || [...step.step].length > LEGACY_STEP_MAX_CODE_POINTS,
    )
  )
    return false;
  if (steps.filter((step) => step.status === "in_progress").length > 1) return false;
  return Boolean(card.markdown?.trim()) || steps.length > 0;
}

const legacyOutcome = (turn: LegacyTurnFacts): TaskProgressCard["outcome"] =>
  turn.state === "error"
    ? "failed"
    : turn.state === "interrupted"
      ? "stopped"
      : turn.state === "completed"
        ? "completed"
        : null;

/**
 * The version 1 card for a record, or null when the reader could not decode
 * it: a cleared card, content outside the old limits, or a write that landed
 * with no run to attribute it to. The turn is real history, used only here.
 */
export function legacyCardFor(
  record: TaskProgressRecordV2,
  turn: LegacyTurnFacts | null,
): TaskProgressCard | null {
  const card = record.card;
  if (!card || !turn || turn.turnId !== record.turnId || !legacyRepresentable(card)) return null;
  const outcome = legacyOutcome(turn);
  return {
    version: 1,
    revision: card.revision,
    generation: record.generation,
    markdown: card.markdown ?? null,
    plan: (card.steps ?? []).map((step) => ({ text: step.step, status: step.status })),
    runId: turn.turnId,
    providerTurnId: turn.turnId,
    updatedAt: card.updatedAt,
    outcome,
    endedAt: outcome ? turn.completedAt : null,
  };
}

/** The canonical record for a version 1 card from stored history. */
export function recordFromLegacyCard(card: TaskProgressCard): TaskProgressRecordV2 {
  const steps = card.plan.map((step) => ({ step: step.text, status: step.status }));
  return {
    card: {
      version: 2,
      revision: card.revision,
      updatedAt: card.updatedAt,
      ...(card.markdown ? { markdown: card.markdown } : {}),
      ...(steps.length > 0 ? { steps } : {}),
    },
    revision: card.revision,
    updatedAt: card.updatedAt,
    generation: card.generation,
    turnId: card.runId,
  };
}

export const isTaskProgressEvent = (event: OrchestrationEvent): boolean =>
  event.type === "thread.task-progress-updated" || event.type === "thread.task-progress-v2-updated";

/** Whether a thread subscription with this negotiated version receives progress events at all. */
export const progressEventWanted = (
  event: OrchestrationEvent,
  version: TaskProgressReaderVersion,
): boolean => !isTaskProgressEvent(event) || version !== undefined;

export interface TranslationSources {
  /** The turn facts the version 1 projection needs, by turn id. */
  readonly turn: (
    threadId: ThreadId,
    turnId: string,
  ) => Effect.Effect<LegacyTurnFacts | null, never>;
  /** A fresh detail snapshot for the thread, when an event cannot be expressed to the reader. */
  readonly snapshot: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationThreadDetailSnapshot | null, never>;
}

/**
 * Translate one stream item for a reader. Version 2 readers get version 1
 * history as version 2 events. Version 1 readers get a version 2 change as a
 * version 1 event when its card fits, otherwise a replacement snapshot whose
 * sequence advances the reader past the change; a null result drops the item.
 */
export const translateTaskProgressItem = (
  item: OrchestrationThreadStreamItem,
  version: TaskProgressReaderVersion,
  sources: TranslationSources,
): Effect.Effect<OrchestrationThreadStreamItem | null, never> =>
  Effect.gen(function* () {
    if (item.kind !== "event" || !isTaskProgressEvent(item.event)) return item;
    const event = item.event;
    if (version === undefined) return null;
    if (version === 2) {
      if (event.type !== "thread.task-progress-updated") return item;
      return {
        kind: "event" as const,
        event: {
          ...event,
          type: "thread.task-progress-v2-updated" as const,
          payload: {
            threadId: event.payload.threadId,
            record: recordFromLegacyCard(event.payload.card),
          },
        },
      };
    }
    if (event.type !== "thread.task-progress-v2-updated") return item;
    const record = event.payload.record;
    const turn = record.turnId ? yield* sources.turn(event.payload.threadId, record.turnId) : null;
    const card = legacyCardFor(record, turn);
    if (card) {
      return {
        kind: "event" as const,
        event: {
          ...event,
          type: "thread.task-progress-updated" as const,
          payload: { threadId: event.payload.threadId, card, digest: "" },
        },
      };
    }
    const snapshot = yield* sources.snapshot(event.payload.threadId);
    return snapshot ? { kind: "snapshot" as const, snapshot } : null;
  });
