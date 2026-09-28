import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { layerFromProjectStore, RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import { ProjectServiceLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" } as const;

const TestLayer = Layer.mergeAll(
  ProjectServiceLayerLive,
  ProjectStore.layer,
  layerFromProjectStore.pipe(
    Layer.provide(ProjectStore.layer),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry, {
        getInstance: () => Effect.succeed(undefined),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
  ),
).pipe(
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(
    Layer.succeed(WorkspacePaths.WorkspacePaths, {
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
        Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
    }),
  ),
  Layer.provideMerge(
    Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "project-session-files-" })),
  Layer.provideMerge(NodeServices.layer),
);

const thread = (projectId: ProjectId, now: DateTime.Utc): OrchestrationV2AppThread => {
  const id = ThreadId.make(`thread:${projectId}`);
  return {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId,
    title: "Session files",
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};

/** What the shell and a runtime policy resolve report for one project. */
const reread = Effect.fn("ProjectSessionFilesTest.reread")(function* (projectId: ProjectId) {
  const projects = yield* ProjectService.ProjectService;
  const policy = yield* RuntimePolicyV2;
  const shell = Option.getOrThrow(yield* projects.getShell(projectId));
  const listed = (yield* projects.listShells()).find((row) => row.id === projectId);
  const resolved = yield* policy.resolve({
    thread: thread(projectId, yield* DateTime.now),
    modelSelection,
  });
  return {
    shell: shell.sessionFiles,
    listed: listed?.sessionFiles,
    hasField: "sessionFiles" in shell,
    context: resolved.sessionContext ?? "",
  };
});

it.layer(TestLayer)("project session files on the project store", (it) => {
  it.effect("carry through create, a change and a clear to the shell and the model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "session-files-" });
        yield* fs.writeFileString(`${workspaceRoot}/SOUL.md`, "Soul file text");
        yield* fs.writeFileString(`${workspaceRoot}/NOTES.md`, "Notes file text");
        const projects = yield* ProjectService.ProjectService;
        const projectId = ProjectId.make("project:session-files");

        yield* projects.create({
          commandId: CommandId.make("command:session-files:create"),
          projectId,
          title: "Assistant",
          workspaceRoot,
          sessionFiles: ["SOUL.md"],
        });
        const created = yield* reread(projectId);
        assert.deepEqual(created.shell, ["SOUL.md"]);
        assert.deepEqual(created.listed, ["SOUL.md"]);
        assert.include(created.context, "Soul file text");

        yield* projects.update({
          commandId: CommandId.make("command:session-files:change"),
          projectId,
          sessionFiles: ["NOTES.md"],
        });
        const changed = yield* reread(projectId);
        assert.deepEqual(changed.shell, ["NOTES.md"]);
        assert.deepEqual(changed.listed, ["NOTES.md"]);
        assert.include(changed.context, "Notes file text");
        assert.notInclude(changed.context, "Soul file text");

        // An update that leaves the field out keeps the saved files.
        yield* projects.update({
          commandId: CommandId.make("command:session-files:rename"),
          projectId,
          title: "Renamed",
        });
        assert.deepEqual((yield* reread(projectId)).shell, ["NOTES.md"]);

        yield* projects.update({
          commandId: CommandId.make("command:session-files:clear"),
          projectId,
          sessionFiles: [],
        });
        const cleared = yield* reread(projectId);
        assert.deepEqual(cleared.shell, []);
        assert.deepEqual(cleared.listed, []);
        assert.equal(cleared.context, "");
      }),
    ),
  );

  it.effect("reads a NULL column, as older databases have, as no field", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project:session-files-null");
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, session_files_json, created_at, updated_at, deleted_at
        ) VALUES (${projectId}, 'Older', '/tmp/session-files-null', NULL,
          '[]', NULL, '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z', NULL)
      `;
      const older = yield* reread(projectId);
      assert.isFalse(older.hasField);
      assert.isUndefined(older.listed);
      assert.equal(older.context, "");
      const row = Option.getOrThrow(yield* (yield* ProjectStore.ProjectStoreV2).get(projectId));
      assert.isFalse("sessionFiles" in row);
    }),
  );
});
