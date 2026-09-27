import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { HANDOFF_BYTE_CAP } from "../orchestration-v2/ContextHandoffBudget.ts";
import { createClaudeHandoffContext, restoreClaudeHandoffContext } from "./ClaudeHandoffContext.ts";
import type {
  OrchestrationV2ContextHandoff,
  OrchestrationV2ProviderThread,
} from "@t3tools/contracts";

const base = { session_id: "native", transcript_path: "/unused", cwd: "/tmp" };
const prompt: HookInput = {
  ...base,
  hook_event_name: "UserPromptSubmit",
  prompt: "/skill unchanged",
};
const compact: HookInput = { ...base, hook_event_name: "SessionStart", source: "compact" };
async function deliver(
  state: ReturnType<typeof createClaudeHandoffContext>,
  input: HookInput = prompt,
  signal = new AbortController().signal,
) {
  const hooks = state.hooks[input.hook_event_name]!.at(-1)!.hooks;
  const outputs = await Promise.all(
    [...hooks].reverse().map((hook) => hook(input, undefined, { signal })),
  );
  return outputs
    .flatMap((output: HookJSONOutput) => {
      if (
        !("hookSpecificOutput" in output) ||
        !output.hookSpecificOutput ||
        !("additionalContext" in output.hookSpecificOutput)
      )
        return [];
      return [output.hookSpecificOutput.additionalContext!];
    })
    .sort((a, b) => Number(a.match(/part (\d+)/)![1]) - Number(b.match(/part (\d+)/)![1]));
}
const body = (parts: string[]) => parts.map((part) => part.slice(part.indexOf("\n") + 1)).join("");

describe("Claude retained handoff context", () => {
  it.each(["x".repeat(HANDOFF_BYTE_CAP), "x".repeat(8_999) + "😀" + "Ω".repeat(25_000)])(
    "delivers the complete bounded package in numbered parts",
    async (text) => {
      const state = createClaudeHandoffContext(text, {});
      const outputs = await deliver(state);
      expect(outputs.length).toBeLessThanOrEqual(8);
      expect(outputs.every((output) => output.length < 10_000)).toBe(true);
      expect(outputs.every((output) => output.isWellFormed())).toBe(true);
      expect(body(outputs)).toBe(text);
      expect(await deliver(state)).toEqual([]);
      expect(body(await deliver(state, compact))).toBe(text);
      expect(await deliver(state)).toEqual([]);
    },
  );
  it("does not consume aborted, subagent, or startup hooks and preserves existing hooks", async () => {
    const existing = { hooks: [async () => ({})] };
    const state = createClaudeHandoffContext("accepted", {
      UserPromptSubmit: [existing],
      SessionStart: [existing],
    });
    expect(state.hooks.UserPromptSubmit[0]).toBe(existing);
    expect(state.hooks.SessionStart[0]).toBe(existing);
    expect(await deliver(state, prompt, AbortSignal.abort())).toEqual([]);
    expect(await deliver(state, { ...prompt, agent_id: "child" })).toEqual([]);
    expect(await deliver(state, { ...compact, source: "resume" })).toEqual([]);
    expect(body(await deliver(state))).toBe("accepted");
  });
  it.each(["failed", "interrupted", "cancelled", "blocked"])(
    "replays every part after %s",
    async (status) => {
      const state = createClaudeHandoffContext("context".repeat(4_000), {});
      const first = await deliver(state);
      state.complete(status, 0, false);
      expect(await deliver(state)).toEqual(first);
    },
  );
  it("retries a zero-model prompt but keeps successful compact restoration and query isolation", async () => {
    const state = createClaudeHandoffContext("first", {});
    await deliver(state);
    state.complete("completed", 0, false);
    expect(body(await deliver(state))).toBe("first");
    await deliver(state, compact);
    state.complete("completed", 0, true);
    expect(await deliver(state)).toEqual([]);
    state.update("second");
    expect(body(await deliver(state))).toBe("second");
    state.update("second");
    expect(await deliver(state)).toEqual([]);
    expect(body(await deliver(createClaudeHandoffContext("second", {})))).toBe("second");
  });
  it("restores accepted standing receipts only, with no durable writes or stale native budget", async () => {
    const providerThread = {
      id: "provider-row",
      nativeThreadRef: { nativeId: "native" },
      contextUsage: { usedTokens: 999_999 },
    } as OrchestrationV2ProviderThread;
    const record = (text: string, delivery?: OrchestrationV2ContextHandoff["delivery"]) =>
      ({
        strategy: "manual_context",
        summaryText: text,
        author: "verbatim",
        status: "ready",
        toProviderThreadId: "provider-row",
        threadId: "thread",
        coveredRunOrdinals: { from: 1, to: 1 },
        delivery,
      }) as OrchestrationV2ContextHandoff;
    const handoffs = [
      record("ACCEPTED " + "x".repeat(18_000), {
        nativeThreadId: "native",
        status: "inline",
        contextChannel: "system",
        itemIds: [],
      }),
      record("PENDING", {
        nativeThreadId: "native",
        status: "pending",
        contextChannel: "system",
        itemIds: [],
      }),
      record("NEW"),
      record("OTHER", {
        nativeThreadId: "other",
        status: "inline",
        contextChannel: "system",
        itemIds: [],
      }),
    ];
    const before = structuredClone(handoffs);
    const text = await Effect.runPromise(restoreClaudeHandoffContext({ handoffs, providerThread }));
    expect(text).toContain(handoffs[0]!.summaryText);
    for (const excluded of ["PENDING", "NEW", "OTHER"]) expect(text).not.toContain(excluded);
    expect(handoffs).toEqual(before);
    expect(body(await deliver(createClaudeHandoffContext(text, {}), compact))).toBe(text);
  });
});
