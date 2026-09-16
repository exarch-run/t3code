import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";
import { setProgressInstructionsEnabled } from "../strata/TaskProgressRuntime.ts";

describe("buildRuntimeInstructions", () => {
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the t3-code MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it.each(["Codex", "Claude Code", "Cursor", "Grok", "OpenCode", "Antigravity"])(
    "tells the %s harness about the task card",
    (harness) => {
      const instructions = buildRuntimeInstructions({ harness });
      expect(instructions).toContain("<task_progress>");
      expect(instructions).toContain("strata_progress_card");
      expect(instructions).toContain("at least two meaningful sequential steps");
      expect(instructions).toContain(
        "never for greetings, quick questions, or single-step requests",
      );
      expect(instructions).toContain("Update or clear existing cards as needed");
      expect(instructions).not.toContain("write it when you start");
      expect(instructions.indexOf("<pull_request_linking>")).toBeLessThan(
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

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });

  it("appends the project's session files after the runtime block and nothing when there are none", () => {
    const block = "<session_files>\n## SOUL.md\n\nBe plain.\n</session_files>";
    const instructions = buildRuntimeInstructions({
      harness: "Claude Code",
      sessionContext: block,
    });
    expect(instructions.endsWith(`\n\n${block}`)).toBe(true);
    expect(instructions.indexOf("<runtime_info>")).toBeLessThan(
      instructions.indexOf("<session_files>"),
    );
    expect(
      buildRuntimeInstructions({ harness: "Claude Code", sessionContext: "  " }),
    ).not.toContain("session_files");
    expect(buildRuntimeInstructions({ harness: "Claude Code" })).toBe(
      buildRuntimeInstructions({ harness: "Claude Code", sessionContext: undefined }),
    );
  });
});
