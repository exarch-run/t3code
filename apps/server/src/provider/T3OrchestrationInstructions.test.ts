import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  type T3AcpInstructionState,
} from "./T3OrchestrationInstructions.ts";

const runtimeBlock =
  "<runtime_info>fixture runtime block</runtime_info>\n\n<exarch_instructions>\nfixture standing block\n</exarch_instructions>\n\n# Session files\n\nfixture session file";

const defaultState: T3AcpInstructionState = {
  interactionMode: "default",
  hasT3Mcp: true,
  browser: true,
  device: false,
};

describe("ACP prompt instructions", () => {
  it("briefs a new ACP session with the mode note, the runtime block, and the ACP fallback", () => {
    const prompt = "Inspect the repository.";
    const injected = t3AcpPromptWithInstructions({
      prompt,
      state: defaultState,
      runtimeInstructions: runtimeBlock,
    });

    assert.isTrue(injected.startsWith("<t3_code_instructions>\n"));
    assert.include(injected, "T3 Code interaction mode: Default");
    assert.include(injected, runtimeBlock);
    assert.include(injected, T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS);
    assert.isTrue(
      injected.endsWith(`</t3_code_instructions>\n\n<user_request>\n${prompt}\n</user_request>`),
    );
    assert.isBelow(injected.indexOf("interaction mode"), injected.indexOf(runtimeBlock));
    assert.isBelow(injected.indexOf(runtimeBlock), injected.indexOf("## ACP tool fallback"));
  });

  it("names the delegate_task family as taskType in the terminal fallback", () => {
    assert.include(
      T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
      '"taskType":"<from orchestrator_capabilities>"',
    );
    assert.notInclude(T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS, '"target"');
  });

  it("returns the bare prompt while the session state is unchanged", () => {
    assert.equal(
      t3AcpPromptWithInstructions({
        prompt: "Continue.",
        state: defaultState,
        previousState: { ...defaultState },
        runtimeInstructions: runtimeBlock,
      }),
      "Continue.",
    );
  });

  it("re-sends the block when the interaction mode changes", () => {
    const planned = t3AcpPromptWithInstructions({
      prompt: "Plan this change.",
      state: { ...defaultState, interactionMode: "plan" },
      previousState: defaultState,
      runtimeInstructions: runtimeBlock,
    });

    assert.include(planned, "T3 Code interaction mode: Plan");
    assert.notInclude(planned, "T3 Code interaction mode: Default");
    assert.include(planned, runtimeBlock);
    assert.include(planned, "<user_request>\nPlan this change.\n</user_request>");
  });

  it("re-sends the block when browser or device access changes", () => {
    for (const next of [
      { ...defaultState, browser: false },
      { ...defaultState, device: true },
    ]) {
      const injected = t3AcpPromptWithInstructions({
        prompt: "Continue.",
        state: next,
        previousState: defaultState,
        runtimeInstructions: runtimeBlock,
      });
      assert.include(injected, runtimeBlock);
      assert.include(injected, "<user_request>\nContinue.\n</user_request>");
    }
  });

  it("omits the ACP fallback when the t3-code server is not attached", () => {
    const withoutMcp = t3AcpPromptWithInstructions({
      prompt: "Continue.",
      state: { ...defaultState, hasT3Mcp: false },
      runtimeInstructions: "<runtime_info>plain</runtime_info>",
    });

    assert.include(withoutMcp, "T3 Code interaction mode: Default");
    assert.include(withoutMcp, "<runtime_info>plain</runtime_info>");
    assert.notInclude(withoutMcp, "## ACP tool fallback");
  });

  it("leaves a native slash command prompt untouched", () => {
    assert.equal(
      t3AcpPromptWithInstructions({
        prompt: "/compact",
        state: defaultState,
        runtimeInstructions: runtimeBlock,
      }),
      "/compact",
    );
  });
});
