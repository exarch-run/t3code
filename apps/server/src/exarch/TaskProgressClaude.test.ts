import { ThreadId, type TaskProgressCardV2 } from "@t3tools/contracts";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { claudeTaskProgressHooks } from "./TaskProgressClaude.ts";
import { installBridge } from "./TaskProgressRuntime.ts";

const threadId = ThreadId.make("claude-card");
const card: TaskProgressCardV2 = {
  version: 2,
  revision: 3,
  updatedAt: "2026-09-15T12:00:00.000Z",
  markdown: "Checking the last result.",
  steps: [
    { step: "Inspect", status: "completed" },
    { step: "Verify", status: "in_progress" },
  ],
};
let close = () => {};
afterEach(() => close());

function fixture() {
  const reads: ThreadId[] = [];
  let current: TaskProgressCardV2 | null = card;
  let enabled = true;
  let fail = false;
  close = installBridge({
    enabled: Effect.sync(() => enabled),
    read: (id) =>
      Effect.sync(() => {
        reads.push(id);
        if (fail) throw new Error("unreadable store");
        return {
          card: current,
          revision: 3,
          generation: "g",
          updatedAt: card.updatedAt,
          turnId: null,
        };
      }),
    write: () => Effect.die("context restoration must not write"),
  });
  return {
    reads,
    replace: (next: TaskProgressCardV2) => {
      current = next;
    },
    clear: () => {
      current = null;
    },
    disable: () => {
      enabled = false;
    },
    fail: () => {
      fail = true;
    },
  };
}
const base = { session_id: "provider-session", transcript_path: "/tmp/unused", cwd: "/tmp" };
const prompt: HookInput = {
  ...base,
  hook_event_name: "UserPromptSubmit",
  prompt: "Continue, but check the other route.",
};
async function invoke(input: HookInput, signal = new AbortController().signal) {
  const callback = claudeTaskProgressHooks(threadId)[input.hook_event_name]?.[0]?.hooks[0];
  expect(callback).toBeDefined();
  return callback!(input, undefined, { signal });
}

describe("Claude task card context", () => {
  it("restores the canonical card on a new, resumed, or steered prompt without altering the prompt", async () => {
    const state = fixture();
    const original = structuredClone(prompt);
    for (let n = 0; n < 3; n++) {
      const latest = { ...card, revision: card.revision + n, markdown: `Latest result ${n}` };
      state.replace(latest);
      const output = await invoke(prompt);
      expect(output).toMatchObject({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } });
      const context =
        "hookSpecificOutput" in output &&
        output.hookSpecificOutput &&
        "additionalContext" in output.hookSpecificOutput
          ? output.hookSpecificOutput.additionalContext!
          : "";
      expect(JSON.parse(context.split("\n").at(-1)!)).toEqual({
        markdown: latest.markdown,
        plan: latest.steps,
      });
    }
    expect(state.reads).toEqual([threadId, threadId, threadId]);
    expect(prompt).toEqual(original);
  });

  it("restores after compaction and does not duplicate restoration on session startup", async () => {
    const state = fixture();
    expect(
      await invoke({ ...base, hook_event_name: "SessionStart", source: "compact" }),
    ).toMatchObject({
      hookSpecificOutput: { hookEventName: "SessionStart" },
    });
    expect(await invoke({ ...base, hook_event_name: "SessionStart", source: "resume" })).toEqual(
      {},
    );
    expect(state.reads).toEqual([threadId]);
  });

  it("omits cleared cards and respects disabled publishing and subagent ownership", async () => {
    const state = fixture();
    expect(await invoke({ ...prompt, agent_id: "helper" })).toEqual({});
    expect(state.reads).toEqual([]);
    state.clear();
    expect(await invoke(prompt)).toEqual({});
    state.disable();
    expect(await invoke(prompt)).toEqual({});
    expect(state.reads).toEqual([threadId]);
  });

  it("does not stop the user's turn when the card cannot be read or the hook is aborted", async () => {
    fixture().fail();
    expect(await invoke(prompt)).toEqual({});
    expect(await invoke(prompt, AbortSignal.abort())).toEqual({});
  });
});
