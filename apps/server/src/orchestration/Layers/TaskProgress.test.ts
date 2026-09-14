import { registerCodexRoute } from "../../strata/TaskProgressCodexRoute.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import {
  CommandId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { registerProgressBridge } from "../../strata/TaskProgressBridge.ts";
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
  progressInstructionsEnabled,
  publishProgress,
  readProgressCard,
} from "../../strata/TaskProgressRuntime.ts";
import { ServerSettingsService, layerTest as settingsLayerTest } from "../../serverSettings.ts";

function makeOrchestrationLayer(
  databasePath?: string,
  repositoryIdentityResolver?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
  settings: Layer.Layer<ServerSettingsService, ServerSettingsError> = settingsLayerTest(),
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
    Layer.provideMerge(persistence),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(settings),
    Layer.provideMerge(NodeServices.layer),
  );
}

async function createOrchestrationSystem(
  databasePath?: string,
  repositoryIdentityResolver?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
  settings?: Layer.Layer<ServerSettingsService, ServerSettingsError>,
) {
  const runtime = ManagedRuntime.make(
    makeOrchestrationLayer(databasePath, repositoryIdentityResolver, settings),
  );
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  return {
    engine,
    readModel: () => runtime.runPromise(snapshotQuery.getSnapshot()),
    readThread: (threadId: ThreadId) =>
      runtime.runPromise(snapshotQuery.getThreadDetailById(threadId)),
    run: <A, E>(effect: Effect.Effect<A, E, ServerSettingsService | SqlClient.SqlClient>) =>
      runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return "2026-01-01T00:00:00.000Z";
}

describe("task progress durable card", () => {
  it("replaces, clears and restores one card per chat whether or not a run is active", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-progress-"));
    const database = NodePath.join(directory, "state.sqlite");
    let system = await createOrchestrationSystem(database);
    const threadId = ThreadId.make("progress-thread"),
      projectId = ProjectId.make("progress-project");
    const execSql = (statement: string) => {
      const connection = new NodeSqlite.DatabaseSync(database);
      try {
        connection.exec(statement);
      } finally {
        connection.close();
      }
    };
    const publish = (input: unknown) => system.run(Effect.result(publishProgress(threadId, input)));
    const ack = (input: unknown) => system.run(publishProgress(threadId, input));
    const refusal = async (input: unknown) => {
      const result = await publish(input);
      expect(result._tag, `${JSON.stringify(input)} should be refused`).toBe("Failure");
      return result._tag === "Failure" ? result.failure.detail : "";
    };
    const thread = async () => {
      const read = await system.readThread(threadId);
      return Option.isSome(read) ? read.value : null;
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
      // Nothing written yet: a read is null, a clear is acknowledged and writes nothing.
      expect(await system.run(readProgressCard(threadId))).toBeNull();
      expect(await ack({})).toEqual({
        message: "Progress card cleared",
        revision: null,
        steps: null,
      });
      expect((await thread())?.taskProgressV2).toBeUndefined();
      expect((await thread())?.taskProgress).toBeUndefined();

      // An idle chat with a live credential may write; the card has no turn to attribute.
      const first = await ack({ markdown: "First" });
      expect(first).toEqual({ message: "Progress card updated (rev 1)", revision: 1, steps: null });
      expect((await thread())?.taskProgressV2).toMatchObject({
        card: { version: 2, revision: 1, markdown: "First" },
        revision: 1,
        turnId: null,
      });
      expect((await thread())?.taskProgress).toBeUndefined();

      const route = registerCodexRoute({ threadId, root: Effect.succeed("root-thread") });
      try {
        const stored = (await thread())?.taskProgressV2;
        for (const input of [
          [{ step: "Read", status: "pending" }],
          '{"markdown":"Wrong shape"}',
          7,
          null,
        ]) {
          const result = await system.run(
            route.handle({
              tool: "strata_progress_card",
              threadId: "root-thread",
              turnId: "turn-1",
              callId: "malformed",
              arguments: input,
            }),
          );
          expect(result.success).toBe(false);
          expect(result.contentItems[0]).toMatchObject({
            text: expect.stringContaining("arguments must be an object"),
          });
          expect((await thread())?.taskProgressV2).toEqual(stored);
        }
      } finally {
        route.close();
      }

      // A running turn attributes the write for version 1 readers.
      await session("start-1", "running", "turn-1");
      const steps = [
        { step: "Read", status: "completed" },
        { step: "Patch", status: "in_progress" },
        { step: "Verify", status: "pending" },
      ];
      expect(await ack({ markdown: "Second", plan: steps })).toEqual({
        message: "Progress card updated (rev 2, 1/3 done)",
        revision: 2,
        steps: { completed: 1, total: 3 },
      });
      const second = await thread();
      expect(second?.taskProgressV2?.card).toEqual({
        version: 2,
        revision: 2,
        updatedAt: expect.any(String),
        markdown: "Second",
        steps,
      });
      expect(second?.taskProgressV2?.turnId).toBe("turn-1");
      expect(second?.taskProgress).toMatchObject({
        version: 1,
        revision: 2,
        markdown: "Second",
        plan: [
          { text: "Read", status: "completed" },
          { text: "Patch", status: "in_progress" },
          { text: "Verify", status: "pending" },
        ],
        runId: "turn-1",
        providerTurnId: "turn-1",
        outcome: null,
        endedAt: null,
      });
      expect(await system.run(readProgressCard(threadId))).toEqual(second?.taskProgressV2?.card);

      // Omitted parts disappear; the checklist alone answers with counts.
      expect(await ack({ plan: steps })).toEqual({
        message: "Progress card updated (rev 3, 1/3 done)",
        revision: 3,
        steps: { completed: 1, total: 3 },
      });
      expect((await thread())?.taskProgressV2?.card).not.toHaveProperty("markdown");

      // Invalid content is refused before anything changes.
      expect(await refusal({ markdown: "Lost", steps })).toContain('unknown field "steps"');
      expect(
        await refusal({
          plan: [
            { text: "a", status: "in_progress" },
            { step: "b", status: "in_progress" },
          ],
        }),
      ).toContain("at most one in_progress");
      expect(await refusal({ markdown: null })).toContain("markdown must be a string");
      expect(await refusal({ plan: [{ step: "😀".repeat(300), status: "pending" }] })).toContain(
        "512",
      );
      expect((await thread())?.taskProgressV2).toMatchObject({ revision: 3, card: { steps } });
      // A commit failure keeps the previous card too.
      execSql(
        "CREATE TRIGGER reject_progress BEFORE UPDATE ON strata_task_progress_v2 WHEN NEW.markdown LIKE '%reject-at-commit%' BEGIN SELECT RAISE(ABORT, 'proof failure'); END",
      );
      expect((await publish({ markdown: "reject-at-commit" }))._tag).toBe("Failure");
      execSql("DROP TRIGGER reject_progress");
      expect((await thread())?.taskProgressV2?.revision).toBe(3);

      // Content the old reader cannot hold stays canonical and is omitted from version 1.
      const wideStep = "a".repeat(512);
      expect(await ack({ plan: [{ step: wideStep, status: "in_progress" }] })).toMatchObject({
        revision: 4,
      });
      const wide = await thread();
      expect(wide?.taskProgressV2?.card?.steps?.[0]?.step).toBe(wideStep);
      expect(wide?.taskProgress).toBeUndefined();
      expect(await ack({ markdown: "Fits again" })).toMatchObject({ revision: 5 });
      expect((await thread())?.taskProgress?.markdown).toBe("Fits again");

      // The run ends: the canonical record keeps no outcome, and version 1 reads the turn.
      await session("finish-1", "ready", "turn-1");
      const finished = await thread();
      expect(finished?.taskProgressV2?.card?.revision).toBe(5);
      expect(finished?.taskProgressV2).not.toHaveProperty("outcome");
      expect(finished?.taskProgress?.outcome).toBe("completed");
      // Writes after the run are still accepted from the live credential.
      expect(await ack({ markdown: "After the run" })).toMatchObject({ revision: 6 });

      // Clearing keeps the revision moving; clearing again is idempotent.
      expect(await ack({})).toEqual({
        message: "Progress card cleared",
        revision: null,
        steps: null,
      });
      const cleared = await thread();
      expect(cleared?.taskProgressV2).toMatchObject({ card: null, revision: 7 });
      expect(cleared?.taskProgress).toBeUndefined();
      expect(await system.run(readProgressCard(threadId))).toBeNull();
      expect(await ack({ markdown: "   ", plan: [] })).toMatchObject({
        message: "Progress card cleared",
      });
      expect((await thread())?.taskProgressV2?.revision).toBe(8);

      // A restart keeps the record; the next write continues the revision.
      await system.dispose();
      system = await createOrchestrationSystem(database);
      expect((await thread())?.taskProgressV2).toMatchObject({ card: null, revision: 8 });
      await session("start-2", "running", "turn-2");
      const concurrent = await Promise.all([
        ack({ markdown: "Ninth" }),
        ack({ markdown: "Tenth" }),
      ]);
      expect(concurrent.map((result) => result.revision).sort()).toEqual([10, 9]);
      const latest = await thread();
      expect(latest?.taskProgressV2?.revision).toBe(10);
      expect(latest?.taskProgress?.runId).toBe("turn-2");

      const clearingRoute = registerCodexRoute({ threadId, root: Effect.succeed("root-thread") });
      try {
        for (const input of [undefined, {}]) {
          const result = await system.run(
            clearingRoute.handle({
              tool: "strata_progress_card",
              threadId: "root-thread",
              turnId: "turn-2",
              callId: "clear",
              arguments: input,
            }),
          );
          expect(result.success).toBe(true);
          expect((await thread())?.taskProgressV2?.card).toBeNull();
        }
      } finally {
        clearingRoute.close();
      }

      await system.run(
        system.engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete-progress"),
          threadId,
        }),
      );
      expect((await publish({ markdown: "Must not return" }))._tag).toBe("Failure");
      expect(Option.isNone(await system.readThread(threadId))).toBe(true);
    } finally {
      await system.dispose();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses writes while the setting is off, without a restart, and the instructions follow it", async () => {
    const settings = settingsLayerTest({ enableTaskProgress: false });
    const system = await createOrchestrationSystem(undefined, undefined, settings);
    const threadId = ThreadId.make("setting-thread"),
      projectId = ProjectId.make("setting-project");
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("project"),
          projectId,
          title: "Setting",
          workspaceRoot: "/tmp",
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("thread"),
          threadId,
          projectId,
          title: "Setting",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      const refused = await system.run(
        Effect.result(publishProgress(threadId, { markdown: "Off" })),
      );
      expect(refused._tag).toBe("Failure");
      expect(refused._tag === "Failure" ? refused.failure.detail : "").toContain("disabled");
      expect(progressInstructionsEnabled()).toBe(false);
      await system.run(
        Effect.gen(function* () {
          const service = yield* ServerSettingsService;
          yield* service.updateSettings({ enableTaskProgress: true });
        }),
      );
      expect(await system.run(publishProgress(threadId, { markdown: "On" }))).toMatchObject({
        revision: 1,
      });
      expect(progressInstructionsEnabled()).toBe(true);
    } finally {
      await system.dispose();
    }
  });

  it("migrates a card saved by the earlier engine and keeps writing on top of it", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-progress-migrate-"));
    const database = NodePath.join(directory, "state.sqlite");
    const threadId = ThreadId.make("old-thread"),
      projectId = ProjectId.make("old-project");
    let system = await createOrchestrationSystem(database);
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("project"),
          projectId,
          title: "Old",
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
          title: "Old",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      await system.dispose();
      // What the earlier engine left behind: its table only, no canonical record.
      const connection = new NodeSqlite.DatabaseSync(database);
      try {
        connection.exec("DELETE FROM strata_task_progress_v2");
        connection
          .prepare("INSERT INTO strata_task_progress (thread_id, card_json) VALUES (?, ?)")
          .run(
            threadId,
            JSON.stringify({
              version: 1,
              revision: 3,
              generation: now(),
              markdown: "Saved before the upgrade",
              plan: [{ text: "Old step", status: "in_progress" }],
              runId: "turn-old",
              providerTurnId: "turn-old",
              updatedAt: now(),
              outcome: "completed",
              endedAt: now(),
            }),
          );
        connection.exec(
          "INSERT INTO effect_sql_migrations SELECT * FROM strata_sql_migrations WHERE migration_id < 54; DROP TABLE strata_sql_migrations",
        );
      } finally {
        connection.close();
      }
      system = await createOrchestrationSystem(database);
      const read = await system.readThread(threadId);
      expect(Option.isSome(read) && read.value.taskProgressV2).toMatchObject({
        card: {
          revision: 3,
          markdown: "Saved before the upgrade",
          steps: [{ step: "Old step", status: "in_progress" }],
        },
        revision: 3,
        turnId: "turn-old",
      });
      expect(await system.run(publishProgress(threadId, { markdown: "Continued" }))).toMatchObject({
        revision: 4,
      });
    } finally {
      await system.dispose();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

it.each([false, true])(
  "acknowledges its committed write when the next write clears=%s before its read",
  async (clear) => {
    const system = await createOrchestrationSystem();
    const threadId = ThreadId.make("race-thread"),
      projectId = ProjectId.make("race-project");
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("race-project"),
          projectId,
          title: "Race",
          workspaceRoot: process.cwd(),
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("race-thread"),
          threadId,
          projectId,
          title: "Race",
          modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      await system.run(
        Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            let reached!: () => void, release!: () => void;
            const committed = new Promise<void>((resolve) => {
              reached = resolve;
            });
            const held = new Promise<void>((resolve) => {
              release = resolve;
            });
            yield* registerProgressBridge(sql, (command) =>
              system.engine.dispatch(command).pipe(
                Effect.tap(() =>
                  command.type === "thread.task-progress.write" && command.markdown === "A"
                    ? Effect.promise(async () => {
                        reached();
                        await held;
                      })
                    : Effect.void,
                ),
              ),
            );
            yield* Effect.promise(async () => {
              const a = system.run(
                publishProgress(threadId, {
                  markdown: "A",
                  plan: [{ step: "A complete", status: "completed" }],
                }),
              );
              try {
                await committed;
                const b = await system.run(
                  publishProgress(
                    threadId,
                    clear
                      ? {}
                      : {
                          markdown: "B",
                          plan: [
                            { step: "B pending", status: "pending" },
                            { step: "B next", status: "pending" },
                          ],
                        },
                  ),
                );
                expect(b).toMatchObject(
                  clear
                    ? { revision: null, steps: null }
                    : { revision: 2, steps: { completed: 0, total: 2 } },
                );
                release();
                expect(await a).toMatchObject({ revision: 1, steps: { completed: 1, total: 1 } });
                const current = await system.run(readProgressCard(threadId));
                expect(current?.markdown ?? null).toBe(clear ? null : "B");
              } finally {
                release();
              }
            });
          }),
        ),
      );
    } finally {
      await system.dispose();
    }
  },
);
