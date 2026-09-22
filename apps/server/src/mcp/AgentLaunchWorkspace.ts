import * as Option from "effect/Option";
import { CommandId } from "@t3tools/contracts";
import { CommandReceiptStoreV2 } from "../orchestration-v2/CommandReceiptStore.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as NodeCrypto from "node:crypto";
import type { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "@t3tools/contracts";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";

/** Validate an explicit binding without checking out or switching any branch. */
export const resolveAgentLaunchWorkspace = Effect.fn("mcp.resolveAgentLaunchWorkspace")(function* (
  workspace: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  projectRoot: string,
  identity: string,
) {
  if (workspace.type === "worktree") {
    return {
      ...workspace,
      branch:
        workspace.branch ??
        `agent-launch/${NodeCrypto.createHash("sha256").update(identity).digest("hex").slice(0, 24)}`,
    };
  }
  if (workspace.type === "root" && !workspace.branch) return workspace;
  const git = yield* GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const cwd = workspace.type === "existing_worktree" ? workspace.worktreePath : projectRoot;
  const failure = (detail: string) =>
    new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `Launch workspace ${cwd}: ${detail}`,
    });
  const read = (path: string, args: string[]) =>
    git.execute({ operation: "agent-launch.validate-workspace", cwd: path, args }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.mapError((error) => failure(error.message)),
    );
  const commonDirectory = (path: string) =>
    read(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).pipe(
      Effect.flatMap((directory) => fs.realPath(directory)),
      Effect.mapError(() => failure("cannot resolve the repository directory")),
    );
  if ((yield* commonDirectory(cwd)) !== (yield* commonDirectory(projectRoot))) {
    return yield* failure(`checkout does not belong to project ${projectRoot}`);
  }
  const checkoutRoot = yield* read(cwd, ["rev-parse", "--show-toplevel"]);
  const canonicalCwd = yield* fs
    .realPath(cwd)
    .pipe(Effect.mapError(() => failure("checkout does not exist")));
  if (
    (yield* fs
      .realPath(checkoutRoot)
      .pipe(Effect.mapError(() => failure("cannot resolve checkout root")))) !== canonicalCwd
  ) {
    return yield* failure("supply the checkout root, not a subdirectory");
  }
  const ref = yield* read(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = ref === "HEAD" ? undefined : ref;
  if (workspace.branch && workspace.branch !== branch) {
    return yield* failure(
      `requested branch ${workspace.branch} does not match ${branch ?? "detached HEAD"}`,
    );
  }
  return workspace.type === "root"
    ? { type: "root" as const, ...(branch ? { branch } : {}) }
    : {
        type: "existing_worktree" as const,
        worktreePath: canonicalCwd,
        ...(branch ? { branch } : {}),
      };
});

/** Adopt only this accepted launch's reserved destination, never a matching branch elsewhere. */
export const recoverAgentLaunchWorkspace = Effect.fn("mcp.recoverAgentLaunchWorkspace")(
  function* (input: {
    readonly commandId: import("@t3tools/contracts").CommandId;
    readonly projectId: import("@t3tools/contracts").ProjectId;
    readonly destination: string | undefined;
    readonly branch: string | undefined;
  }) {
    if (!input.destination) return undefined;
    const receipts = yield* CommandReceiptStoreV2;
    const readReceipt = (id: CommandId) =>
      receipts.getByCommandId(id).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `Cannot read workspace receipt ${id}.`,
            }),
        ),
      );
    const workspaceReceipt = yield* readReceipt(CommandId.make(`${input.commandId}:workspace`));
    if (Option.isSome(workspaceReceipt) && workspaceReceipt.value.status === "accepted")
      return undefined;
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(input.destination).pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `Cannot inspect reserved checkout ${input.destination}.`,
          }),
      ),
    );
    if (!exists) return undefined;
    const created = yield* readReceipt(input.commandId);
    if (Option.isNone(created) || created.value.status !== "accepted") {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Reserved checkout ${input.destination} already exists without an accepted launch.`,
      });
    }
    const project = yield* (yield* ProjectService).getById(input.projectId).pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `Cannot read project ${input.projectId}.`,
          }),
      ),
    );
    if (Option.isNone(project))
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Project ${input.projectId} does not exist.`,
      });
    const workspace = yield* resolveAgentLaunchWorkspace(
      {
        type: "existing_worktree",
        worktreePath: input.destination,
        ...(input.branch ? { branch: input.branch } : {}),
      },
      project.value.workspaceRoot,
      input.commandId,
    );
    if (workspace.type !== "existing_worktree") return undefined;
    return { worktreePath: workspace.worktreePath, branch: workspace.branch ?? null };
  },
);
