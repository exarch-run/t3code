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
  NO_ACTIVE_RUN,
  normalizeProgress,
  publishProgress,
  readProgressCard,
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
  it("accepts any write in the chat while a run is active, retains receipts and outcomes across restart, and refuses idle chats", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-progress-"));
    const database = NodePath.join(directory, "state.sqlite");
    let system = await createOrchestrationSystem(database);
    const threadId = ThreadId.make("progress-thread"),
      projectId = ProjectId.make("progress-project");
    const execSql = (statement: string) => {
      const connection = new DatabaseSync(database);
      try {
        connection.exec(statement);
      } finally {
        connection.close();
      }
    };
    const publish = (writeId: string, markdown: string) =>
      system.run(Effect.result(publishProgress(threadId, { writeId, markdown })));
    const receipt = (writeId: string, markdown: string) =>
      system.run(publishProgress(threadId, { writeId, markdown }));
    const refusal = async (writeId: string, markdown: string) => {
      const result = await publish(writeId, markdown);
      expect(result._tag, `${writeId} should be refused`).toBe("Failure");
      return result._tag === "Failure" ? result.failure.detail : "";
    };
    const session = (id: string, status: "running" | "ready", turn: string) =>
      system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(id),
          threadId,
          createdAt: now(),
          session: {
            threadId,
            status,
            providerName: "claudeAgent",
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
          modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      // Nothing written yet, and no run to write in.
      expect(await system.run(readProgressCard(threadId))).toBeNull();
      expect(await refusal("early", "Too early")).toBe(NO_ACTIVE_RUN);

      await session("start-1", "running", "turn-1");
      const first = await receipt("one", "First");
      expect(first.revision).toBe(1);
      expect((await receipt("two", "Second")).revision).toBe(2);
      // A retry returns the original receipt; a reused id with new content is refused.
      expect(await receipt("one", "First")).toEqual(first);
      expect(await refusal("one", "Changed")).toContain("writeId was already used");
      expect(await refusal("bad", "")).toContain("Supply a status note, plan, or both");
      execSql(
        "CREATE TRIGGER reject_progress BEFORE INSERT ON strata_task_progress WHEN NEW.card_json LIKE '%reject-at-commit%' BEGIN SELECT RAISE(ABORT, 'proof failure'); END",
      );
      expect((await publish("failure", "reject-at-commit"))._tag).toBe("Failure");
      execSql("DROP TRIGGER reject_progress");
      const read = await system.readThread(threadId);
      expect(Option.isSome(read) && read.value.taskProgress?.markdown).toBe("Second");
      expect(Option.isSome(read) && read.value.taskProgress?.runId).toBe("turn-1");
      expect((await system.run(readProgressCard(threadId)))?.revision).toBe(2);

      // The run ends: the card keeps its outcome and idle writes are refused.
      await session("finish-1", "ready", "turn-1");
      const finished = await system.readThread(threadId);
      expect(Option.isSome(finished) && finished.value.taskProgress?.outcome).toBe("completed");
      expect(await refusal("late", "Late")).toBe(NO_ACTIVE_RUN);

      // A restart keeps the card, its revision and its outcome.
      await system.dispose();
      system = await createOrchestrationSystem(database);
      const restored = await system.readThread(threadId);
      expect(Option.isSome(restored) && restored.value.taskProgress?.revision).toBe(2);
      expect(Option.isSome(restored) && restored.value.taskProgress?.outcome).toBe("completed");

      // The next run writes on top; concurrent writes serialize.
      await session("start-2", "running", "turn-2");
      const concurrent = await Promise.all([receipt("three", "Third"), receipt("four", "Fourth")]);
      expect(concurrent.map((result) => result.revision)).toEqual([3, 4]);
      const latest = await system.readThread(threadId);
      expect(Option.isSome(latest) && latest.value.taskProgress?.markdown).toBe("Fourth");
      expect(Option.isSome(latest) && latest.value.taskProgress?.runId).toBe("turn-2");
      expect(Option.isSome(latest) && latest.value.taskProgress?.outcome).toBeNull();

      await system.run(
        system.engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete-progress"),
          threadId,
        }),
      );
      expect((await publish("after-delete", "Must not return"))._tag).toBe("Failure");
      expect(Option.isNone(await system.readThread(threadId))).toBe(true);
    } finally {
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
