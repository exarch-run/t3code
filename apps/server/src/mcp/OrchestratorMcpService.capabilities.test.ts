import { ServerSettingsService } from "../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type HelperPolicy,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import {
  ProviderAdapterRegistryLookupError,
  ProviderAdapterRegistryV2,
} from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const parentThreadId = ThreadId.make("thread:capabilities-parent");
const projectId = ProjectId.make("project:capabilities");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const cursor = ProviderInstanceId.make("cursor");
const zdr = ProviderInstanceId.make("zdr-anthropic");
const tinfoil = ProviderInstanceId.make("private");

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:capabilities"),
  threadId: parentThreadId,
  providerSessionId: "provider-session:capabilities",
  providerInstanceId: codex,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const snapshot = (
  instanceId: ProviderInstanceId,
  driver: string,
  models: ReadonlyArray<string>,
  patch: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-13T00:00:00.000Z",
  models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
  ...patch,
});

const parentProjection = {
  thread: {
    id: parentThreadId,
    projectId,
    modelSelection: { instanceId: codex, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
  },
  runs: [],
  contextTransfers: [],
  subagents: [],
} as unknown as OrchestrationV2ThreadProjection;

const review = (familyRule: HelperPolicy["taskTypes"][number]["familyRule"]) => ({
  name: "Review",
  whenToUse: "Check finished work",
  model: null,
  effort: null,
  familyRule,
});

const capabilitiesWith = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly policy: HelperPolicy;
  readonly adapters?: ReadonlyArray<ProviderInstanceId>;
}) =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    return yield* service.capabilities(scope);
  }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies(input)))));

const dependencies = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly policy: HelperPolicy;
  readonly adapters?: ReadonlyArray<ProviderInstanceId>;
}) => {
  const adapters = input.adapters ?? input.providers.map((provider) => provider.instanceId);
  return Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(ThreadManagementService)({
      getThreadRecords: () => Effect.succeed(parentProjection),
    }),
    Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(input.providers) }),
    Layer.succeed(
      ProviderAdapterRegistryV2,
      ProviderAdapterRegistryV2.of({
        list: () => Effect.succeed(adapters),
        get: (instanceId) =>
          adapters.includes(instanceId)
            ? Effect.succeed({ instanceId } as unknown as ProviderAdapterV2Shape)
            : Effect.fail(new ProviderAdapterRegistryLookupError({ instanceId })),
      }),
    ),
    Layer.mock(ScheduledTaskService)({}),
    ServerSettingsService.layerTest({ helperPolicy: input.policy }),
  );
};

const nativePair = [
  snapshot(codex, "codex", ["gpt-5.4"]),
  snapshot(claude, "claudeAgent", ["claude-sonnet-4-6"]),
];
const bothVisible = [
  { instanceId: codex, model: "gpt-5.4" },
  { instanceId: claude, model: "claude-sonnet-4-6" },
];

describe("orchestrator_capabilities families and reasons", () => {
  it.effect("routes an ordinary native task to the other family and says so", () =>
    Effect.gen(function* () {
      const result = yield* capabilitiesWith({
        providers: nativePair,
        policy: {
          enabled: true,
          projectOverrides: {},
          visibleModels: bothVisible,
          taskTypes: [review({ differentFromParent: true, allowedDrivers: [] })],
        },
      });
      const byId = new Map(result.providers.map((p) => [p.providerInstanceId, p]));
      assert.equal(byId.get(codex)?.family, "gpt");
      assert.equal(byId.get(claude)?.family, "claude");
      assert.deepEqual(
        byId.get(claude)?.models.map((m) => m.family),
        ["claude"],
      );
      assert.isNull(byId.get(claude)?.unavailableReason);
      assert.isTrue(byId.get(claude)?.canRunChildTask);
      assert.isTrue(result.helperTasks.enabled);
      assert.deepEqual(result.taskTypes?.[0]?.resolvedModel, {
        providerInstanceId: claude,
        model: "claude-sonnet-4-6",
        family: "claude",
      });
      assert.isNull(result.taskTypes?.[0]?.unavailableReason);
    }),
  );

  it.effect("resolves a configured same-family task to the parent's family", () =>
    Effect.gen(function* () {
      const result = yield* capabilitiesWith({
        providers: nativePair,
        policy: {
          enabled: true,
          projectOverrides: {},
          visibleModels: bothVisible,
          taskTypes: [
            {
              ...review({ differentFromParent: false, allowedDrivers: [] }),
              name: "Draft",
              model: { driverKind: ProviderDriverKind.make("codex"), model: "gpt-5.4" },
            },
          ],
        },
      });
      assert.deepEqual(result.taskTypes?.[0]?.resolvedModel, {
        providerInstanceId: codex,
        model: "gpt-5.4",
        family: "gpt",
      });
    }),
  );

  it.effect("names the requested family and the sign-in gap when it has no native route", () =>
    Effect.gen(function* () {
      const result = yield* capabilitiesWith({
        providers: [
          nativePair[0]!,
          snapshot(claude, "claudeAgent", ["claude-sonnet-4-6"], {
            auth: { status: "unauthenticated" },
          }),
        ],
        policy: {
          enabled: true,
          projectOverrides: {},
          visibleModels: bothVisible,
          taskTypes: [
            review({
              differentFromParent: false,
              allowedDrivers: [ProviderDriverKind.make("claudeAgent")],
            }),
          ],
        },
      });
      const task = result.taskTypes?.[0];
      assert.deepEqual(task?.familyRule.allowedFamilies, ["claude"]);
      assert.isNull(task?.resolvedModel);
      assert.include(task?.unavailableReason ?? "", "allows only claude");
      assert.include(task?.unavailableReason ?? "", "not signed in");
      const provider = result.providers.find((p) => p.providerInstanceId === claude);
      assert.isFalse(provider?.canRunChildTask);
      assert.equal(provider?.unavailableReason, "Provider is not authenticated.");
    }),
  );

  it.effect("explains a different-from-parent rule when the parent is the only family", () =>
    Effect.gen(function* () {
      const result = yield* capabilitiesWith({
        providers: nativePair,
        policy: {
          enabled: true,
          projectOverrides: {},
          visibleModels: [bothVisible[0]!],
          taskTypes: [review({ differentFromParent: true, allowedDrivers: [] })],
        },
      });
      const task = result.taskTypes?.[0];
      assert.isNull(task?.resolvedModel);
      assert.include(task?.unavailableReason ?? "", "different from the parent (gpt)");
      assert.include(task?.unavailableReason ?? "", "gpt is the only family available");
      const provider = result.providers.find((p) => p.providerInstanceId === claude);
      assert.include(provider?.unavailableReason ?? "", "visible to helpers in Settings");
    }),
  );

  it.effect(
    "reports helpers off as a Settings choice and picks up the change on the next call",
    () =>
      Effect.gen(function* () {
        const deps = dependencies({
          providers: nativePair,
          policy: {
            enabled: false,
            projectOverrides: {},
            visibleModels: bothVisible,
            taskTypes: [review({ differentFromParent: true, allowedDrivers: [] })],
          },
        });
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const settings = yield* ServerSettingsService;
          const off = yield* service.capabilities(scope);
          assert.isFalse(off.helperTasks.enabled);
          assert.isFalse(off.features.appOwnedSubagents);
          assert.include(off.helperTasks.unavailableReason ?? "", "turned off in Settings");
          assert.include(
            off.helperTasks.unavailableReason ?? "",
            "native subagents are unaffected",
          );
          assert.deepEqual(off.taskTypes, []);
          for (const provider of off.providers) {
            assert.isFalse(provider.canRunChildTask);
            assert.deepEqual(provider.constraints, []);
            assert.equal(provider.unavailableReason, off.helperTasks.unavailableReason);
          }

          const current = yield* settings.getSettings;
          yield* settings.updateSettings({
            helperPolicy: { ...current.helperPolicy, enabled: true },
          });
          const on = yield* service.capabilities(scope);
          assert.isTrue(on.helperTasks.enabled);
          assert.isNull(on.helperTasks.unavailableReason);
          assert.equal(on.taskTypes?.[0]?.resolvedModel?.providerInstanceId, claude);
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provideMerge(deps))));
      }),
  );

  it.effect("takes family from the model on multi-lab drivers and marks private routes", () =>
    Effect.gen(function* () {
      const result = yield* capabilitiesWith({
        providers: [
          nativePair[0]!,
          snapshot(cursor, "cursor", ["claude-sonnet-4-6", "gpt-5.4", "gemini-2.5-pro"]),
          snapshot(zdr, "claudeAgent", ["claude-opus-4-1"]),
          snapshot(tinfoil, "opencode", ["tinfoil/llama-3.3-70b", "zero-retention/gpt-5"]),
        ],
        policy: {
          enabled: true,
          projectOverrides: {},
          visibleModels: [
            { instanceId: cursor, model: "claude-sonnet-4-6" },
            { instanceId: cursor, model: "gpt-5.4" },
            { instanceId: cursor, model: "gemini-2.5-pro" },
            { instanceId: zdr, model: "claude-opus-4-1" },
            { instanceId: tinfoil, model: "tinfoil/llama-3.3-70b" },
            { instanceId: tinfoil, model: "zero-retention/gpt-5" },
          ],
          taskTypes: [review({ differentFromParent: true, allowedDrivers: [] })],
        },
      });
      const byId = new Map(result.providers.map((p) => [p.providerInstanceId, p]));
      const cursorEntry = byId.get(cursor);
      assert.isNull(cursorEntry?.family);
      assert.deepEqual(
        cursorEntry?.models.map((m) => [m.id, m.family]),
        [
          ["claude-sonnet-4-6", "claude"],
          ["gpt-5.4", "gpt"],
          ["gemini-2.5-pro", "gemini"],
        ],
      );
      const zdrEntry = byId.get(zdr);
      assert.equal(zdrEntry?.family, "private");
      assert.deepEqual(zdrEntry?.models[0], {
        id: "claude-opus-4-1",
        label: "claude-opus-4-1",
        family: "private",
        labFamily: "claude",
      });
      const tinfoilEntry = byId.get(tinfoil);
      assert.equal(tinfoilEntry?.family, "private");
      assert.deepEqual(
        tinfoilEntry?.models.map((m) => [m.family, m.labFamily]),
        [
          ["private", undefined],
          ["private", "gpt"],
        ],
      );
      // The cursor Claude model is a different family from the gpt parent even
      // though the driver differs for the gpt model too.
      assert.deepEqual(result.taskTypes?.[0]?.resolvedModel, {
        providerInstanceId: cursor,
        model: "claude-sonnet-4-6",
        family: "claude",
      });
    }),
  );
});
