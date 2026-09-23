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
const call = (tool: string, args: unknown = {}) => ({
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
      // An answer that is not a started thread fails rather than passing through.
      yield* startCodexThreadWithCardTools(() => Effect.succeed({}), { cwd: "/workspace" }).pipe(
        Effect.flip,
      );
    }),
  );
});
