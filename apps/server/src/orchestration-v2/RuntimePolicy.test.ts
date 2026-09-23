import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionProjects from "../persistence/Services/ProjectionProjects.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { layerFromProjectRepository, RuntimePolicyV2 } from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const TestLayer = layerFromProjectRepository.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provide(
    Layer.mock(ProjectionProjects.ProjectionProjectRepository)({
      getById: () =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Project",
            workspaceRoot: "/project-root",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            scripts: [],
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
  ),
);

it.layer(TestLayer)("RuntimePolicyV2", (it) => {
  it.effect("uses the project root for local-checkout threads", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-root");
    }),
  );

  it.effect("prefers a provisioned worktree over the project root", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
    }),
  );
});

it.effect("excludes configured session files only for app-owned helpers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "helper-policy-" });
      yield* fs.writeFileString(`${cwd}/IDENTITY.md`, "Named agent identity and personal memory");
      const now = yield* DateTime.now;
      const repository = Layer.mock(ProjectionProjects.ProjectionProjectRepository)({
        getById: () =>
          Effect.succeed(
            Option.some({
              projectId,
              title: "Project",
              workspaceRoot: cwd,
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              autoPull: false,
              scripts: [],
              sessionFiles: ["IDENTITY.md"],
              createdAt: "2026-09-20T00:00:00Z",
              updatedAt: "2026-09-20T00:00:00Z",
              deletedAt: null,
            }),
          ),
      });
      yield* Effect.gen(function* () {
        const policy = yield* RuntimePolicyV2;
        const thread = makeThread({ now, worktreePath: cwd });
        const parent = yield* policy.resolve({ thread, modelSelection });
        assert.include(parent.sessionContext ?? "", "Named agent identity");
        const child = yield* policy.resolve({
          thread: { ...thread, appOwnedHelper: true },
          modelSelection,
        });
        assert.isUndefined(child.sessionContext);
        const native = yield* policy.resolve({
          thread: {
            ...thread,
            lineage: {
              ...thread.lineage,
              relationshipToParent: "subagent",
              parentThreadId: ThreadId.make("parent"),
            },
          },
          modelSelection,
        });
        assert.include(native.sessionContext ?? "", "Named agent identity");
      }).pipe(Effect.provide(layerFromProjectRepository.pipe(Layer.provide(repository))));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("carries the owner's task card setting into each resolved policy", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const policy = yield* RuntimePolicyV2;
    const thread = makeThread({ now: yield* DateTime.now, worktreePath: "/project-worktree" });
    assert.isTrue((yield* policy.resolve({ thread, modelSelection })).taskProgress);
    yield* settings.updateSettings({ enableTaskProgress: false });
    assert.isFalse((yield* policy.resolve({ thread, modelSelection })).taskProgress);
  }).pipe(Effect.provide(TestLayer.pipe(Layer.provideMerge(ServerSettingsService.layerTest())))),
);
