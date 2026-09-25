import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type HelperPolicy,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { explainHelperTask, resolveHelperTask } from "./HelperPolicy.ts";
const codex = ProviderInstanceId.make("codex"),
  claude = ProviderInstanceId.make("claude"),
  cursor = ProviderInstanceId.make("cursor");
const parent = {
  thread: {
    projectId: ProjectId.make("project"),
    modelSelection: { instanceId: codex, model: "astra" },
  },
} as OrchestrationV2ThreadProjection;
const snapshot = (
  instanceId: ProviderInstanceId,
  driver: string,
  models: ReadonlyArray<string>,
  patch: Partial<ServerProvider> = {},
) =>
  ({
    instanceId,
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: models.map((slug) => ({ slug })),
    ...patch,
  }) as unknown as ServerProvider;
const providers = [snapshot(codex, "codex", ["astra"]), snapshot(claude, "claudeAgent", ["fable"])];
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
    nowMs: 0,
    ...change,
  });
const explain = (change: Partial<Parameters<typeof explainHelperTask>[0]> = {}) =>
  explainHelperTask({
    policy,
    parent,
    providers,
    availableInstanceIds: new Set([codex, claude]),
    taskType: "Review",
    nowMs: 0,
    ...change,
  });
const reasonOf = (change: Partial<Parameters<typeof explainHelperTask>[0]> = {}) => {
  const resolution = explain(change);
  if (resolution.ok) throw new Error(`expected a refusal, got ${resolution.modelSelection.model}`);
  return resolution.reason;
};
describe("helper task policy", () => {
  it("selects the visible other family and its effort option", () => {
    expect(resolve().modelSelection).toEqual({
      instanceId: claude,
      model: "fable",
      options: [{ id: "effort", value: "high" }],
    });
    expect(resolve().family).toBe("claude");
  });
  it("refuses disabled and unknown task types", () => {
    expect(() => resolve({ policy: { ...policy, enabled: false } })).toThrow("turned off");
    expect(() => resolve({ taskType: "Research" })).toThrow("not in the owner's table");
  });
  it("treats hidden models as absent and names the conflicting family rule", () => {
    const reason = reasonOf({ policy: { ...policy, visibleModels: [policy.visibleModels[0]!] } });
    expect(reason).toContain("different from the parent (gpt)");
    expect(reason).toContain("gpt is the only family available");
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
    const reason = reasonOf({ availableInstanceIds: new Set([codex]) });
    expect(reason).toContain("only family available");
    expect(reason).toContain("claude/fable: Provider 'claude' has no orchestration adapter");
  });
});
describe("helper task reasons and families", () => {
  it("says helpers-off is a Settings choice that leaves native subagents alone", () => {
    expect(reasonOf({ policy: { ...policy, enabled: false } })).toContain(
      "native subagents are unaffected",
    );
  });
  it("names the requested family and why no native route for it is signed in", () => {
    const reason = reasonOf({
      providers: [
        providers[0]!,
        snapshot(claude, "claudeAgent", ["fable"], { auth: { status: "unauthenticated" } }),
      ],
      policy: {
        ...policy,
        taskTypes: [
          {
            ...policy.taskTypes[0]!,
            familyRule: {
              differentFromParent: false,
              allowedDrivers: [ProviderDriverKind.make("claudeAgent")],
            },
          },
        ],
      },
    });
    expect(reason).toContain("allows only claude");
    expect(reason).toContain("claude/fable: Provider 'claude' is not signed in.");
  });
  it("judges the parent rule by the model's family, not the driver that runs it", () => {
    // A Cursor instance is not the parent's driver, but its gpt model is the
    // parent's family; the Claude model on the same driver satisfies the rule.
    const multi = snapshot(cursor, "cursor", ["gpt-5", "claude-sonnet-4-6"]);
    const resolution = explain({
      providers: [providers[0]!, multi],
      availableInstanceIds: new Set([codex, cursor]),
      policy: {
        ...policy,
        visibleModels: [
          { instanceId: cursor, model: "gpt-5" },
          { instanceId: cursor, model: "claude-sonnet-4-6" },
        ],
        taskTypes: [
          {
            ...policy.taskTypes[0]!,
            familyRule: { differentFromParent: true, allowedDrivers: [] },
          },
        ],
      },
    });
    expect(resolution.ok && resolution.modelSelection.model).toBe("claude-sonnet-4-6");
    expect(resolution.ok && resolution.family).toBe("claude");
  });
  it("reports an Exarch private route as private with the lab behind it", () => {
    const zdr = ProviderInstanceId.make("zdr-anthropic");
    const resolution = explain({
      providers: [providers[0]!, snapshot(zdr, "claudeAgent", ["claude-opus-4-1"])],
      availableInstanceIds: new Set([codex, zdr]),
      policy: { ...policy, visibleModels: [{ instanceId: zdr, model: "claude-opus-4-1" }] },
    });
    expect(resolution.ok && resolution.family).toBe("private");
  });
});
describe("helper accounts", () => {
  const second = ProviderInstanceId.make("claude_second");
  const now = Date.parse("2026-09-25T12:00:00.000Z");
  const later = "2026-09-25T15:00:00.000Z";
  const usage = (windows: ReadonlyArray<Record<string, unknown>>) =>
    ({
      usageLimits: { checkedAt: "2026-09-25T11:59:00.000Z", windows },
    }) as Partial<ServerProvider>;
  const session = (usedPercent: number, resetsAt?: string) => ({
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
  });
  const claudes = (first: Partial<ServerProvider>, other: Partial<ServerProvider>) => ({
    providers: [
      providers[0]!,
      snapshot(claude, "claudeAgent", ["fable", "claude-opus-5-5"], first),
      snapshot(second, "claudeAgent", ["fable", "claude-opus-5-5"], other),
    ],
    availableInstanceIds: new Set([codex, claude, second]),
    policy: {
      ...policy,
      visibleModels: [
        ...policy.visibleModels,
        { instanceId: second, model: "fable" },
        { instanceId: claude, model: "claude-opus-5-5" },
        { instanceId: second, model: "claude-opus-5-5" },
      ],
    },
    nowMs: now,
  });
  const instanceOf = (resolution: ReturnType<typeof explain>) =>
    resolution.ok ? resolution.modelSelection.instanceId : resolution.reason;

  it("runs the chosen model on the matching account with the most room", () => {
    expect(instanceOf(explain(claudes(usage([session(80)]), usage([session(10)]))))).toBe(second);
    expect(instanceOf(explain(claudes(usage([session(10)]), usage([session(10)]))))).toBe(claude);
  });
  it("skips an account that is out of usage and names it when none is left", () => {
    expect(instanceOf(explain(claudes(usage([session(100, later)]), usage([session(90)]))))).toBe(
      second,
    );
    const reason = reasonOf(claudes(usage([session(100, later)]), usage([session(100)])));
    expect(reason).toContain(`Account 'claude' is out of usage until ${later}.`);
    expect(reason).toContain("Account 'claude_second' is out of usage.");
  });
  it("uses an account again once its spent window has reset", () => {
    expect(
      instanceOf(explain(claudes(usage([session(100, "2026-09-25T11:00:00.000Z")]), usage([])))),
    ).toBe(claude);
  });
  it("lets a spent per-model weekly window block only that model", () => {
    const opusSpent = usage([
      session(10),
      {
        id: "seven_day_opus",
        kind: "weekly",
        label: "Weekly · Opus",
        usedPercent: 100,
        resetsAt: later,
      },
    ]);
    const opusRow = {
      ...policy.taskTypes[0]!,
      model: { driverKind: ProviderDriverKind.make("claudeAgent"), model: "claude-opus-5-5" },
    };
    const input = claudes(opusSpent, usage([session(50)]));
    expect(instanceOf(explain(input))).toBe(claude);
    expect(
      instanceOf(explain({ ...input, policy: { ...input.policy, taskTypes: [opusRow] } })),
    ).toBe(second);
  });
  it("keeps an exact account the owner chose for one helper", () => {
    const input = claudes(usage([session(80)]), usage([session(10)]));
    expect(
      instanceOf(explain({ ...input, override: { instanceId: claude, model: "fable" } })),
    ).toBe(claude);
  });
});
