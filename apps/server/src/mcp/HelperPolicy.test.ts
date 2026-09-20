import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type HelperPolicy,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveHelperTask } from "./HelperPolicy.ts";
const codex = ProviderInstanceId.make("codex"),
  claude = ProviderInstanceId.make("claude");
const parent = {
  thread: {
    projectId: ProjectId.make("project"),
    modelSelection: { instanceId: codex, model: "astra" },
  },
} as OrchestrationV2ThreadProjection;
const providers = [
  { instanceId: codex, driver: ProviderDriverKind.make("codex"), model: "astra" },
  { instanceId: claude, driver: ProviderDriverKind.make("claudeAgent"), model: "fable" },
].map(({ model, ...provider }) => ({
  ...provider,
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  models: [{ slug: model }],
})) as unknown as ServerProvider[];
const policy: HelperPolicy = {
  enabled: true,
  projectOverrides: {},
  visibleModels: [
    { instanceId: codex, model: "astra" },
    { instanceId: claude, model: "fable" },
  ],
  taskTypes: [
    {
      name: "Review",
      whenToUse: "Find defects",
      model: null,
      effort: "high",
      familyRule: {
        differentFromParent: true,
        allowedDrivers: [ProviderDriverKind.make("codex"), ProviderDriverKind.make("claudeAgent")],
      },
    },
  ],
};
const resolve = (change: Partial<Parameters<typeof resolveHelperTask>[0]> = {}) =>
  resolveHelperTask({
    policy,
    parent,
    providers,
    availableInstanceIds: new Set([codex, claude]),
    taskType: "Review",
    ...change,
  });
describe("helper task policy", () => {
  it("selects the visible other family and its effort option", () => {
    expect(resolve().modelSelection).toEqual({
      instanceId: claude,
      model: "fable",
      options: [{ id: "effort", value: "high" }],
    });
  });
  it("refuses disabled and unknown task types", () => {
    expect(() => resolve({ policy: { ...policy, enabled: false } })).toThrow("turned off");
    expect(() => resolve({ taskType: "Research" })).toThrow("not in the owner's table");
  });
  it("treats hidden models as absent and refuses when none satisfy the row", () => {
    expect(() =>
      resolve({ policy: { ...policy, visibleModels: [policy.visibleModels[0]!] } }),
    ).toThrow("no visible");
  });
  it("falls back when a configured model is gone", () => {
    expect(
      resolve({
        policy: {
          ...policy,
          taskTypes: [
            {
              ...policy.taskTypes[0]!,
              model: { driverKind: ProviderDriverKind.make("claudeAgent"), model: "gone" },
            },
          ],
        },
      }).modelSelection.model,
    ).toBe("fable");
  });
  it("refuses a visible override that breaks the family rule", () => {
    expect(() => resolve({ override: { instanceId: codex, model: "astra" } })).toThrow("forbids");
  });
  it("applies project choices and ignores unavailable accounts", () => {
    expect(() =>
      resolve({
        policy: { ...policy, projectOverrides: { [parent.thread.projectId]: { enabled: false } } },
      }),
    ).toThrow("turned off");
    expect(() => resolve({ availableInstanceIds: new Set([codex]) })).toThrow("no visible");
  });
});
