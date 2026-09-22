import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ProjectId, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ChatFileAttachment, ChatImageAttachment } from "./chatAttachment.ts";
import {
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

const RequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export const AgentThreadLaunchEntry = Schema.Struct({
  entryId: RequestId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  projectId: Schema.optional(ProjectId),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  workspaceStrategy: Schema.optional(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("inherit") }),
      OrchestrationV2ThreadLaunchWorkspaceStrategy,
    ]),
  ),
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(120000))),
  attachments: Schema.optional(
    Schema.Array(
      Schema.Union([ChatImageAttachment.mapFields(Struct.omit(["source"])), ChatFileAttachment]),
    ).check(Schema.isMaxLength(8)),
  ),
});
export const AgentThreadLaunchInput = Schema.Struct({
  requestId: RequestId,
  threads: Schema.Array(AgentThreadLaunchEntry).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
});
export type AgentThreadLaunchInput = typeof AgentThreadLaunchInput.Type;

export const AgentThreadLaunchResult = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      entryId: RequestId,
      title: Schema.String,
      threadId: Schema.NullOr(ThreadId),
      projectId: ProjectId,
      modelSelection: ModelSelection,
      runId: Schema.NullOr(RunId),
      status: Schema.Union([Schema.Literal("idle"), OrchestrationV2RunStatus]),
      preparationStatus: Schema.Literals(["preparing", "ready", "failed"]),
      workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
      worktreePath: Schema.NullOr(Schema.String),
      branch: Schema.NullOr(Schema.String),
      error: Schema.NullOr(Schema.String),
    }),
  ),
});
export type AgentThreadLaunchResult = typeof AgentThreadLaunchResult.Type;
