import { describe, expect, it } from "vite-plus/test";
import {
  normalizeTaskProgressInput,
  TASK_PROGRESS_TOOL_JSON_SCHEMA,
  TaskProgressInputError,
} from "./TaskProgressInput.ts";

// Cases follow OpenClaw's progress card tests (commit 11921d88, MIT).
describe("normalizeTaskProgressInput", () => {
  const steps = [
    { step: "Inspect", status: "completed" as const },
    { step: "Patch", status: "in_progress" as const },
    { step: "Verify", status: "pending" as const },
  ];

  it("keeps a note, a plan, or both, and treats empty content as a clear", () => {
    expect(normalizeTaskProgressInput({ markdown: "Working" })).toEqual({ markdown: "Working" });
    expect(normalizeTaskProgressInput({ plan: steps })).toEqual({ steps });
    expect(normalizeTaskProgressInput({ markdown: "Working", plan: steps })).toEqual({
      markdown: "Working",
      steps,
    });
    expect(normalizeTaskProgressInput({})).toEqual({});
    expect(normalizeTaskProgressInput(undefined)).toEqual({});
    expect(normalizeTaskProgressInput({ markdown: "  \n ", plan: [] })).toEqual({});
  });

  it.each([[], [{ step: "Read", status: "pending" }], '{"markdown":"Note"}', 7, null, false])(
    "refuses malformed top-level input %j",
    (input) => {
      expect(() => normalizeTaskProgressInput(input)).toThrow("arguments must be an object");
    },
  );

  it("preserves authored whitespace and line endings after stripping invisible characters", () => {
    expect(normalizeTaskProgressInput({ markdown: "  Note\r\ntext‮  " })).toEqual({
      markdown: "  Note\r\ntext  ",
    });
    expect(normalizeTaskProgressInput({ plan: [{ step: " Patch​ ", status: "pending" }] })).toEqual({
      steps: [{ step: " Patch ", status: "pending" }],
    });
  });

  it("accepts the earlier Strata field names from sessions that cached them", () => {
    expect(
      normalizeTaskProgressInput({
        writeId: "native-1",
        markdown: "Halfway",
        plan: [{ text: "Read", status: "completed" }],
      }),
    ).toEqual({ markdown: "Halfway", steps: [{ step: "Read", status: "completed" }] });
  });

  it.each([
    {
      name: "a misnamed checklist",
      args: { markdown: "Note", steps },
      message: 'unknown field "steps"',
    },
    {
      name: "an unknown step field",
      args: { plan: [{ step: "a", status: "pending", note: "x" }] },
      message: "unknown field",
    },
    { name: "a null note", args: { markdown: null }, message: "markdown must be a string" },
    { name: "a null plan", args: { plan: null }, message: "plan must be an array" },
    {
      name: "a step without text",
      args: { plan: [{ status: "pending" }] },
      message: "plan[0].step must be a string",
    },
    {
      name: "an unknown status",
      args: { plan: [{ step: "a", status: "done" }] },
      message: "plan[0].status must be one of",
    },
    {
      name: "multiple active steps",
      args: {
        plan: [
          { step: "One", status: "in_progress" },
          { step: "Two", status: "in_progress" },
        ],
      },
      message: "at most one in_progress",
    },
    {
      name: "too many steps",
      args: {
        plan: Array.from({ length: 51 }, (_, index) => ({
          step: `Step ${index}`,
          status: "pending",
        })),
      },
      message: "at most 50 steps",
    },
    {
      name: "an empty step",
      args: { plan: [{ step: " ​ ", status: "pending" }] },
      message: "must not be empty",
    },
    {
      name: "an oversized step",
      args: { plan: [{ step: "é".repeat(257), status: "pending" }] },
      message: "512 UTF-8 bytes",
    },
    {
      name: "oversized markdown",
      args: { markdown: "é".repeat(4097) },
      message: "8192 UTF-8 bytes",
    },
  ])("rejects $name", ({ args, message }) => {
    expect(() => normalizeTaskProgressInput(args)).toThrow(TaskProgressInputError);
    expect(() => normalizeTaskProgressInput(args)).toThrow(message);
  });

  it("measures limits in UTF-8 bytes at the boundary", () => {
    expect(
      normalizeTaskProgressInput({ plan: [{ step: "a".repeat(512), status: "pending" }] })
        .steps?.[0]?.step.length,
    ).toBe(512);
    expect(() =>
      normalizeTaskProgressInput({ plan: [{ step: "a".repeat(513), status: "pending" }] }),
    ).toThrow("512");
    expect(() =>
      normalizeTaskProgressInput({ plan: [{ step: "😀".repeat(300), status: "pending" }] }),
    ).toThrow("512");
    expect(normalizeTaskProgressInput({ markdown: "a".repeat(8192) }).markdown?.length).toBe(8192);
    expect(() => normalizeTaskProgressInput({ markdown: "a".repeat(8193) })).toThrow("8192");
  });

  it("advertises the closed object the validation accepts", () => {
    expect(TASK_PROGRESS_TOOL_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(Object.keys(TASK_PROGRESS_TOOL_JSON_SCHEMA.properties)).toEqual(["markdown", "plan"]);
    expect(TASK_PROGRESS_TOOL_JSON_SCHEMA.properties.plan.items.additionalProperties).toBe(false);
    expect(TASK_PROGRESS_TOOL_JSON_SCHEMA.properties.plan.items.required).toEqual([
      "step",
      "status",
    ]);
    expect(TASK_PROGRESS_TOOL_JSON_SCHEMA.properties.plan.items.properties.status.enum).toEqual([
      "pending",
      "in_progress",
      "completed",
    ]);
  });
});
