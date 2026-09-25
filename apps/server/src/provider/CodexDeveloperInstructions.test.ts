import { describe, expect, it } from "vite-plus/test";
import {
  buildCodexAdditionalContext,
  buildCodexDeveloperInstructions,
} from "./CodexDeveloperInstructions.ts";

const contextText = (...args: Parameters<typeof buildCodexAdditionalContext>) =>
  Object.values(buildCodexAdditionalContext(...args))
    .map((entry) => entry.value)
    .join("\n\n");
const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" };
const BROWSER_BULLET = "- Interactive browser work: Use Exarch's `preview_*` tools";
const DEVICE_BULLET = "- Device work: Use Exarch's `device_*` discovery";
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("buildCodexDeveloperInstructions", () => {
  it.each(["plan", "default"] as const)(
    "carries the standing Exarch block once after the %s mode text",
    (mode) => {
      const instructions = buildCodexDeveloperInstructions(mode) + "\n\n" + contextText(runtime);
      expect(instructions.startsWith("<collaboration_mode>")).toBe(true);
      expect(count(instructions, "<exarch_instructions>")).toBe(1);
      expect(instructions.indexOf("</collaboration_mode>")).toBeLessThan(
        instructions.indexOf("<runtime_info>"),
      );
      expect(instructions.indexOf("<runtime_info>")).toBeLessThan(
        instructions.indexOf("<exarch_instructions>"),
      );
      expect(instructions).toContain("link_pull_request");
      expect(instructions).toContain("as gpt-5.3-codex with high reasoning effort");
    },
  );

  it("keeps the plan-mode rules", () => {
    const instructions = buildCodexDeveloperInstructions("plan");
    expect(instructions).toMatch(/^<collaboration_mode># Plan Mode/);
    expect(instructions).toContain(
      "You are in **Plan Mode** until a developer message explicitly ends it.",
    );
    expect(instructions).toContain("request_user_input");
    expect(instructions).toContain("<proposed_plan>");
    expect(buildCodexDeveloperInstructions("default")).toMatch(
      /^<collaboration_mode># Collaboration Mode: Default/,
    );
  });

  it.each(["plan", "default"] as const)("drops the old T3 Code headings in %s mode", (mode) => {
    for (const availability of [true, false, { browser: true, device: true }]) {
      const instructions = contextText(runtime, availability);
      expect(instructions).not.toContain("T3 Code orchestration");
      expect(instructions).not.toContain("T3 Code collaborative browser");
      expect(instructions).not.toContain("T3 Code devices");
      expect(instructions).not.toContain("delegate_task");
    }
  });

  it("gates the browser and device rules on the attached tool families", () => {
    const both = contextText(runtime, {
      browser: true,
      device: true,
    });
    expect(both).toContain(BROWSER_BULLET);
    expect(both).toContain(DEVICE_BULLET);

    const browserOnly = contextText(runtime, true);
    expect(browserOnly).toContain(BROWSER_BULLET);
    expect(browserOnly).not.toContain(DEVICE_BULLET);

    const none = contextText(runtime, false);
    expect(none).not.toContain(BROWSER_BULLET);
    expect(none).not.toContain(DEVICE_BULLET);
    expect(none).toContain("<exarch_instructions>");
    expect(none).not.toContain("</collaboration_mode>");
  });

  it("appends the project's session files once at the end", () => {
    const block = "<session_files>Project standing instructions.</session_files>";
    const instructions = contextText({
      ...runtime,
      sessionContext: block,
    });
    expect(count(instructions, "<session_files>")).toBe(1);
    expect(instructions.endsWith(block)).toBe(true);
    expect(buildCodexDeveloperInstructions("default")).not.toContain("session_files");
  });
});
