import { CommandId, EventId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const now = "2026-09-11T00:00:00.000Z";

/** Strata's session files: carried on create, replaced or cleared on update, absent when never set. */
it.layer(NodeServices.layer)("decider project session files", (it) => {
  it.effect("carries session files on project.create and leaves them absent otherwise", () =>
    Effect.gen(function* () {
      const readModel = createEmptyReadModel(now);
      const withFiles = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-create-with-files"),
          projectId: asProjectId("project-a"),
          title: "Assistant",
          workspaceRoot: "/tmp/assistant",
          sessionFiles: ["SOUL.md", "syntheses/INDEX.md"],
          createdAt: now,
        },
        readModel,
      });
      const created = Array.isArray(withFiles) ? withFiles[0] : withFiles;
      expect(created.type).toBe("project.created");
      expect((created.payload as { sessionFiles?: unknown }).sessionFiles).toEqual([
        "SOUL.md",
        "syntheses/INDEX.md",
      ]);

      const without = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-create-plain"),
          projectId: asProjectId("project-b"),
          title: "Plain",
          workspaceRoot: "/tmp/plain",
          createdAt: now,
        },
        readModel,
      });
      const plain = Array.isArray(without) ? without[0] : without;
      expect("sessionFiles" in (plain.payload as object)).toBe(false);
    }),
  );

  it.effect(
    "replaces the list on project.meta.update, clears it with an empty list, and leaves it alone when absent",
    () =>
      Effect.gen(function* () {
        const initial = createEmptyReadModel(now);
        const readModel = yield* projectEvent(initial, {
          sequence: 1,
          eventId: asEventId("evt-create"),
          aggregateKind: "project",
          aggregateId: asProjectId("project-a"),
          type: "project.created",
          occurredAt: now,
          commandId: CommandId.make("cmd-create"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-create"),
          metadata: {},
          payload: {
            projectId: asProjectId("project-a"),
            title: "Assistant",
            workspaceRoot: "/tmp/assistant",
            defaultModelSelection: null,
            scripts: [],
            sessionFiles: ["SOUL.md"],
            createdAt: now,
            updatedAt: now,
          },
        });
        expect(readModel.projects[0]?.sessionFiles).toEqual(["SOUL.md"]);

        const replaced = yield* decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-replace"),
            projectId: asProjectId("project-a"),
            sessionFiles: ["SOUL.md", "MEMORY.md"],
          },
          readModel,
        });
        const replacedEvent = Array.isArray(replaced) ? replaced[0] : replaced;
        expect((replacedEvent.payload as { sessionFiles?: unknown }).sessionFiles).toEqual([
          "SOUL.md",
          "MEMORY.md",
        ]);
        const afterReplace = yield* projectEvent(readModel, {
          ...replacedEvent,
          sequence: 2,
          eventId: asEventId("evt-replace"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-replace"),
          metadata: {},
        } as never);
        expect(afterReplace.projects[0]?.sessionFiles).toEqual(["SOUL.md", "MEMORY.md"]);

        const cleared = yield* decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-clear"),
            projectId: asProjectId("project-a"),
            sessionFiles: [],
          },
          readModel: afterReplace,
        });
        const clearedEvent = Array.isArray(cleared) ? cleared[0] : cleared;
        const afterClear = yield* projectEvent(afterReplace, {
          ...clearedEvent,
          sequence: 3,
          eventId: asEventId("evt-clear"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear"),
          metadata: {},
        } as never);
        expect(afterClear.projects[0]?.sessionFiles).toEqual([]);

        const untouched = yield* decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-title"),
            projectId: asProjectId("project-a"),
            title: "Renamed",
          },
          readModel: afterReplace,
        });
        const untouchedEvent = Array.isArray(untouched) ? untouched[0] : untouched;
        expect("sessionFiles" in (untouchedEvent.payload as object)).toBe(false);
      }),
  );
});
