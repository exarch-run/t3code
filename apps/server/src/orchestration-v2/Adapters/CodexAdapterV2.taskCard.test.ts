import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CodexSettings,
  ProviderSessionId,
  ThreadId,
  type ModelSelection,
  type TaskProgressCardV2,
} from "@t3tools/contracts";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexError from "effect-codex-app-server/errors";
import type * as CodexRpc from "effect-codex-app-server/rpc";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { boundTaskProgress, memoryCards } from "../../exarch/TaskProgress.testkit.ts";
import { CODEX_TASK_PROGRESS_TOOLS } from "../../exarch/TaskProgressCodexRoute.ts";
import { SUBAGENT_WRITE_REFUSED } from "../../exarch/TaskProgressInput.ts";
import { layer as idAllocatorLayer, IdAllocatorV2 } from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import {
  CODEX_DEFAULT_INSTANCE_ID,
  makeCodexAdapterV2,
  type CodexAppServerClientFactoryShape,
} from "./CodexAdapterV2.ts";
import { makeReplayServerConfig } from "./CodexAdapterV2.testkit.ts";

type ToolCall = CodexRpc.ServerRequestParamsByMethod["item/tool/call"];
type ToolHandler = (
  call: ToolCall,
) => Effect.Effect<
  CodexRpc.ServerRequestResponsesByMethod["item/tool/call"],
  CodexError.CodexAppServerError
>;

const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
const parse = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const modelSelection = {
  instanceId: CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
} satisfies ModelSelection;
const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});
const ROOT = "codex-root-thread";

const threadStarted = {
  thread: {
    id: ROOT,
    sessionId: ROOT,
    forkedFromId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1782622440,
    updatedAt: 1782622440,
    status: { type: "idle" },
    path: `/tmp/${ROOT}.jsonl`,
    cwd: "/workspace",
    cliVersion: "0.144.0",
    source: "vscode",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  },
  model: "gpt-5.4",
  modelProvider: "openai",
  serviceTier: null,
  cwd: "/workspace",
  instructionSources: [],
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
  reasoningEffort: "medium",
};

/** A Codex app-server that answers only session setup and hands the test its tool-call handler. */
const fakeCodex = (rolloutPath = threadStarted.thread.path) => {
  const sent: Array<{ method: string; params: unknown }> = [];
  let toolCall: ToolHandler | undefined;
  const client = {
    raw: {
      request: (method: string, params: unknown) =>
        Effect.sync(() => {
          sent.push({ method, params });
          if (method === "thread/start") return threadStarted;
          if (method === "thread/resume")
            return { thread: { id: ROOT, updatedAt: 1782622450, path: rolloutPath } };
          return {};
        }),
    },
    request: () => Effect.succeed({}),
    notify: () => Effect.void,
    handleServerRequest: (method: string, handler: ToolHandler) =>
      Effect.sync(() => {
        if (method === "item/tool/call") toolCall = handler;
      }),
    handleServerNotification: () => Effect.void,
    handleUnknownServerRequest: () => Effect.void,
  } as unknown as CodexClient.CodexAppServerClient["Service"];
  const factory: CodexAppServerClientFactoryShape = { open: () => Effect.succeed(client) };
  return {
    factory,
    sent,
    call: (threadId: string, tool: string, args: ToolCall["arguments"] = {}) => {
      if (toolCall === undefined) return Effect.die("no item/tool/call handler registered");
      return toolCall({ threadId, turnId: "turn-1", callId: "call-1", tool, arguments: args });
    },
  };
};

const text = (result: { readonly contentItems: ReadonlyArray<unknown> }) => {
  const item = result.contentItems[0] as { readonly text?: string } | undefined;
  return item?.text ?? "";
};

describe("Codex task card ownership", () => {
  it.effect(
    "starts threads with the card tools, answers only the chat's own thread, and holds the MCP writer",
    () =>
      Effect.gen(function* () {
        const cards = memoryCards();
        const taskProgress = boundTaskProgress(cards.commands);
        const codex = fakeCodex();
        const adapter = makeCodexAdapterV2({
          instanceId: CODEX_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CODEX_SETTINGS,
          environment: {},
          clientFactory: codex.factory,
          fileSystem: yield* FileSystem.FileSystem,
          idAllocator: yield* IdAllocatorV2,
          serverConfig: yield* makeReplayServerConfig("task-card").pipe(Effect.orDie),
          taskProgress,
        });
        const threadId = ThreadId.make("codex-card-chat");
        const sessionScope = yield* Scope.make();
        const runtime = yield* adapter
          .openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("codex-card-session"),
            modelSelection,
            runtimePolicy,
          })
          .pipe(Scope.provide(sessionScope));
        yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });

        // thread/start carries the tools through the extended schema.
        const start = codex.sent.find((request) => request.method === "thread/start");
        assert.deepInclude(start?.params as object, {
          cwd: "/workspace",
          dynamicTools: CODEX_TASK_PROGRESS_TOOLS,
        });

        // A helper is its own Codex thread: refused before anything is written.
        const helper = yield* codex.call("codex-helper-thread", "exarch_progress_card", {
          markdown: "From a helper",
        });
        assert.isFalse(helper.success);
        assert.equal(text(helper), SUBAGENT_WRITE_REFUSED);
        assert.deepEqual(cards.written, []);

        const written = yield* codex.call(ROOT, "exarch_progress_card", {
          markdown: "Parent",
          plan: [
            { step: "Read", status: "completed" },
            { step: "Patch", status: "in_progress" },
          ],
        });
        assert.isTrue(written.success);
        assert.deepEqual(parse(text(written)), {
          message: "Progress card updated (rev 1, 1/2 done)",
          revision: 1,
          steps: { completed: 1, total: 2 },
        });
        assert.deepEqual(
          cards.written.map((write) => write.threadId),
          [threadId],
        );
        const read = yield* codex.call(ROOT, "exarch_progress_card_read");
        assert.deepEqual(
          (parse(text(read)) as { card: TaskProgressCardV2 }).card.markdown,
          "Parent",
        );
        const unknown = yield* codex.call(ROOT, "something_else");
        assert.isFalse(unknown.success);

        // Codex helpers share the chat's MCP credential, so the MCP writer is
        // closed to this chat while its Codex session lives.
        assert.isTrue(taskProgress.claimed(threadId));
        yield* Scope.close(sessionScope, Exit.void);
        assert.isFalse(taskProgress.claimed(threadId));
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
  );
  it.effect(
    "after an engine restart, holds the MCP writer only for a thread Codex restores the card tools to",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const sessionMeta = (dynamicTools: unknown) =>
          `${JSON.stringify({ type: "session_meta", payload: { id: ROOT, dynamic_tools: dynamicTools } })}\n` +
          `${JSON.stringify({ type: "response_item", payload: {} })}\n`;
        const withTools = `${dir}/with-tools.jsonl`;
        const withoutTools = `${dir}/without-tools.jsonl`;
        yield* fs.writeFileString(withTools, sessionMeta(CODEX_TASK_PROGRESS_TOOLS));
        yield* fs.writeFileString(withoutTools, sessionMeta([]));

        const resume = (rolloutPath: string) =>
          Effect.gen(function* () {
            const cards = memoryCards();
            const taskProgress = boundTaskProgress(cards.commands);
            const codex = fakeCodex(rolloutPath);
            const adapter = makeCodexAdapterV2({
              instanceId: CODEX_DEFAULT_INSTANCE_ID,
              settings: DEFAULT_CODEX_SETTINGS,
              environment: {},
              clientFactory: codex.factory,
              fileSystem: fs,
              idAllocator: yield* IdAllocatorV2,
              serverConfig: yield* makeReplayServerConfig("task-card-resume").pipe(Effect.orDie),
              taskProgress,
            });
            const threadId = ThreadId.make("codex-card-resumed-chat");
            const providerSessionId = ProviderSessionId.make("codex-card-resumed-session");
            const input = { threadId, providerSessionId, modelSelection, runtimePolicy };
            // The thread started under the previous engine process.
            const before = yield* Scope.make();
            const providerThread = yield* (yield* adapter
              .openSession(input)
              .pipe(Scope.provide(before))).ensureThread({
              threadId,
              modelSelection,
              runtimePolicy,
            });
            yield* Scope.close(before, Exit.void);
            // The new process resumes it.
            const runtime = yield* adapter.openSession(input);
            yield* runtime.resumeThread({
              threadId,
              providerThread,
              modelSelection,
              runtimePolicy,
            });
            const call = yield* codex.call(ROOT, "exarch_progress_card", { markdown: "Resumed" });
            return { claimed: taskProgress.claimed(threadId), call, written: cards.written };
          });

        const restored = yield* resume(withTools);
        assert.isTrue(restored.claimed);
        assert.isTrue(restored.call.success);
        assert.lengthOf(restored.written, 1);

        // Started before the card tools, or a rollout that cannot be read:
        // Codex has no card tool for it, so the MCP writer stays open.
        for (const rolloutPath of [withoutTools, `${dir}/missing.jsonl`]) {
          const missing = yield* resume(rolloutPath);
          assert.isFalse(missing.claimed);
          assert.deepEqual(missing.written, []);
        }
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
  );
});
