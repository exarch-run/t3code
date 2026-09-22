// @effect-diagnostics globalConsole:off -- the section-size printout is the project's instruction size measurement and must reach the test runner's stdout.
import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions, runtimeInstructionSections } from "./RuntimeInstructions.ts";
import { setProgressInstructionsEnabled } from "../exarch/TaskProgressRuntime.ts";

const ALL_TOOLS = { t3Mcp: true, browser: true, device: true } as const;
const BROWSER_BULLET = "- Interactive browser work: Use Exarch's `preview_*` tools";
const DEVICE_BULLET = "- Device work: Use Exarch's `device_*` discovery";

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("buildRuntimeInstructions", () => {
  it("adds the standing Exarch block when the t3-code MCP server is attached", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex", capabilities: ALL_TOOLS });
    expect(count(instructions, "<exarch_instructions>")).toBe(1);
    expect(count(instructions, "</exarch_instructions>")).toBe(1);
    expect(instructions).toContain("Read the named workflow guide with `exarch_guide`");
    expect(instructions).toContain(
      "For PRs you create or work on, immediately register each with `link_pull_request`",
    );
    expect(instructions).toContain("use `list_thread_pull_requests` and register missing ones");
    expect(instructions).toContain("Markdown absolute paths embed images/video");
  });

  it("gates the browser and device rules on the attached tool families", () => {
    const both = buildRuntimeInstructions({ harness: "Codex", capabilities: ALL_TOOLS });
    expect(both).toContain(BROWSER_BULLET);
    expect(both).toContain(DEVICE_BULLET);
    expect(both.indexOf(BROWSER_BULLET)).toBeLessThan(both.indexOf(DEVICE_BULLET));

    const browserOnly = buildRuntimeInstructions({
      harness: "Codex",
      capabilities: { t3Mcp: true, browser: true, device: false },
    });
    expect(browserOnly).toContain(BROWSER_BULLET);
    expect(browserOnly).not.toContain(DEVICE_BULLET);

    const deviceOnly = buildRuntimeInstructions({
      harness: "Codex",
      capabilities: { t3Mcp: true, browser: false, device: true },
    });
    expect(deviceOnly).not.toContain(BROWSER_BULLET);
    expect(deviceOnly).toContain(DEVICE_BULLET);

    const neither = buildRuntimeInstructions({
      harness: "Codex",
      capabilities: { t3Mcp: true, browser: false, device: false },
    });
    expect(neither).toContain("<exarch_instructions>");
    expect(neither).not.toContain("preview_*");
    expect(neither).not.toContain("device_*");
  });

  it("leaves the standing block out without the t3-code MCP server", () => {
    for (const instructions of [
      buildRuntimeInstructions({ harness: "Codex" }),
      buildRuntimeInstructions({
        harness: "Codex",
        capabilities: { t3Mcp: false, browser: true, device: true },
      }),
    ]) {
      expect(instructions).not.toContain("exarch_instructions");
      expect(instructions).not.toContain("link_pull_request");
      expect(instructions).not.toContain("exarch_guide");
      expect(instructions).not.toContain("preview_*");
      expect(instructions).toContain("<runtime_info>");
    }
  });

  it("orders the sections runtime info, standing block, task card, session files", () => {
    const block = "<session_files>\n## SOUL.md\n\nBe plain.\n</session_files>";
    const instructions = buildRuntimeInstructions({
      harness: "Claude Code",
      capabilities: ALL_TOOLS,
      sessionContext: block,
    });
    const positions = [
      instructions.indexOf("<runtime_info>"),
      instructions.indexOf("<exarch_instructions>"),
      instructions.indexOf("<task_progress>"),
      instructions.indexOf("<session_files>"),
    ];
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  it.each(["Codex", "Claude Code", "Cursor", "Grok", "OpenCode", "Antigravity"])(
    "tells the %s harness about the task card",
    (harness) => {
      const instructions = buildRuntimeInstructions({ harness });
      expect(instructions).toContain("<task_progress>");
      expect(instructions).toContain("exarch_progress_card");
      expect(instructions).toContain("at least two meaningful sequential steps");
      expect(instructions).toContain(
        "never for greetings, quick questions, or single-step requests",
      );
      expect(instructions).toContain("Update or clear existing cards as needed");
      expect(instructions).not.toContain("write it when you start");
      expect(instructions.indexOf("<runtime_info>")).toBeLessThan(
        instructions.indexOf("<task_progress>"),
      );
    },
  );

  it("leaves the task card out when publishing is disabled", () => {
    expect(buildRuntimeInstructions({ harness: "Codex", taskProgress: false })).not.toContain(
      "task_progress",
    );
    setProgressInstructionsEnabled(false);
    try {
      expect(buildRuntimeInstructions({ harness: "Claude Code" })).not.toContain("task_progress");
      expect(buildRuntimeInstructions({ harness: "Claude Code", taskProgress: true })).toContain(
        "<task_progress>",
      );
    } finally {
      setProgressInstructionsEnabled(true);
    }
    expect(buildRuntimeInstructions({ harness: "Claude Code" })).toContain("<task_progress>");
  });

  it("gives Claude explicit card creation and upkeep points", () => {
    const instructions = buildRuntimeInstructions({ harness: "Claude Code" });
    expect(instructions).toContain("before your first work tool call");
    expect(instructions).toContain("before reasoning about or starting that next phase");
    expect(instructions).toContain("the owner changes direction");
    expect(instructions).toContain("reconciling the card before replying");
    expect(instructions).toContain("Before your final answer");
    expect(buildRuntimeInstructions({ harness: "Codex" })).not.toContain(
      "before your first work tool call",
    );
  });

  it("keeps known model and effort metadata on one line", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Codex",
      model: "  custom\nmodel  ",
      reasoningEffort: " high\n",
    });
    expect(instructions).toContain(
      "you are running in Exarch through the Codex harness, as custom model with high reasoning effort.",
    );
    expect(instructions).not.toMatch(/<runtime_info>[^<]*\n/);
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("running in Exarch through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });

  it("appends the project's session files once after the runtime block and nothing when there are none", () => {
    const block = "<session_files>\n## SOUL.md\n\nBe plain.\n</session_files>";
    const instructions = buildRuntimeInstructions({
      harness: "Claude Code",
      capabilities: ALL_TOOLS,
      sessionContext: block,
    });
    expect(instructions.endsWith(`\n\n${block}`)).toBe(true);
    expect(count(instructions, "<session_files>")).toBe(1);
    expect(
      buildRuntimeInstructions({ harness: "Claude Code", sessionContext: "  " }),
    ).not.toContain("session_files");
    expect(buildRuntimeInstructions({ harness: "Claude Code" })).toBe(
      buildRuntimeInstructions({ harness: "Claude Code", sessionContext: undefined }),
    );
  });

  it("reports the size of each section for Claude Code with every tool family", () => {
    const sections = runtimeInstructionSections({
      harness: "Claude Code",
      capabilities: ALL_TOOLS,
      sessionContext: "<session_files>\n## SOUL.md\n\nBe plain.\n</session_files>",
    });
    expect(sections.runtimeInfo.length).toBeGreaterThan(0);
    expect(sections.standing.length).toBeGreaterThan(0);
    expect(sections.taskProgress.length).toBeGreaterThan(0);
    expect(sections.sessionContext.length).toBeGreaterThan(0);
    // The project's size measurement for the delivered instructions; keep the format stable.
    console.info(
      `runtime-instructions sizes: runtimeInfo=${sections.runtimeInfo.length} standing=${sections.standing.length} taskProgress=${sections.taskProgress.length} sessionContext=${sections.sessionContext.length}`,
    );
  });
});
