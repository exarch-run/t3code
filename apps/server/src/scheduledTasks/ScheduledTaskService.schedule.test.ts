import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect("rejects a stale form save after deletion while preserving explicit-id creates", () =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        id: "scheduled-task:edit-after-delete",
        title: "Review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stale-schedule",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const created = yield* service.upsert(input);
      const edit = yield* decodeUpsertInput({ ...input, requireExisting: true, title: "Edited" });
      expect((yield* service.upsert(edit)).task.title).toBe("Edited");
      yield* service.delete({ id: created.task.id });

      const failure = yield* service.upsert(edit).pipe(Effect.flip);
      expect(failure.message).toBe("Schedule task not found.");
      expect((yield* service.list()).tasks).toEqual([]);

      expect((yield* service.upsert(input)).task.id).toBe(created.task.id);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("preserves a due run when a save only pads the scheduled hour", () =>
  Effect.gen(function* () {
    const dueAt = DateTime.makeZonedUnsafe(
      { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) - 1_000);

    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        commandId: "schedule-time-format",
        title: "Morning review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "9:00" },
        projectId: "project-schedule-time-format",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "mcp",
      });
      const created = yield* service.upsert(input);
      const expectedDueAt = DateTime.formatIso(DateTime.toUtc(dueAt));
      expect(created.task.nextRunAt).toBe(expectedDueAt);

      // Cross the due time before the scheduler's first five-second tick.
      yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) + 1_000);
      const update = yield* decodeUpsertInput({
        ...input,
        id: created.task.id,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });
      const updated = yield* service.upsert(update);
      expect(updated.task.nextRunAt).toBe(expectedDueAt);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expectedDueAt);

      const rescheduled = yield* service.upsert({
        ...update,
        schedule: { type: "fixed_time", timeOfDay: "09:30" },
      });
      expect(rescheduled.task.nextRunAt).toBe(
        DateTime.formatIso(DateTime.toUtc(DateTime.add(dueAt, { minutes: 30 }))),
      );
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "reads a fixed time in the task's stored zone and records the engine zone when none is given",
  () =>
    Effect.gen(function* () {
      // Noon UTC on 1 July: 09:00 in Tokyo (UTC+9) has passed, while 09:00 in
      // Kiritimati (UTC+14) on 2 July is still 19:00 UTC on 1 July. The zone,
      // not the machine's clock, decides which day the run lands on.
      yield* TestClock.setTime(Date.parse("2026-07-01T12:00:00.000Z"));
      const dependencies = Layer.mergeAll(
        Scheduler.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadLaunchService)({}),
        Layer.mock(ThreadManagementService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const input = yield* decodeUpsertInput({
          title: "Morning review",
          prompt: "Review the open pull requests.",
          enabled: true,
          schedule: { type: "fixed_time", timeOfDay: "09:00", timeZone: "Asia/Tokyo" },
          projectId: "project-schedule-zone",
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        const tokyo = yield* service.upsert(input);
        expect(tokyo.task.nextRunAt).toBe("2026-07-02T00:00:00.000Z");
        expect(tokyo.task.schedule).toEqual({
          type: "fixed_time",
          timeOfDay: "09:00",
          timeZone: "Asia/Tokyo",
        });

        // Changing only the zone is a schedule change and re-aims the run.
        const kiritimati = yield* service.upsert({
          ...input,
          id: tokyo.task.id,
          schedule: { type: "fixed_time", timeOfDay: "09:00", timeZone: "Pacific/Kiritimati" },
        });
        expect(kiritimati.task.nextRunAt).toBe("2026-07-01T19:00:00.000Z");

        // An edit that omits the zone keeps the stored one rather than the machine's.
        const resaved = yield* service.upsert({
          ...input,
          id: tokyo.task.id,
          title: "Renamed",
          schedule: { type: "fixed_time", timeOfDay: "09:00" },
        });
        expect(resaved.task.schedule).toEqual(kiritimati.task.schedule);
        expect(resaved.task.nextRunAt).toBe("2026-07-01T19:00:00.000Z");

        const unknownZone = yield* service
          .upsert({
            ...input,
            id: tokyo.task.id,
            schedule: { type: "fixed_time", timeOfDay: "09:00", timeZone: "Mars/Olympus" },
          })
          .pipe(Effect.flip);
        expect(unknownZone.message).toBe("Time zone Mars/Olympus is not a known IANA zone name.");

        // A new task without a zone records the engine computer's zone.
        const local = yield* service.upsert({
          ...input,
          schedule: { type: "fixed_time", timeOfDay: "09:00" },
        });
        expect(local.task.schedule.type === "fixed_time" && local.task.schedule.timeZone).toBe(
          DateTime.zoneToString(DateTime.zoneMakeLocal()),
        );
        expect((yield* service.list()).tasks).toHaveLength(2);
      }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
