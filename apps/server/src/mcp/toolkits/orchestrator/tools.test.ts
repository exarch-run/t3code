import { assert, describe, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import {
  CreateThreadsTool,
  DelegateTaskTool,
  OrchestratorCapabilitiesTool,
  ScheduleTaskTool,
  ThreadUpdateTool,
} from "./tools.ts";

describe("orchestrator MCP tool guidance", () => {
  it("keeps delegation on the owner's task table and away from ordinary threads", () => {
    assert.include(DelegateTaskTool.description ?? "", "exact taskType");
    assert.include(DelegateTaskTool.description ?? "", "Do not supply target");
    assert.include(CreateThreadsTool.description ?? "", "not delegation");
    assert.include(CreateThreadsTool.description ?? "", "call delegate_task");
    const schema = Tool.getJsonSchema(DelegateTaskTool) as {
      readonly required?: ReadonlyArray<string>;
    };
    assert.notInclude(schema.required ?? [], "target");
  });

  it("tells agents capabilities report family and unavailable reasons from live settings", () => {
    const description = OrchestratorCapabilitiesTool.description ?? "";
    assert.include(description, "family");
    assert.include(description, "not the driver");
    assert.include(description, "unavailableReason");
    assert.include(description, "without a session restart");
    assert.include(description, "helpers-off from a missing tool");
  });

  it("documents wait timeout as a parent budget, not a child failure", () => {
    const schema = Tool.getJsonSchema(DelegateTaskTool) as {
      readonly properties?: Readonly<
        Record<
          string,
          {
            readonly description?: unknown;
            readonly anyOf?: ReadonlyArray<{ readonly description?: unknown }>;
          }
        >
      >;
    };
    const mode = schema.properties?.mode;
    const timeoutMs = schema.properties?.timeoutMs;
    const modeText = [mode?.description, ...(mode?.anyOf ?? []).map((entry) => entry.description)]
      .filter((value) => typeof value === "string")
      .join(" ");
    const timeoutText = [
      timeoutMs?.description,
      ...(timeoutMs?.anyOf ?? []).map((entry) => entry.description),
    ]
      .filter((value) => typeof value === "string")
      .join(" ");
    assert.include(modeText, "Defaults to async");
    assert.include(timeoutText, "does not cancel the child");
  });

  it("publishes an actionable schedule schema and compatibility string branch", () => {
    const schema = Tool.getJsonSchema(ScheduleTaskTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<
        Record<string, { readonly description?: unknown; readonly anyOf?: ReadonlyArray<unknown> }>
      >;
    };

    assert.equal(schema.type, "object");
    assert.isString(schema.properties?.schedule?.description);
    assert.isAtLeast(schema.properties?.schedule?.anyOf?.length ?? 0, 2);
    assert.include(ScheduleTaskTool.description ?? "", "STRUCTURED OBJECT");
    assert.include(ScheduleTaskTool.description ?? "", "nextRunAt");
  });

  it("publishes thread metadata actions from an object-root schema", () => {
    const schema = Tool.getJsonSchema(ThreadUpdateTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
    };

    assert.equal(schema.type, "object");
    assert.hasAllKeys(schema.properties ?? {}, [
      "threadId",
      "action",
      "title",
      "pullRequest",
      "clientRequestId",
    ]);
    assert.include(ThreadUpdateTool.description ?? "", "Workspace and branch changes");
  });
});
