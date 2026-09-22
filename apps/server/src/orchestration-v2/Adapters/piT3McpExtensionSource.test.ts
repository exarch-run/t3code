// @effect-diagnostics nodeBuiltinImport:off - the vm sandbox needs Node's synchronous readFileSync.
import * as NodeFs from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import {
  PI_T3_MCP_EXTENSION_SOURCE,
  T3_PI_INSTRUCTIONS_PATH_ENV,
} from "./piT3McpExtensionSource.ts";

type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;

type AgentStartHook = (event: { systemPrompt: string }) => { systemPrompt: string } | undefined;

type Hooks = {
  readonly requestHook: RequestHook;
  readonly agentStartHook: AgentStartHook;
};

/**
 * Execute the shipped extension with MCP disabled. That path needs no
 * Typebox; `node:fs` is supplied to the sandbox because a vm script cannot
 * hold ESM imports.
 */
async function loadHooks(env: Record<string, string> = {}): Promise<Hooks> {
  const handlers = new Map<string, unknown>();
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "")
      .replace('import { readFileSync } from "node:fs";', "")
      .replace("export default async function", "async function"),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env },
    readFileSync: NodeFs.readFileSync,
    pi: { on: (name: string, handler: unknown) => handlers.set(name, handler) },
  });
  const requestHook = handlers.get("before_provider_request") as RequestHook | undefined;
  const agentStartHook = handlers.get("before_agent_start") as AgentStartHook | undefined;
  assert.isDefined(requestHook);
  assert.isDefined(agentStartHook);
  return { requestHook: requestHook!, agentStartHook: agentStartHook! };
}

describe("Pi upstream output-budget workaround", () => {
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    it(`caps ${key} without changing the conversation or tools`, async () => {
      const { requestHook: hook } = await loadHooks();
      const payload = {
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read" } }],
        [key]: 231_969,
      };
      const result = hook({ payload }, { model: { provider: "openrouter" } });
      assert.equal(result?.[key], 32_768);
      assert.strictEqual(result?.messages, payload.messages);
      assert.strictEqual(result?.tools, payload.tools);
      assert.equal(result?.model, payload.model);
      assert.equal(payload[key], 231_969);
    });
  }

  it("preserves smaller budgets and other providers' payloads", async () => {
    const { requestHook: hook } = await loadHooks();
    for (const payload of [{ max_tokens: 8192 }, { max_completion_tokens: 32_768 }, {}, null]) {
      assert.isUndefined(hook({ payload }, { model: { provider: "openrouter" } }));
    }
    assert.isUndefined(
      hook({ payload: { max_tokens: 231_969 } }, { model: { provider: "anthropic" } }),
    );
  });
});

describe("Pi runtime instructions delivery", () => {
  it("carries no instruction text itself and reads the session file instead", () => {
    assert.include(PI_T3_MCP_EXTENSION_SOURCE, JSON.stringify(T3_PI_INSTRUCTIONS_PATH_ENV));
    assert.notInclude(PI_T3_MCP_EXTENSION_SOURCE, "ORCHESTRATION_INSTRUCTIONS");
    assert.notInclude(PI_T3_MCP_EXTENSION_SOURCE, "<exarch_instructions>");
    assert.notInclude(PI_T3_MCP_EXTENSION_SOURCE, "<runtime_info>");
    assert.notInclude(PI_T3_MCP_EXTENSION_SOURCE, "T3 Code orchestration");
  });

  it("appends the file's contents to the system prompt at every agent start", async () => {
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-pi-instructions-"));
    const file = NodePath.join(dir, "pi-t3-instructions-session.md");
    try {
      NodeFs.writeFileSync(file, "<runtime_info>Pi harness</runtime_info>\n\nsecond block\n");
      const { agentStartHook } = await loadHooks({ [T3_PI_INSTRUCTIONS_PATH_ENV]: file });
      const result = agentStartHook({ systemPrompt: "base prompt" });
      assert.equal(
        result?.systemPrompt,
        "base prompt\n\n<runtime_info>Pi harness</runtime_info>\n\nsecond block",
      );

      // The block is not cached: a rewritten file reaches the next agent start.
      NodeFs.writeFileSync(file, "updated block");
      assert.equal(
        agentStartHook({ systemPrompt: "base prompt" })?.systemPrompt,
        "base prompt\n\nupdated block",
      );
    } finally {
      NodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the system prompt alone when the path is unset, missing, or empty", async () => {
    const unset = await loadHooks();
    assert.isUndefined(unset.agentStartHook({ systemPrompt: "base prompt" }));

    const missing = await loadHooks({
      [T3_PI_INSTRUCTIONS_PATH_ENV]: NodePath.join(NodeOs.tmpdir(), "t3-pi-does-not-exist.md"),
    });
    assert.isUndefined(missing.agentStartHook({ systemPrompt: "base prompt" }));

    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-pi-instructions-"));
    const file = NodePath.join(dir, "empty.md");
    try {
      NodeFs.writeFileSync(file, "\n  \n");
      const empty = await loadHooks({ [T3_PI_INSTRUCTIONS_PATH_ENV]: file });
      assert.isUndefined(empty.agentStartHook({ systemPrompt: "base prompt" }));
    } finally {
      NodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
