import * as Schema from "effect/Schema";
import {
  CommandId,
  ContextHandoffId,
  ThreadId,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { WorktreeMcpHandoffInput, WorktreeMcpHandoffResult } from "./worktreeMcp.ts";
import { OrchestratorMcpDelegateTaskResult } from "./orchestratorMcp.ts";
export const HandoffPlanInput = Schema.Struct({
  threadId: ThreadId,
  modelSelection: ModelSelection,
  reason: Schema.Literals(["provider_switch", "worktree_move"]),
});
export const HandoffPlan = Schema.Struct({
  threadId: ThreadId,
  required: Schema.Boolean,
  strategy: Schema.Literals(["none", "full_thread_summary", "delta_since_target_last_seen"]),
  coveredRunOrdinals: Schema.NullOr(Schema.Struct({ from: PositiveInt, to: PositiveInt })),
  cutOffRunOrdinals: Schema.Array(PositiveInt),
  maxRecommendedHandoffChars: Schema.NullOr(PositiveInt),
  acceptsSystemContext: Schema.Boolean,
  acceptsDeveloperContext: Schema.Boolean,
});
export type HandoffPlan = typeof HandoffPlan.Type;
export const StartHelperInput = Schema.Struct({
  commandId: CommandId,
  parentThreadId: ThreadId,
  taskType: TrimmedNonEmptyString,
  brief: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  modelOverride: Schema.optional(ModelSelection),
});
export const WorktreeHandoffInput = Schema.Struct({
  threadId: ThreadId,
  ...WorktreeMcpHandoffInput.fields,
});
export const ADOPTION_RPC = {
  getHandoffText: {
    method: "orchestration.getHandoffText",
    input: Schema.Struct({ threadId: ThreadId, handoffId: ContextHandoffId }),
    output: Schema.Struct({ text: Schema.String }),
  },
  getHandoffPlan: {
    method: "orchestration.getHandoffPlan",
    input: HandoffPlanInput,
    output: HandoffPlan,
  },
  startHelper: {
    method: "orchestration.startHelper",
    input: StartHelperInput,
    output: OrchestratorMcpDelegateTaskResult,
  },
  moveToWorktree: {
    method: "orchestration.moveToWorktree",
    input: WorktreeHandoffInput,
    output: WorktreeMcpHandoffResult,
  },
} as const;
export class AdoptionError extends Schema.TaggedError<AdoptionError>()("AdoptionError", {
  message: Schema.String,
}) {}
