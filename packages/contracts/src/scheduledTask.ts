import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/** 24-hour "HH:MM" wall-clock time. Mirrors `parseTimeOfDay` on the server. */
const TimeOfDay = TrimmedNonEmptyString.check(
  Schema.isPattern(/^([01]?\d|2[0-3]):([0-5]\d)$/),
).annotate({ description: "Local wall-clock time in 24-hour HH:MM form, such as 09:30." });

export const MIN_SCHEDULED_TASK_INTERVAL_MS = 60_000;

const ScheduledTaskIntervalMs = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  description: "Positive interval in milliseconds.",
});

const ScheduledTaskIntervalSchedule = Schema.Struct({
  type: Schema.Literal("interval").annotate({
    description: "Select interval scheduling.",
  }),
  everyMs: ScheduledTaskIntervalMs,
}).annotate({
  description: "Run repeatedly after a fixed number of milliseconds.",
});

/** IANA zone name. Validated against the runtime's zone database on the server. */
const ScheduledTaskTimeZone = TrimmedNonEmptyString.annotate({
  description:
    "IANA time zone name such as America/Chicago in which timeOfDay is read. Omit to keep the zone already stored on this task, or to record the engine computer's zone for a new task. The saved task always reports the zone in use.",
});

const ScheduledTaskFixedTimeSchedule = Schema.Struct({
  type: Schema.Literal("fixed_time").annotate({
    description: "Select a fixed wall-clock time in the schedule's time zone.",
  }),
  timeOfDay: TimeOfDay,
  weekdays: Schema.optional(
    Schema.Array(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })).annotate({
        description: "Weekday number where 0 is Sunday and 6 is Saturday.",
      }),
    ).annotate({
      description: "Optional weekdays; omit to run every day.",
    }),
  ),
  timeZone: Schema.optional(ScheduledTaskTimeZone),
}).annotate({
  description:
    "Run at a fixed wall-clock time on selected weekdays, in the stored time zone. A run missed by more than ten minutes (engine off or asleep) is skipped and recorded, never replayed.",
});

/**
 * Read model for persisted schedules. Keep accepting legacy sub-minute rows so
 * users can list, disable, edit, or delete them after the write minimum changes.
 */
export const ScheduledTaskSchedule = Schema.Union([
  ScheduledTaskIntervalSchedule,
  ScheduledTaskFixedTimeSchedule,
]).annotate({
  description:
    "Structured recurring schedule. Pass an object with type 'interval' or 'fixed_time'.",
});
export type ScheduledTaskSchedule = typeof ScheduledTaskSchedule.Type;

/** Mutation model: newly created or updated interval schedules run at most once per minute. */
export const ScheduledTaskUpsertSchedule = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("interval").annotate({
      description: "Select interval scheduling.",
    }),
    everyMs: ScheduledTaskIntervalMs.check(
      Schema.isGreaterThanOrEqualTo(MIN_SCHEDULED_TASK_INTERVAL_MS),
    ).annotate({
      description: "Interval in milliseconds, with a minimum of 60000 (one minute).",
    }),
  }).annotate({
    description: "Run repeatedly after a fixed number of milliseconds.",
  }),
  ScheduledTaskFixedTimeSchedule,
]).annotate({
  description: "Writable recurring schedule. Pass an object with type 'interval' or 'fixed_time'.",
});
export type ScheduledTaskUpsertSchedule = typeof ScheduledTaskUpsertSchedule.Type;

export const ScheduledTaskRunStatus = Schema.Literals(["never", "running", "succeeded", "failed"]);
export type ScheduledTaskRunStatus = typeof ScheduledTaskRunStatus.Type;

/**
 * What happened the last time the task came due. `ran` means the prompt was
 * dispatched into its chat (the provider turn may still be in progress);
 * `skipped_overlap` means the previous run was still active; `skipped_missed`
 * means a fixed-time slot passed while the engine was off; `failed` carries
 * the dispatch error. Skips do not count toward runCount.
 */
export const ScheduledTaskRunOutcomeKind = Schema.Literals([
  "ran",
  "skipped_overlap",
  "skipped_missed",
  "failed",
]);
export type ScheduledTaskRunOutcomeKind = typeof ScheduledTaskRunOutcomeKind.Type;

export const ScheduledTaskRunOutcome = Schema.Struct({
  kind: ScheduledTaskRunOutcomeKind,
  at: IsoDateTime.annotate({ description: "When the outcome was recorded." }),
  message: Schema.NullOr(Schema.String).annotate({
    description: "Why the run was skipped or failed; null when it ran.",
  }),
}).annotate({
  description:
    "Last outcome for the task: ran (dispatched into its chat), skipped_overlap (previous run still active, nothing queued), skipped_missed (fixed-time slot passed while the engine was off, not replayed), or failed (dispatch error, no automatic retry).",
});
export type ScheduledTaskRunOutcome = typeof ScheduledTaskRunOutcome.Type;

export const ScheduledTask = Schema.Struct({
  id: ScheduledTaskId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskSchedule,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  startClean: Schema.optional(Schema.Boolean),
  pluginId: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,79}$/))),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  lastRunError: Schema.NullOr(Schema.String),
  runCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Absent until the task first comes due. */
  lastOutcome: Schema.optional(ScheduledTaskRunOutcome),
});
export type ScheduledTask = typeof ScheduledTask.Type;

export const ScheduledTaskListInput = Schema.Struct({});
export type ScheduledTaskListInput = typeof ScheduledTaskListInput.Type;

export const ScheduledTaskListResult = Schema.Struct({
  tasks: Schema.Array(ScheduledTask),
});
export type ScheduledTaskListResult = typeof ScheduledTaskListResult.Type;

export const ScheduledTaskUpsertInput = Schema.Struct({
  id: Schema.optional(ScheduledTaskId),
  requireExisting: Schema.optional(Schema.Boolean).annotate({
    description: "Reject the save if the task no longer exists, for edits from a client form.",
  }),
  commandId: Schema.optional(CommandId),
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskUpsertSchedule,
  projectId: ProjectId,
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  startClean: Schema.optional(Schema.Boolean),
  pluginId: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,79}$/))),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: Schema.optional(OrchestrationV2Actor),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
});
export type ScheduledTaskUpsertInput = typeof ScheduledTaskUpsertInput.Type;

/** Partial update that flips only the enabled flag — never overwrites other fields. */
export const ScheduledTaskSetEnabledInput = Schema.Struct({
  id: ScheduledTaskId,
  enabled: Schema.Boolean,
});
export type ScheduledTaskSetEnabledInput = typeof ScheduledTaskSetEnabledInput.Type;

export const ScheduledTaskDeleteInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskDeleteInput = typeof ScheduledTaskDeleteInput.Type;

export const ScheduledTaskRunNowInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskRunNowInput = typeof ScheduledTaskRunNowInput.Type;

export const ScheduledTaskMutationResult = Schema.Struct({
  task: ScheduledTask,
});
export type ScheduledTaskMutationResult = typeof ScheduledTaskMutationResult.Type;

export const ScheduledTaskDeleteResult = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskDeleteResult = typeof ScheduledTaskDeleteResult.Type;

export const ScheduledTaskRunNowResult = Schema.Struct({
  task: ScheduledTask,
});
export type ScheduledTaskRunNowResult = typeof ScheduledTaskRunNowResult.Type;

export class ScheduledTaskError extends Schema.TaggedError<ScheduledTaskError>()(
  "ScheduledTaskError",
  {
    message: Schema.String,
    taskId: Schema.optional(ScheduledTaskId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
