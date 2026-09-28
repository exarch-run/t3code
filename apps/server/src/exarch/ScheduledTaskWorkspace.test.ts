import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  chooseScheduledTaskWorkspace,
  makeScheduledTaskWorkspaceResolver,
} from "./ScheduledTaskWorkspace.ts";

const projectId = ProjectId.make("project-schedule-workspace");
const gitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-schedule-workspace-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);
const projectAt = (workspaceRoot: string) =>
  Layer.mock(ProjectService)({
    getById: (id) =>
      Effect.succeed(
        id === projectId
          ? Option.some({
              id,
              title: "Schedules",
              workspaceRoot,
              repositoryIdentity: null,
              faviconPath: null,
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              scripts: [],
              createdAt: "2026-09-27T00:00:00.000Z",
              updatedAt: "2026-09-27T00:00:00.000Z",
              deletedAt: null,
            })
          : Option.none(),
      ),
  });
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return yield* driver.execute({ operation: "ScheduledTaskWorkspace.test", cwd, args });
  });
const failureMessage = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => error.message),
    Effect.orElseSucceed(() => "succeeded"),
  );

it.effect("defaults to the project's current local branch and checks named refs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-schedule-workspace-" });
      yield* git(root, ["init", "--initial-branch=master"]);
      yield* git(root, ["config", "user.email", "test@example.com"]);
      yield* git(root, ["config", "user.name", "Test User"]);
      yield* git(root, ["commit", "--allow-empty", "-m", "first"]);

      yield* Effect.gen(function* () {
        const resolve = yield* makeScheduledTaskWorkspaceResolver;
        assert.deepEqual(yield* resolve(projectId, undefined), {
          type: "worktree",
          baseRef: "master",
        });
        yield* git(root, ["checkout", "-b", "feature/local-only"]);
        assert.deepEqual(yield* resolve(projectId, undefined), {
          type: "worktree",
          baseRef: "feature/local-only",
        });

        assert.deepEqual(yield* resolve(projectId, { type: "worktree", baseRef: "master" }), {
          type: "worktree",
          baseRef: "master",
        });
        assert.include(
          yield* failureMessage(resolve(projectId, { type: "worktree", baseRef: "main" })),
          "Branch or ref main does not exist",
        );
        assert.deepEqual(
          yield* resolve(projectId, { type: "worktree", baseRef: "main", startFromOrigin: true }),
          { type: "worktree", baseRef: "main", startFromOrigin: true },
        );
        assert.include(
          yield* failureMessage(
            resolve(projectId, { type: "worktree", baseRef: "master", branch: "nightly" }),
          ),
          "Omit branch",
        );
        assert.deepEqual(yield* resolve(projectId, { type: "root" }), { type: "root" });

        yield* git(root, ["checkout", "--detach"]);
        assert.include(
          yield* failureMessage(resolve(projectId, undefined)),
          "has no current local branch",
        );
      }).pipe(Effect.provide(projectAt(root)));
    }),
  ).pipe(Effect.provide(gitLayer)),
);

it.effect("keeps, refuses, or resolves a workspace by where runs land", () =>
  Effect.gen(function* () {
    const resolved = { type: "worktree" as const, baseRef: "master" };
    const kept = { type: "worktree" as const, baseRef: "release", startFromOrigin: true };
    const resolve = () => Effect.succeed(resolved);
    const choose = (
      input: Omit<Parameters<typeof chooseScheduledTaskWorkspace>[0], "projectId" | "resolve">,
    ) => chooseScheduledTaskWorkspace({ ...input, projectId, resolve });

    assert.include(
      yield* failureMessage(choose({ bound: true, requested: resolved, keep: undefined })),
      "only to a fresh chat per run",
    );
    assert.deepEqual(yield* choose({ bound: true, requested: undefined, keep: undefined }), {
      type: "root",
    });
    assert.deepEqual(yield* choose({ bound: false, requested: undefined, keep: kept }), kept);
    assert.deepEqual(
      yield* choose({ bound: false, requested: undefined, keep: undefined }),
      resolved,
    );
    assert.deepEqual(
      yield* choose({ bound: false, requested: { type: "root" }, keep: kept }),
      resolved,
    );
  }),
);
