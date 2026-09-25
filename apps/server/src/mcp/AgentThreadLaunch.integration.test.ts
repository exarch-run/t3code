import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ExitCode } from "effect/unstable/process/ChildProcessSpawner";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { assert, it } from "@effect/vitest";
import { McpSchema, McpServer } from "effect/unstable/ai";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AgentThreadLaunchResult,
  CommandId,
  RunId,
  NodeId,
  GitCommandError,
  EnvironmentId,
  ChatAttachmentId,
  type ChatAttachment,
  type ServerProvider,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { ProjectRegistrationLive } from "./McpHttpServer.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../config.ts";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import {
  makeHarness,
  launchInput,
  projectId,
  otherProjectId,
  modelSelection,
  type HarnessOptions,
} from "../orchestration-v2/testkit/ThreadLaunchHarness.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const decodeLaunchResult = Schema.decodeUnknownEffect(AgentThreadLaunchResult);

const launchProvider: ServerProvider = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-22T00:00:00.000Z",
  availability: "available",
  models: [],
  slashCommands: [],
  skills: [],
};
const launchClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "launch-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "launch-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const makeAgentLaunchHarness = (options: HarnessOptions = {}) => {
  const harness = makeHarness({ ...options, providers: [launchProvider] });
  const files = ServerConfig.layerTest(process.cwd(), { prefix: "agent-launch-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  return ProjectRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(harness.layer),
    Layer.provideMerge(files),
  );
};
const agentLaunchContext = Effect.gen(function* () {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const server = yield* McpServer.McpServer;
  const parentId = ThreadId.make("agent-launch-parent");
  yield* launches.launch({
    ...launchInput({
      command: "agent-parent-create",
      thread: parentId,
      message: "Launch requested work",
    }),
    waitForPreparation: true,
  });
  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("launch-test"),
    threadId: parentId,
    providerInstanceId: modelSelection.instanceId,
    providerSessionId: "first-session",
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const invoke = (input: Record<string, unknown>, session = "first-session") =>
    server
      .callTool({ name: "t3_thread_launch", arguments: input })
      .pipe(
        Effect.provideService(McpInvocationContext, { ...scope, providerSessionId: session }),
        Effect.provideService(McpSchema.McpServerClient, launchClient),
      );
  const launch = (input: Record<string, unknown>, session?: string) =>
    invoke(input, session).pipe(
      Effect.flatMap((result) => {
        assert.isFalse(result.isError, encodeJson(result));
        return decodeLaunchResult(result.structuredContent);
      }),
    );
  return { threads, launches, parentId, server, invoke, launch };
});

it.effect("launching an ordinary chat records its creator before its first run starts", () =>
  Effect.gen(function* () {
    const { launch, threads, parentId, server } = yield* agentLaunchContext;
    assert.isFalse(server.tools.some(({ tool }) => tool.name === "create_threads"));
    const result = yield* launch({
      requestId: "batch",
      threads: [
        { entryId: "idle", title: "Idle child" },
        { entryId: "message", title: "Prompted child", message: "Work" },
        {
          entryId: "other",
          title: "Other project",
          projectId: otherProjectId,
          workspaceStrategy: { type: "root" },
        },
      ],
    });
    assert.lengthOf(result.threads, 3);
    const parent = yield* threads.getThreadProjection(parentId);
    const links = parent.visibleTurnItems.filter((row) => row.item.type === "thread_created");
    assert.lengthOf(links, 3);
    for (const entry of result.threads) {
      assert.isNull(entry.error);
      assert.isNotNull(entry.threadId);
      const child = yield* threads.getThreadProjection(entry.threadId!);
      assert.equal(child.thread.createdBy, "agent");
      assert.isNull(child.thread.lineage.parentThreadId);
      for (const message of child.messages) assert.equal(message.senderThreadId, parentId);
      assert.isTrue(
        links.some(
          (row) =>
            row.item.type === "thread_created" && row.item.targetThreadId === child.thread.id,
        ),
      );
      assert.isTrue(
        child.runs.every((run) => run.status === "preparing" || run.status === "starting"),
      );
    }
    assert.isNull(result.threads[0]!.runId);
    assert.equal(result.threads[2]!.projectId, otherProjectId);
    // Owner creation never acquires a creator relationship.
    assert.isFalse(
      parent.visibleTurnItems.some(
        (row) => row.item.type === "thread_created" && row.item.targetThreadId === parentId,
      ),
    );
  }).pipe(Effect.provide(makeAgentLaunchHarness())),
);

it.effect(
  "replays launch requests across sessions and refuses changed inputs without new chats",
  () =>
    Effect.gen(function* () {
      const { launch, invoke, threads, parentId } = yield* agentLaunchContext;
      const input = {
        requestId: "replay",
        threads: [{ entryId: "child", title: "Child", message: "Once" }],
      };
      const first = yield* launch(input);
      const again = yield* launch(input, "new-session");
      assert.equal(again.threads[0]!.threadId, first.threads[0]!.threadId);
      const changed = yield* invoke({
        ...input,
        threads: [{ entryId: "child", title: "Changed" }],
      });
      assert.include(encodeJson(changed.structuredContent), "invalid_request");
      assert.include(encodeJson(changed.structuredContent), "different input");
      const child = yield* threads.getThreadProjection(first.threads[0]!.threadId!);
      assert.lengthOf(child.messages, 1);
      assert.lengthOf(child.runs, 1);
      assert.lengthOf(
        (yield* threads.getThreadProjection(parentId)).visibleTurnItems.filter(
          (row) => row.item.type === "thread_created",
        ),
        1,
      );
    }).pipe(Effect.provide(makeAgentLaunchHarness())),
);

it.effect(
  "returns independent launch failures and reuses uploaded bytes after a lost response",
  () =>
    Effect.gen(function* () {
      const { launch, threads, parentId } = yield* agentLaunchContext;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const attachment: ChatAttachment = {
        type: "image",
        id: ChatAttachmentId.make(createPendingAttachmentId()),
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const pendingPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      assert.isNotNull(pendingPath);
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fs.writeFile(pendingPath!, new Uint8Array([1, 2, 3, 4]));
      const input = {
        requestId: "attachments",
        threads: [
          {
            entryId: "broken",
            title: "Missing upload",
            attachments: [{ ...attachment, id: createPendingAttachmentId() }],
          },
          { entryId: "good", title: "Uploaded", attachments: [attachment] },
        ],
      };
      const first = yield* launch(input);
      assert.isNotNull(first.threads[0]!.error);
      assert.isNull(first.threads[0]!.threadId);
      assert.isNull(first.threads[1]!.error);
      const again = yield* launch(input, "reconnected");
      assert.isNull(again.threads[1]!.error);
      assert.equal(again.threads[1]!.threadId, first.threads[1]!.threadId);
      const child = yield* threads.getThreadProjection(first.threads[1]!.threadId!);
      assert.lengthOf(child.messages, 1);
      const savedPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: child.messages[0]!.attachments[0]!,
      });
      assert.deepEqual(Array.from(yield* fs.readFile(savedPath!)), [1, 2, 3, 4]);
      assert.lengthOf(
        (yield* threads.getThreadProjection(parentId)).visibleTurnItems.filter(
          (row) => row.item.type === "thread_created",
        ),
        1,
      );
    }).pipe(Effect.provide(makeAgentLaunchHarness())),
);

it.effect(
  "rejects duplicate entries, implicit cross-project workspaces and retired launch input",
  () =>
    Effect.gen(function* () {
      const { invoke, threads, parentId } = yield* agentLaunchContext;
      for (const input of [
        {
          requestId: "duplicate",
          threads: [
            { entryId: "a", title: "A" },
            { entryId: "a", title: "B" },
          ],
        },
        {
          requestId: "cross-project",
          threads: [{ entryId: "a", title: "A", projectId: otherProjectId }],
        },
        { title: "Old singleton", projectId },
      ]) {
        const refused = yield* invoke(input);
        assert.isTrue(
          refused.isError ||
            encodeJson(refused.structuredContent).includes("invalid_request") ||
            encodeJson(refused.structuredContent).includes("ToolParameterValidationError"),
          encodeJson(refused),
        );
      }
      assert.lengthOf(
        (yield* threads.getThreadProjection(parentId)).visibleTurnItems.filter(
          (row) => row.item.type === "thread_created",
        ),
        0,
      );
    }).pipe(Effect.provide(makeAgentLaunchHarness())),
);

it.effect(
  "reopens the database with the same idle and prompted launch identities and saved defaults",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "launch-restart-" });
      const database = makeSqlitePersistenceLive(`${root}/state.sqlite`).pipe(
        Layer.provide(NodeServices.layer),
        Layer.orDie,
      );
      const input = {
        requestId: "restart",
        threads: [
          { entryId: "idle", title: "Idle" },
          { entryId: "prompted", title: "Prompted", message: "Only once" },
        ],
      };
      const first = yield* Effect.gen(function* () {
        const { launch, threads, parentId } = yield* agentLaunchContext;
        const result = yield* launch(input);
        yield* threads.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("parent-new-model"),
          threadId: parentId,
          modelSelection: { ...modelSelection, model: "new-parent-model" },
        });
        return result;
      }).pipe(Effect.provide(makeAgentLaunchHarness({ database })));
      // The first runtime and SQL connection have closed. Build a new runtime over its file.
      yield* Effect.gen(function* () {
        const { launch, threads, parentId } = yield* agentLaunchContext;
        const replayed = yield* launch(input, "after-engine-restart");
        assert.deepEqual(
          replayed.threads.map((entry) => entry.threadId),
          first.threads.map((entry) => entry.threadId),
        );
        assert.deepEqual(
          replayed.threads.map((entry) => entry.modelSelection),
          [modelSelection, modelSelection],
        );
        const parent = yield* threads.getThreadProjection(parentId);
        assert.lengthOf(
          parent.visibleTurnItems.filter((row) => row.item.type === "thread_created"),
          2,
        );
        assert.lengthOf(
          (yield* threads.getThreadProjection(replayed.threads[1]!.threadId!)).messages,
          1,
        );
      }).pipe(Effect.provide(makeAgentLaunchHarness({ database })));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not save a child when its creator record cannot be accepted", () =>
  Effect.gen(function* () {
    const { launches, threads, parentId } = yield* agentLaunchContext;
    for (const message of [undefined, "Must not start"]) {
      const childId = `invalid-creator-${message ? "prompted" : "idle"}`;
      const failed = yield* launches
        .launch({
          ...launchInput({ command: childId, thread: childId, ...(message ? { message } : {}) }),
          creator: {
            parentThreadId: parentId,
            parentRunId: RunId.make("not-the-parent-run"),
            parentNodeId: NodeId.make("not-the-root"),
          },
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.result);
      assert.equal(failed._tag, "Failure");
      assert.isNull(yield* threads.getThreadShell(ThreadId.make(childId)));
    }
    assert.lengthOf(
      (yield* threads.getThreadProjection(parentId)).visibleTurnItems.filter(
        (row) => row.item.type === "thread_created",
      ),
      0,
    );
  }).pipe(Effect.provide(makeAgentLaunchHarness())),
);

it.effect(
  "reports a failed checkout independently while successful worktree and root entries start once",
  () =>
    Effect.gen(function* () {
      const { launch, threads, parentId } = yield* agentLaunchContext;
      const input = {
        requestId: "workspaces",
        threads: [
          {
            entryId: "failed",
            title: "Bad base",
            message: "Do not run",
            workspaceStrategy: { type: "worktree", baseRef: "missing", branch: "bad" },
          },
          {
            entryId: "worktree",
            title: "Separate checkout",
            message: "Work",
            workspaceStrategy: { type: "worktree", baseRef: "main" },
          },
          {
            entryId: "root",
            title: "Root",
            message: "Work here",
            workspaceStrategy: { type: "root" },
          },
        ],
      };
      const result = yield* launch(input);
      assert.equal(result.threads[0]!.status, "failed");
      assert.isNotNull(result.threads[0]!.threadId);
      assert.isNotNull(result.threads[0]!.error);
      assert.equal(result.threads[1]!.worktreePath, "/repo-worktrees/feature");
      assert.include(result.threads[1]!.branch!, "agent-launch/");
      assert.isNull(result.threads[2]!.worktreePath);
      const replayed = yield* launch(input, "retry-workspaces");
      assert.equal(replayed.threads[0]!.runId, result.threads[0]!.runId);
      assert.isNotNull(replayed.threads[0]!.error);
      for (const entry of result.threads) {
        assert.lengthOf((yield* threads.getThreadProjection(entry.threadId!)).messages, 1);
      }
      assert.lengthOf(
        (yield* threads.getThreadProjection(parentId)).visibleTurnItems.filter(
          (row) => row.item.type === "thread_created",
        ),
        3,
      );
    }).pipe(
      Effect.provide(
        makeAgentLaunchHarness({
          createWorktree: (input) =>
            input.refName === "missing"
              ? Effect.fail(
                  new GitCommandError({
                    operation: "createWorktree",
                    command: "git worktree add",
                    cwd: input.cwd,
                    detail: "Missing base",
                  }),
                )
              : Effect.succeed({
                  worktree: { path: "/repo-worktrees/feature", refName: input.newRefName! },
                }),
        }),
      ),
    ),
);

it.effect(
  "inherits the creator's exact checkout and keeps concurrent retries on one preparation",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const { launch, threads, parentId } = yield* agentLaunchContext;
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("parent-workspace"),
          threadId: parentId,
          worktreePath: "/repo-worktrees/parent",
          branch: "parent-branch",
        });
        const input = {
          requestId: "concurrent",
          threads: [{ entryId: "child", title: "Child", message: "Once" }],
        };
        const first = yield* launch(input).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const pending = yield* launch(input, "concurrent-session");
        assert.equal(pending.threads[0]!.preparationStatus, "preparing");
        yield* Deferred.succeed(release, undefined);
        const ready = yield* Fiber.join(first);
        assert.equal(ready.threads[0]!.preparationStatus, "ready");
        assert.equal(ready.threads[0]!.worktreePath, "/repo-worktrees/parent");
        assert.equal(ready.threads[0]!.branch, "parent-branch");
        assert.equal(pending.threads[0]!.threadId, ready.threads[0]!.threadId);
        assert.lengthOf(
          (yield* threads.getThreadProjection(ready.threads[0]!.threadId!)).messages,
          1,
        );
        assert.lengthOf(
          (yield* threads.getThreadProjection(parentId)).visibleTurnItems.filter(
            (row) => row.item.type === "thread_created",
          ),
          1,
        );
      }).pipe(
        Effect.provide(
          makeAgentLaunchHarness({
            runSetup: (input) =>
              input.threadId === "agent-launch-parent"
                ? Effect.succeed({ status: "no-script" as const })
                : Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.as({ status: "no-script" as const }),
                  ),
          }),
        ),
      );
    }),
);

it.effect(
  "returns after releasing a run whose setup script intentionally stays in the background",
  () =>
    Effect.gen(function* () {
      const { launch } = yield* agentLaunchContext;
      const result = yield* launch({
        requestId: "async-setup",
        threads: [{ entryId: "child", title: "Child", message: "Start" }],
      });
      assert.equal(result.threads[0]!.preparationStatus, "ready");
      assert.equal(result.threads[0]!.status, "starting");
    }).pipe(
      Effect.provide(
        makeAgentLaunchHarness({
          runSetup: () =>
            Effect.succeed({
              status: "started" as const,
              async: true,
              scriptId: "setup",
              scriptName: "Development server",
              scriptCommand: "dev",
              terminalId: "setup",
              cwd: "/repo",
              completion: Effect.never,
            }),
        }),
      ),
    ),
);

it.effect("refuses launch authority from a restricted caller", () =>
  Effect.gen(function* () {
    const { invoke, threads, parentId } = yield* agentLaunchContext;
    yield* threads.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("restrict-parent"),
      threadId: parentId,
      runtimeMode: "approval-required",
    });
    const result = yield* invoke({
      requestId: "restricted",
      threads: [
        {
          entryId: "child",
          title: "Child",
          projectId: otherProjectId,
          workspaceStrategy: { type: "root" },
        },
      ],
    });
    assert.include(encodeJson(result.structuredContent), "requires full-access/default");
    assert.lengthOf(
      (yield* threads.getThreadProjection(parentId)).visibleTurnItems.filter(
        (row) => row.item.type === "thread_created",
      ),
      0,
    );
  }).pipe(Effect.provide(makeAgentLaunchHarness())),
);

it.effect("recovers its reserved checkout after creation but before the binding receipt", () => {
  let destination = "";
  let commonDirectory = "";
  let creations = 0;
  return Effect.gen(function* () {
    const { launch, threads, parentId } = yield* agentLaunchContext;
    const fs = yield* FileSystem.FileSystem;
    const sql = yield* SqlClient.SqlClient;
    const input = {
      requestId: "checkout-crash",
      threads: [
        {
          entryId: "idle",
          title: "Idle worktree",
          workspaceStrategy: { type: "worktree", baseRef: "main", branch: "crash-recovery" },
        },
      ],
    };
    const interrupted = yield* launch(input);
    assert.isNotNull(interrupted.threads[0]!.threadId);
    assert.isNotNull(interrupted.threads[0]!.error);
    // Restore the physical checkout portion of the crash snapshot. There is
    // an accepted creator/chat but no workspace-binding receipt yet.
    const rows = yield* sql<{
      destination: string;
    }>`SELECT json_extract(accepted_json, '$.threads[0].worktreeDestination') AS destination FROM exarch_agent_launch_requests`;
    destination = rows[0]!.destination;
    commonDirectory = `${destination}/git-common`;
    yield* fs.makeDirectory(commonDirectory, { recursive: true });
    const recovered = yield* launch(input, "after-crash");
    assert.equal(recovered.threads[0]!.threadId, interrupted.threads[0]!.threadId);
    assert.equal(recovered.threads[0]!.worktreePath, destination);
    assert.equal(recovered.threads[0]!.preparationStatus, "ready");
    assert.isNull(recovered.threads[0]!.error);
    assert.equal(creations, 1);
    assert.lengthOf(
      (yield* threads.getThreadProjection(parentId)).visibleTurnItems.filter(
        (row) => row.item.type === "thread_created",
      ),
      1,
    );
  }).pipe(
    Effect.provide(
      makeAgentLaunchHarness({
        createWorktree: (input) => {
          creations++;
          return Effect.fail(
            new GitCommandError({
              operation: "createWorktree",
              command: "git worktree add",
              cwd: input.cwd,
              detail: "Interrupted before binding",
            }),
          );
        },
        executeGit: (input) =>
          Effect.succeed({
            stdout: input.args.includes("--git-common-dir")
              ? commonDirectory
              : input.args.includes("--show-toplevel")
                ? destination
                : "crash-recovery",
            stderr: "",
            exitCode: ExitCode(0),
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      }),
    ),
  );
});
