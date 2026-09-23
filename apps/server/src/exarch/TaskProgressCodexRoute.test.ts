import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ExarchToolkit } from "../mcp/toolkits/exarch/tools.ts";
import { boundTaskProgress, memoryCards } from "./TaskProgress.testkit.ts";
import { CODEX_TASK_PROGRESS_TOOLS, handleCodexCardCall } from "./TaskProgressCodexRoute.ts";
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
});
