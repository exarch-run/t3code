import { ThreadId, type TaskProgressCardV2 } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ExarchToolkit } from "../mcp/toolkits/exarch/tools.ts";
import {
  CODEX_MCP_WRITE_REFUSED,
  CODEX_SUBAGENT_WRITE_REFUSED,
  CODEX_TASK_PROGRESS_TOOLS,
  codexRouted,
  registerCodexRoute,
} from "./TaskProgressCodexRoute.ts";
import { TASK_PROGRESS_TOOL_JSON_SCHEMA } from "./TaskProgressInput.ts";
import { installBridge, publishProgress } from "./TaskProgressRuntime.ts";

const threadId = ThreadId.make("chat-1");
const parse = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const fakeBridge = () => {
  const written: unknown[] = [];
  let current: TaskProgressCardV2 | null = null;
  const close = installBridge({
    enabled: Effect.succeed(true),
    write: (input) => {
      written.push(input.input);
      current =
        input.input.markdown === undefined && input.input.steps === undefined
          ? null
          : {
              version: 2,
              revision: written.length,
              updatedAt: "2026-01-01T00:00:00.000Z",
              ...(input.input.markdown !== undefined ? { markdown: input.input.markdown } : {}),
              ...(input.input.steps !== undefined ? { steps: input.input.steps } : {}),
            };
      return Effect.succeed({
        card: current,
        revision: written.length,
        updatedAt: "2026-01-01T00:00:00.000Z",
        generation: "g",
        turnId: null,
      });
    },
    read: () =>
      Effect.succeed({
        card: current,
        revision: written.length,
        updatedAt: null,
        generation: "g",
        turnId: null,
      }),
  });
  return { written, close };
};
const call = (tool: string, callThreadId: string, args: unknown = {}) => ({
  tool,
  threadId: callThreadId,
  turnId: "turn-1",
  callId: "call-1",
  arguments: args,
});

describe("Codex task card route", () => {
  it("advertises the writer with the same closed schema and description as the MCP tool", () => {
    const [writer, reader] = CODEX_TASK_PROGRESS_TOOLS;
    expect(writer).toMatchObject({ type: "function", name: "exarch_progress_card" });
    expect(writer?.inputSchema).toBe(TASK_PROGRESS_TOOL_JSON_SCHEMA);
    expect(writer?.description).toBe(ExarchToolkit.tools.exarch_progress_card.description);
    expect(reader).toMatchObject({ type: "function", name: "exarch_progress_card_read" });
  });

  it("writes for the chat's own thread and turns helper threads away before any write", async () => {
    const bridge = fakeBridge();
    const route = registerCodexRoute({ threadId, root: Effect.succeed("root-thread") });
    try {
      expect(codexRouted(threadId)).toBe(true);
      const helper = await Effect.runPromise(
        route.handle(call("exarch_progress_card", "helper-thread", { markdown: "From a helper" })),
      );
      expect(helper).toEqual({
        success: false,
        contentItems: [{ type: "inputText", text: CODEX_SUBAGENT_WRITE_REFUSED }],
      });
      expect(bridge.written).toEqual([]);
      const parent = await Effect.runPromise(
        route.handle(
          call("exarch_progress_card", "root-thread", {
            markdown: "Parent",
            plan: [
              { step: "Read", status: "completed" },
              { step: "Patch", status: "in_progress" },
            ],
          }),
        ),
      );
      expect(parent.success).toBe(true);
      expect(
        parse(parent.contentItems[0]!.type === "inputText" ? parent.contentItems[0]!.text : ""),
      ).toEqual({
        message: "Progress card updated (rev 1, 1/2 done)",
        revision: 1,
        steps: { completed: 1, total: 2 },
      });
      expect(bridge.written).toHaveLength(1);
      const read = await Effect.runPromise(
        route.handle(call("exarch_progress_card_read", "root-thread")),
      );
      expect(
        parse(read.contentItems[0]!.type === "inputText" ? read.contentItems[0]!.text : ""),
      ).toMatchObject({
        card: { revision: 1, markdown: "Parent" },
      });
      const helperRead = await Effect.runPromise(
        route.handle(call("exarch_progress_card_read", "helper-thread")),
      );
      expect(helperRead.success).toBe(false);
      const unknown = await Effect.runPromise(route.handle(call("something_else", "root-thread")));
      expect(unknown).toMatchObject({ success: false });
      const invalid = await Effect.runPromise(
        route.handle(call("exarch_progress_card", "root-thread", { markdown: "x", steps: [] })),
      );
      expect(invalid.success).toBe(false);
      expect(invalid.contentItems[0]).toMatchObject({
        text: expect.stringContaining('unknown field "steps"'),
      });
      expect(bridge.written).toHaveLength(1);
      // Before the thread has started there is no root to match, so nothing writes.
      const early = registerCodexRoute({
        threadId: ThreadId.make("chat-2"),
        root: Effect.succeed(null),
      });
      try {
        expect(
          (
            await Effect.runPromise(
              early.handle(call("exarch_progress_card", "x", { markdown: "y" })),
            )
          ).success,
        ).toBe(false);
      } finally {
        early.close();
      }
    } finally {
      route.close();
      bridge.close();
    }
    expect(codexRouted(threadId)).toBe(false);
  });

  it("refuses the MCP writer for a routed chat and accepts it again once the route closes", async () => {
    const bridge = fakeBridge();
    const route = registerCodexRoute({ threadId, root: Effect.succeed("root-thread") });
    try {
      const refused = await Effect.runPromise(
        Effect.result(publishProgress(threadId, { markdown: "Via MCP" })),
      );
      expect(refused._tag).toBe("Failure");
      expect(refused._tag === "Failure" ? refused.failure.detail : "").toBe(
        CODEX_MCP_WRITE_REFUSED,
      );
      expect(bridge.written).toEqual([]);
      const other = await Effect.runPromise(
        publishProgress(ThreadId.make("chat-3"), { markdown: "Other chat" }),
      );
      expect(other.revision).toBe(1);
    } finally {
      route.close();
    }
    try {
      expect(
        (await Effect.runPromise(publishProgress(threadId, { markdown: "After close" }))).revision,
      ).toBe(2);
    } finally {
      bridge.close();
    }
  });
});
