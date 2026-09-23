import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeClaudeQueryOptions } from "./ClaudeAdapterV2.ts";

const BROWSER_BULLET = "- Interactive browser work: Use Exarch's `preview_*` tools";
const DEVICE_BULLET = "- Device work: Use Exarch's `device_*` discovery";
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const mcpServers = {
  "t3-code": {
    type: "http" as const,
    url: "http://127.0.0.1:43123/mcp",
    headers: { Authorization: "Bearer secret-claude-token" },
  },
};

function systemPromptAppend(input: Partial<Parameters<typeof makeClaudeQueryOptions>[0]>): string {
  const options = makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    },
    nativeThreadId: "native-thread-claude-instructions",
    resume: false,
    cwd: "/workspace",
    ...input,
  });
  const systemPrompt = options.systemPrompt as {
    readonly type: string;
    readonly preset: string;
    readonly append?: string;
  };
  expect(systemPrompt.type).toBe("preset");
  expect(systemPrompt.preset).toBe("claude_code");
  return systemPrompt.append ?? "";
}

describe("makeClaudeQueryOptions system prompt", () => {
  it("appends the standing Exarch block once when the t3-code MCP server is attached", () => {
    const append = systemPromptAppend({
      mcpServers,
      exarchTools: { browser: true, device: true },
      sessionContext: "<session_files>Project standing instructions.</session_files>",
      taskProgress: true,
    });
    expect(append).toContain("running in Exarch through the Claude Code harness");
    expect(count(append, "<exarch_instructions>")).toBe(1);
    expect(append).toContain("link_pull_request");
    expect(append).toContain(BROWSER_BULLET);
    expect(append).toContain(DEVICE_BULLET);
    expect(append).toContain("<task_progress>");
    expect(count(append, "<session_files>")).toBe(1);
    expect(append.endsWith("</session_files>")).toBe(true);
    expect(append).not.toContain("T3 Code orchestration");
    expect(append).not.toContain("delegate_task");
  });

  it("gates the browser and device rules on the MCP credential", () => {
    const browserOnly = systemPromptAppend({
      mcpServers,
      exarchTools: { browser: true, device: false },
    });
    expect(browserOnly).toContain(BROWSER_BULLET);
    expect(browserOnly).not.toContain(DEVICE_BULLET);

    const none = systemPromptAppend({ mcpServers, exarchTools: { browser: false, device: false } });
    expect(none).toContain("<exarch_instructions>");
    expect(none).not.toContain(BROWSER_BULLET);
    expect(none).not.toContain(DEVICE_BULLET);

    // Callers predating the capability set attached the browser toolkit only.
    const defaults = systemPromptAppend({ mcpServers });
    expect(defaults).toContain(BROWSER_BULLET);
    expect(defaults).not.toContain(DEVICE_BULLET);
  });

  it("sends the same append when the native session is resumed", () => {
    const fresh = systemPromptAppend({
      mcpServers,
      exarchTools: { browser: true, device: true },
      resume: false,
    });
    const resumed = systemPromptAppend({
      mcpServers,
      exarchTools: { browser: true, device: true },
      resume: true,
    });
    expect(resumed).toBe(fresh);
  });

  it("leaves the standing block out without the t3-code MCP server", () => {
    const append = systemPromptAppend({
      exarchTools: { browser: true, device: true },
      taskProgress: true,
    });
    expect(append).toContain("<runtime_info>");
    expect(append).toContain("<task_progress>");
    expect(append).toContain("before your first work tool call");
    expect(append).not.toContain("exarch_instructions");
    expect(append).not.toContain("link_pull_request");
    expect(append).not.toContain("preview_*");
  });

  it("leaves the task card out when the owner's setting is off", () => {
    const append = systemPromptAppend({ mcpServers, taskProgress: false });
    expect(append).not.toContain("task_progress");
    expect(append).not.toContain("before your first work tool call");
  });
});
