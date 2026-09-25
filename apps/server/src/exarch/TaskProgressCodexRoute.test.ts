import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ExarchToolkit } from "../mcp/toolkits/exarch/tools.ts";
import { boundTaskProgress, memoryCards } from "./TaskProgress.testkit.ts";
import {
  CODEX_TASK_PROGRESS_TOOLS,
  handleCodexCardCall,
  startCodexThreadWithCardTools,
} from "./TaskProgressCodexRoute.ts";
import { TASK_PROGRESS_TOOL_JSON_SCHEMA } from "./TaskProgressInput.ts";

const threadId = ThreadId.make("chat-1");
// The thread/start result recorded from Codex CLI 0.120.0 in
// orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson.
const recordedCli0120ThreadStart = {
  thread: {
    id: "019dadea-f49b-7012-aa03-534f1bfc3181",
    forkedFromId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1776739349,
    updatedAt: 1776739349,
    status: { type: "idle" },
    path: "/Users/julius/.codex/sessions/2026/04/20/rollout-2026-04-20T19-42-29-019dadea-f49b-7012-aa03-534f1bfc3181.jsonl",
    cwd: "/Users/julius/.t3/worktrees/codething-mvp/t3code-c1e5e1d1/packages/effect-codex-app-server",
    cliVersion: "0.120.0",
    source: "vscode",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  },
  model: "gpt-5.4",
  modelProvider: "openai",
  serviceTier: "fast",
  cwd: "/Users/julius/.t3/worktrees/codething-mvp/t3code-c1e5e1d1/packages/effect-codex-app-server",
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: {
    type: "workspaceWrite",
    writableRoots: ["/Users/julius/.codex/memories"],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
  reasoningEffort: "xhigh",
};
const call = (tool: string, args: Parameters<typeof handleCodexCardCall>[2]["arguments"] = {}) => ({
  tool,
  threadId: "root-thread",
  turnId: "turn-1",
  callId: "call-1",
  arguments: args,
});

describe("Codex task card route", () => {
  it("advertises the writer with the same closed schema and description as the MCP tool", () => {
    const [writer, reader] = CODEX_TASK_PROGRESS_TOOLS;
    expect(writer).toMatchObject({
      type: "function",
      name: "exarch_progress_card",
      inputSchema: TASK_PROGRESS_TOOL_JSON_SCHEMA,
      description: ExarchToolkit.tools.exarch_progress_card.description,
    });
    expect(reader).toMatchObject({
      type: "function",
      name: "exarch_progress_card_read",
      description: ExarchToolkit.tools.exarch_progress_card_read.description,
    });
  });

  it.effect("refuses an invalid card or an unknown tool without writing", () =>
    Effect.gen(function* () {
      const cards = memoryCards();
      const taskProgress = boundTaskProgress(cards.commands);
      const invalid = yield* handleCodexCardCall(
        taskProgress,
        threadId,
        call("exarch_progress_card", { markdown: "x", steps: [] }),
      );
      expect(invalid.success).toBe(false);
      expect(invalid.contentItems[0]).toMatchObject({
        text: expect.stringContaining('unknown field "steps"'),
      });
      const unknown = yield* handleCodexCardCall(taskProgress, threadId, call("something_else"));
      expect(unknown).toMatchObject({ success: false });
      expect(cards.written).toEqual([]);
    }),
  );

  it.effect("sends dynamicTools on thread/start and decodes the started thread", () =>
    Effect.gen(function* () {
      const sent: unknown[] = [];
      const started = yield* startCodexThreadWithCardTools(
        (_method, params) =>
          Effect.sync(() => {
            sent.push(params);
            return {
              thread: {
                id: "native-1",
                sessionId: "native-1",
                forkedFromId: null,
                preview: "",
                ephemeral: false,
                modelProvider: "openai",
                createdAt: 1,
                updatedAt: 1,
                status: { type: "idle" },
                path: null,
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
              approvalPolicy: "never",
              approvalsReviewer: "user",
              sandbox: { type: "dangerFullAccess" },
              reasoningEffort: null,
            };
          }),
        { cwd: "/workspace", model: "gpt-5.4" },
      );
      expect(started.thread.id).toBe("native-1");
      expect(sent).toEqual([
        { cwd: "/workspace", model: "gpt-5.4", dynamicTools: CODEX_TASK_PROGRESS_TOOLS },
      ]);
      // Codex CLI 0.120.0 answers without thread.sessionId; the chat still starts.
      const older = yield* startCodexThreadWithCardTools(
        () => Effect.succeed(recordedCli0120ThreadStart),
        { cwd: "/workspace" },
      );
      expect(older.thread).toMatchObject({
        id: "019dadea-f49b-7012-aa03-534f1bfc3181",
        createdAt: 1776739349,
        updatedAt: 1776739349,
        forkedFromId: null,
      });
      // An answer that is not a started thread fails rather than passing through.
      yield* startCodexThreadWithCardTools(() => Effect.succeed({}), { cwd: "/workspace" }).pipe(
        Effect.flip,
      );
    }),
  );
});
