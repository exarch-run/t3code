import {
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { resolveAgentLaunchWorkspace } from "../mcp/AgentLaunchWorkspace.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";

type Workspace = OrchestrationV2ThreadLaunchWorkspaceStrategy;

/** Checks an agent's workspace choice for a project, or makes the default when it has none. */
export type ScheduledTaskWorkspaceResolver = (
  projectId: ProjectId,
  requested: Workspace | undefined,
) => Effect.Effect<Workspace, OrchestratorMcpFailure>;

const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/**
 * Built by the schedule tool handlers, which carry the project and git
 * services, and passed to the orchestrator service. The default for a fresh
 * chat per run is a new worktree from the project's current local branch,
 * not fetched: the owner works locally, so origin can be far behind.
 */
export const makeScheduledTaskWorkspaceResolver = Effect.gen(function* () {
  const projects = yield* ProjectService;
  const git = yield* GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation: "scheduled-task.workspace", cwd, args, allowNonZeroExit: true })
      .pipe(Effect.mapError((error) => failure(`Git failed in ${cwd}: ${error.message}`)));

  const resolver: ScheduledTaskWorkspaceResolver = (projectId, requested) =>
    Effect.gen(function* () {
      const project = yield* projects
        .getById(projectId)
        .pipe(Effect.mapError(() => failure(`Cannot read project ${projectId}.`)));
      if (Option.isNone(project)) return yield* failure(`Project ${projectId} does not exist.`);
      const root = project.value.workspaceRoot;
      if (requested === undefined) {
        const head = yield* run(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
        const branch = head.stdout.trim();
        if (head.exitCode !== 0 || branch.length === 0) {
          return yield* failure(
            `Project folder ${root} has no current local branch to start runs from. Pass workspaceStrategy.`,
          );
        }
        return { type: "worktree", baseRef: branch };
      }
      if (requested.type !== "worktree") {
        return yield* resolveAgentLaunchWorkspace(requested, root, "scheduled-task").pipe(
          Effect.provideService(GitVcsDriver, git),
          Effect.provideService(FileSystem.FileSystem, fs),
        );
      }
      if (requested.branch !== undefined) {
        return yield* failure(
          `Each run makes its own worktree branch, so a fixed branch ${requested.branch} would fail from the second run. Omit branch.`,
        );
      }
      // A ref fetched from origin may exist only there; the launch falls back
      // to the local ref when origin lacks it.
      if (requested.startFromOrigin !== true) {
        const local = yield* run(root, [
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `${requested.baseRef}^{commit}`,
        ]);
        if (local.exitCode !== 0) {
          return yield* failure(
            `Branch or ref ${requested.baseRef} does not exist in ${root}. Name a local branch, or set startFromOrigin to fetch it.`,
          );
        }
      }
      return {
        type: "worktree",
        baseRef: requested.baseRef,
        ...(requested.startFromOrigin === true ? { startFromOrigin: true } : {}),
      };
    });
  return resolver;
});

/**
 * The workspace a created or updated schedule saves. A bound task posts into
 * its thread, which already has a workspace, so a requested one is refused
 * rather than stored unused. `keep` is the stored workspace when the task
 * keeps its binding, so rebinding never reuses a strategy meant for the other
 * kind of run and a no-op rebind never resets the owner's choice.
 */
export const chooseScheduledTaskWorkspace = (input: {
  readonly bound: boolean;
  readonly requested: Workspace | undefined;
  readonly keep: Workspace | undefined;
  readonly projectId: ProjectId;
  readonly resolve: ScheduledTaskWorkspaceResolver;
}): Effect.Effect<Workspace, OrchestratorMcpFailure> => {
  if (input.bound) {
    return input.requested === undefined
      ? Effect.succeed(input.keep ?? { type: "root" })
      : Effect.fail(
          failure(
            "workspaceStrategy applies only to a fresh chat per run. Pass bindToCurrentThread=false with it, or omit it.",
          ),
        );
  }
  if (input.requested === undefined && input.keep !== undefined) return Effect.succeed(input.keep);
  return input.resolve(input.projectId, input.requested);
};
