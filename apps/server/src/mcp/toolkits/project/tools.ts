import { GitVcsDriver } from "../../../vcs/GitVcsDriver.ts";
import {
  AgentThreadLaunchInput,
  AgentThreadLaunchResult,
  NonNegativeInt,
  Project,
  ProjectCreatePayload,
  ProjectUpdatePayload,
  ProjectId,
  OrchestratorMcpFailure,
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
} from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CommandReceiptStoreV2 } from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as FileSystem from "effect/FileSystem";
import { ServerConfig } from "../../../config.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ProviderAdapterRegistryV2 } from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import { ThreadLaunchService } from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { ProjectService } from "../../../project/ProjectService.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { SourceControlRepositoryService } from "../../../sourceControl/SourceControlRepositoryService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const shared = {
  success: Project,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext, ThreadManagementService, ProjectService, Crypto.Crypto],
};
const ProjectListTool = Tool.make("t3_project_list", {
  ...shared,
  description:
    "List registered projects in this environment. Pages use the current project snapshot and may shift between calls.",
  parameters: Schema.Struct({
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    projects: Schema.Array(Project),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectReadTool = Tool.make("t3_project_read", {
  ...shared,
  description:
    "Read a registered project in this environment, including its workspace and saved scripts.",
  parameters: Schema.Struct({ projectId: ProjectId }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectCreateTool = Tool.make("t3_project_create", {
  ...shared,
  description:
    "Register a project directory through the existing project service. Set createWorkspaceRootIfMissing to create a directory. Each call creates a new request; an existing registered workspace is rejected. Clone separately with t3_project_clone when needed.",
  parameters: ProjectCreatePayload,
}).annotate(Tool.Destructive, true);
const ProjectUpdateTool = Tool.make("t3_project_update", {
  ...shared,
  description:
    "Update a registered project's settings. Omitted fields are preserved. Uses the same project service as the app.",
  parameters: Schema.Struct({ projectId: ProjectId, ...ProjectUpdatePayload.fields }),
}).annotate(Tool.Destructive, true);
const ProjectDeleteTool = Tool.make("t3_project_delete", {
  ...shared,
  description:
    "Delete a project using the existing project deletion lifecycle. Nonempty projects require force=true. This does not delete the repository directory or promise a deleted-thread count.",
  parameters: Schema.Struct({ projectId: ProjectId, force: Schema.optionalKey(Schema.Boolean) }),
}).annotate(Tool.Destructive, true);
const ProjectCloneTool = Tool.make("t3_project_clone", {
  ...shared,
  description:
    "Clone a repository using the app's source-control service. This only clones; register the returned cwd with t3_project_create. An existing destination is not adopted or removed on failure.",
  parameters: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  dependencies: [...shared.dependencies, SourceControlRepositoryService],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
export const ThreadLaunchTool = Tool.make("t3_thread_launch", {
  ...shared,
  description:
    "Create one or several ordinary chats through one launch request. Use only when the user requests separate chats or independent work; this is not delegation. For subagents, call delegate_task. Provide requestId and a threads list, with a stable entryId and title for each chat. Reuse the same requestId and inputs after a lost response; changed inputs are refused. Omitted project/model/modes and workspace inherit the caller. workspaceStrategy may explicitly select root, existing_worktree, or a new worktree. A different project requires an explicit workspace. Each chat records its creator for automatic grouping without opening tabs. Workspace preparation finishes before its agent starts. Results are per entry; preparing is not completed work. Pending uploads only. Requires a full-access/default caller.",
  parameters: AgentThreadLaunchInput,
  success: AgentThreadLaunchResult,
  dependencies: [
    ...shared.dependencies,
    ThreadLaunchService,
    GitVcsDriver,
    ProviderRegistry,
    ProviderAdapterRegistryV2,
    CommandReceiptStoreV2,
    SqlClient.SqlClient,
    FileSystem.FileSystem,
    ServerConfig,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ProjectToolkit = Toolkit.make(
  ThreadLaunchTool,
  ProjectListTool,
  ProjectReadTool,
  ProjectCreateTool,
  ProjectUpdateTool,
  ProjectDeleteTool,
  ProjectCloneTool,
);
