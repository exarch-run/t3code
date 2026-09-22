import { ExitCode } from "effect/unstable/process/ChildProcessSpawner";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { resolveAgentLaunchWorkspace } from "./AgentLaunchWorkspace.ts";
import * as Layer from "effect/Layer";

it.effect("validates repository, checkout root and branch without switching a checkout", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "launch-workspace-" });
    for (const dir of ["repo/.git", "copy/subdir", "other/.git"])
      yield* fs.makeDirectory(`${root}/${dir}`, { recursive: true });
    const git = Layer.mock(GitVcsDriver)({
      execute: (input) => {
        assert.equal(input.args[0], "rev-parse");
        const other = input.cwd.includes("/other");
        const value = input.args.includes("--git-common-dir")
          ? `${root}/${other ? "other" : "repo"}/.git`
          : input.args.includes("--show-toplevel")
            ? `${root}/copy`
            : "feature/work";
        return Effect.succeed({
          stdout: value,
          stderr: "",
          exitCode: ExitCode(0),
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
    });
    yield* Effect.gen(function* () {
      const valid = yield* resolveAgentLaunchWorkspace(
        { type: "existing_worktree", worktreePath: `${root}/copy` },
        `${root}/repo`,
        "request",
      );
      assert.deepEqual(valid, {
        type: "existing_worktree",
        worktreePath: `${root}/copy`,
        branch: "feature/work",
      });
      for (const workspace of [
        { type: "existing_worktree" as const, worktreePath: `${root}/other` },
        { type: "existing_worktree" as const, worktreePath: `${root}/copy/subdir` },
        {
          type: "existing_worktree" as const,
          worktreePath: `${root}/copy`,
          branch: "wrong-branch",
        },
      ]) {
        assert.equal(
          (yield* resolveAgentLaunchWorkspace(workspace, `${root}/repo`, "request").pipe(
            Effect.result,
          ))._tag,
          "Failure",
        );
      }
    }).pipe(Effect.provide(git));
  }).pipe(Effect.provide(NodeServices.layer)),
);
