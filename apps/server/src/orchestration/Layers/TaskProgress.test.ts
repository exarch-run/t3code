// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CommandId, ProjectId, ThreadId, TurnId, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import {
  registerWriter,
  invokeProgress,
  normalizeProgress,
} from "../../strata/TaskProgressRuntime.ts";

function makeOrchestrationLayer(
  databasePath?: string,
  repositoryIdentityResolver?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
) {
  const persistence = databasePath
    ? makeSqlitePersistenceLive(databasePath)
    : SqlitePersistenceMemory;
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-orchestration-engine-test-",
  });
  return Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(
      repositoryIdentityResolver
        ? Layer.succeed(
            RepositoryIdentityResolver.RepositoryIdentityResolver,
            repositoryIdentityResolver,
          )
        : RepositoryIdentityResolver.layer,
    ),
    Layer.provide(persistence),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

async function createOrchestrationSystem(
  databasePath?: string,
  repositoryIdentityResolver?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
) {
  const runtime = ManagedRuntime.make(
    makeOrchestrationLayer(databasePath, repositoryIdentityResolver),
  );
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  return {
    engine,
    readModel: () => runtime.runPromise(snapshotQuery.getSnapshot()),
    readThread: (threadId: ThreadId) =>
      runtime.runPromise(snapshotQuery.getThreadDetailById(threadId)),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return "2026-01-01T00:00:00.000Z";
}

describe("task progress durable publishing", () => {
  it("retains receipts and source outcomes across restart and rejects children and retired runs", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-progress-"));
    const database = NodePath.join(directory, "state.sqlite");
    let system = await createOrchestrationSystem(database);
    const threadId = ThreadId.make("progress-thread"),
      projectId = ProjectId.make("progress-project");
    let turn = "turn-1";
    let retireDuringCommit = false,
      checks = 0;
    const execSql = (statement: string) => {
      const connection = new DatabaseSync(database);
      try {
        connection.exec(statement);
      } finally {
        connection.close();
      }
    };
    let writer = registerWriter({
      threadId,
      root: Effect.succeed("native-root"),
      current: (id) =>
        Effect.sync(() => {
          if (retireDuringCommit && ++checks > 1) turn = "";
          return id === turn;
        }),
    });
    const invoke = (writeId: string, markdown: string, origin = turn, root = "native-root") =>
      system.run(
        invokeProgress(writer.id, {
          threadId: root,
          turnId: origin,
          tool: "progress_card",
          arguments: { writeId, markdown },
        }),
      );
    const session = (id: string, status: "running" | "ready") =>
      system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(id),
          threadId,
          createdAt: now(),
          session: {
            threadId,
            status,
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: status === "running" ? TurnId.make(turn) : null,
            lastError: null,
            updatedAt: now(),
          },
        }),
      );
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("project"),
          projectId,
          title: "Progress",
          workspaceRoot: directory,
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("thread"),
          threadId,
          projectId,
          title: "Progress",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      await session("start-1", "running");
      const first = await invoke("one", "First");
      expect(first.success, first.contentItems[0]?.text).toBe(true);
      expect((await invoke("two", "Second")).success).toBe(true);
      expect(await invoke("one", "First")).toEqual(first);
      expect((await invoke("one", "Changed")).success).toBe(false);
      expect((await invoke("child", "Child", turn, "native-child")).success).toBe(false);
      expect((await invoke("bad", "")).success).toBe(false);
      execSql(
        "CREATE TRIGGER reject_progress BEFORE INSERT ON strata_task_progress WHEN NEW.card_json LIKE '%reject-at-commit%' BEGIN SELECT RAISE(ABORT, 'proof failure'); END",
      );
      expect((await invoke("failure", "reject-at-commit")).success).toBe(false);
      execSql("DROP TRIGGER reject_progress");
      retireDuringCommit = true;
      expect((await invoke("already-resolved", "Must not commit")).success).toBe(false);
      retireDuringCommit = false;
      turn = "turn-1";
      const read = await system.readThread(threadId);
      expect(Option.isSome(read) && read.value.taskProgress?.markdown).toBe("Second");
      turn = "";
      expect((await invoke("late", "Late", "turn-1")).success).toBe(false);
      await session("finish-1", "ready");
      turn = "turn-2";
      await session("start-2", "running");
      const old = await system.readThread(threadId);
      expect(Option.isSome(old) && old.value.taskProgress?.outcome).toBe("completed");
      expect((await invoke("late-again", "Late", "turn-1")).success).toBe(false);
      expect(await invoke("one", "First", "turn-1")).toEqual(first);
      writer.close();
      writer = registerWriter({
        threadId,
        root: Effect.succeed("native-root"),
        current: (id) => Effect.sync(() => id === turn),
      });
      await system.dispose();
      system = await createOrchestrationSystem(database);
      const restored = await system.readThread(threadId);
      expect(Option.isSome(restored) && restored.value.taskProgress?.revision).toBe(2);
      expect(Option.isSome(restored) && restored.value.taskProgress?.outcome).toBe("completed");
      expect(await invoke("one", "First", "turn-1")).toEqual(first);
      const concurrent = await Promise.all([invoke("three", "Third"), invoke("four", "Fourth")]);
      expect(concurrent.every((result) => result.success)).toBe(true);
      expect(concurrent.map((result) => JSON.parse(result.contentItems[0]!.text).revision)).toEqual(
        [3, 4],
      );
      const latest = await system.readThread(threadId);
      expect(Option.isSome(latest) && latest.value.taskProgress?.markdown).toBe("Fourth");
      await system.run(
        system.engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete-progress"),
          threadId,
        }),
      );
      expect((await invoke("after-delete", "Must not return")).success).toBe(false);
      expect((await invoke("four", "Fourth")).success).toBe(false);
      expect(Option.isNone(await system.readThread(threadId))).toBe(true);
    } finally {
      writer.close();
      await system.dispose();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
  it("normalizes full replacements and bounds content", () => {
    expect(normalizeProgress({ writeId: "a", markdown: "  Note\r\ntext\u202e  " }).content).toEqual(
      { markdown: "Note\ntext", plan: [] },
    );
    expect(() => normalizeProgress({ writeId: "a", markdown: "😀".repeat(2049) })).toThrow("8 KiB");
    expect(() =>
      normalizeProgress({
        writeId: "a",
        plan: [
          { text: "a", status: "in_progress" },
          { text: "b", status: "in_progress" },
        ],
      }),
    ).toThrow("Only one");
    expect(() => normalizeProgress({ writeId: "a", turnId: "forged", markdown: "Note" })).toThrow(
      "Unknown",
    );
  });
});
