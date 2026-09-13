import type { OrchestrationThreadStreamItem, TaskProgressRecordV2 } from "@t3tools/contracts";
import { EventId, ThreadId, TaskProgressCard } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  legacyCardFor,
  legacyRepresentable,
  progressEventWanted,
  recordFromLegacyCard,
  translateTaskProgressItem,
} from "./TaskProgressCompatibility.ts";

const threadId = ThreadId.make("thread-1");
const record: TaskProgressRecordV2 = {
  card: {
    version: 2,
    revision: 3,
    updatedAt: "2026-09-12T10:00:00.000Z",
    markdown: "**Focused change**",
    steps: [
      { step: "Inspect the route", status: "completed" },
      { step: "Wire the checklist", status: "in_progress" },
    ],
  },
  revision: 3,
  updatedAt: "2026-09-12T10:00:00.000Z",
  generation: "2026-09-01T00:00:00.000Z",
  turnId: "turn-1",
};
const runningTurn = { turnId: "turn-1", state: "running", completedAt: null };
const decodeLegacy = Schema.decodeUnknownSync(TaskProgressCard);

const event = (
  type: "thread.task-progress-v2-updated" | "thread.task-progress-updated",
  payload: unknown,
  sequence = 10,
): OrchestrationThreadStreamItem =>
  ({
    kind: "event",
    event: {
      sequence,
      eventId: EventId.make(`event-${sequence}`),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: "2026-09-12T10:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type,
      payload,
    },
  }) as OrchestrationThreadStreamItem;

describe("version 1 projection", () => {
  it("projects a card with its real turn into the shipped shape", () => {
    const legacy = legacyCardFor(record, runningTurn);
    expect(legacy).toEqual({
      version: 1,
      revision: 3,
      generation: record.generation,
      markdown: "**Focused change**",
      plan: [
        { text: "Inspect the route", status: "completed" },
        { text: "Wire the checklist", status: "in_progress" },
      ],
      runId: "turn-1",
      providerTurnId: "turn-1",
      updatedAt: record.updatedAt,
      outcome: null,
      endedAt: null,
    });
    expect(() => decodeLegacy(legacy)).not.toThrow();
    expect(
      legacyCardFor(record, {
        turnId: "turn-1",
        state: "completed",
        completedAt: "2026-09-12T10:05:00.000Z",
      }),
    ).toMatchObject({
      outcome: "completed",
      endedAt: "2026-09-12T10:05:00.000Z",
    });
    expect(
      legacyCardFor(record, { turnId: "turn-1", state: "interrupted", completedAt: "x" })?.outcome,
    ).toBe("stopped");
    expect(
      legacyCardFor(record, { turnId: "turn-1", state: "error", completedAt: "x" })?.outcome,
    ).toBe("failed");
  });

  it("omits the version 1 card for clears, missing turns and content the old reader cannot hold", () => {
    expect(legacyCardFor({ ...record, card: null }, runningTurn)).toBeNull();
    expect(legacyCardFor({ ...record, turnId: null }, null)).toBeNull();
    expect(legacyCardFor(record, { ...runningTurn, turnId: "turn-2" })).toBeNull();
    const wide = {
      ...record.card!,
      steps: [{ step: "a".repeat(512), status: "pending" as const }],
    };
    expect(legacyRepresentable(wide)).toBe(false);
    expect(legacyCardFor({ ...record, card: wide }, runningTurn)).toBeNull();
    expect(
      legacyRepresentable({
        ...record.card!,
        steps: [{ step: "😀".repeat(300), status: "pending" }],
      }),
    ).toBe(true);
    const { steps: _steps, ...noSteps } = record.card!;
    expect(legacyRepresentable({ ...noSteps, markdown: "   " })).toBe(false);
  });

  it("round-trips version 1 history into the canonical record", () => {
    const legacy = legacyCardFor(record, runningTurn)!;
    expect(recordFromLegacyCard(legacy)).toEqual(record);
  });
});

describe("translateTaskProgressItem", () => {
  const sources = {
    turn: (_threadId: string, turnId: string) =>
      Effect.succeed(turnId === "turn-1" ? runningTurn : null),
    snapshot: () => Effect.succeed({ snapshotSequence: 12, thread: { id: threadId } } as never),
  };

  it("gives readers only the version they negotiated", () => {
    const v2 = event("thread.task-progress-v2-updated", { threadId, record });
    expect(progressEventWanted(v2.kind === "event" ? v2.event : (null as never), undefined)).toBe(
      false,
    );
    expect(progressEventWanted(v2.kind === "event" ? v2.event : (null as never), 1)).toBe(true);
    expect(Effect.runSync(translateTaskProgressItem(v2, undefined, sources))).toBeNull();
    expect(Effect.runSync(translateTaskProgressItem(v2, 2, sources))).toBe(v2);
    const other: OrchestrationThreadStreamItem = { kind: "synchronized" };
    expect(Effect.runSync(translateTaskProgressItem(other, 1, sources))).toBe(other);
  });

  it("turns a representable change into the version 1 event at the same sequence", () => {
    const item = Effect.runSync(
      translateTaskProgressItem(
        event("thread.task-progress-v2-updated", { threadId, record }),
        1,
        sources,
      ),
    );
    expect(item?.kind).toBe("event");
    if (item?.kind !== "event") return;
    expect(item.event.type).toBe("thread.task-progress-updated");
    expect(item.event.sequence).toBe(10);
    expect(item.event.payload).toMatchObject({ threadId, card: { version: 1, revision: 3 } });
  });

  it("replaces a clear or an unrepresentable change with a snapshot that advances the reader", () => {
    const cleared = Effect.runSync(
      translateTaskProgressItem(
        event("thread.task-progress-v2-updated", {
          threadId,
          record: { ...record, card: null, revision: 4 },
        }),
        1,
        sources,
      ),
    );
    expect(cleared).toEqual({
      kind: "snapshot",
      snapshot: { snapshotSequence: 12, thread: { id: threadId } },
    });
    const wide = Effect.runSync(
      translateTaskProgressItem(
        event("thread.task-progress-v2-updated", {
          threadId,
          record: {
            ...record,
            card: { ...record.card!, steps: [{ step: "a".repeat(512), status: "pending" }] },
          },
        }),
        1,
        sources,
      ),
    );
    expect(wide?.kind).toBe("snapshot");
    const gone = Effect.runSync(
      translateTaskProgressItem(
        event("thread.task-progress-v2-updated", { threadId, record: { ...record, card: null } }),
        1,
        { ...sources, snapshot: () => Effect.succeed(null) },
      ),
    );
    expect(gone).toBeNull();
  });

  it("lifts version 1 history to version 2 readers", () => {
    const legacy = legacyCardFor(record, runningTurn)!;
    const item = Effect.runSync(
      translateTaskProgressItem(
        event("thread.task-progress-updated", { threadId, card: legacy, digest: "d" }),
        2,
        sources,
      ),
    );
    expect(item?.kind).toBe("event");
    if (item?.kind !== "event") return;
    expect(item.event.type).toBe("thread.task-progress-v2-updated");
    expect(item.event.payload).toEqual({ threadId, record });
  });
});
