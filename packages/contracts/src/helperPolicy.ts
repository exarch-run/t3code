import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const HelperTaskType = Schema.Struct({
  name: TrimmedNonEmptyString,
  whenToUse: TrimmedNonEmptyString,
  model: Schema.NullOr(
    Schema.Struct({ driverKind: ProviderDriverKind, model: TrimmedNonEmptyString }),
  ),
  effort: Schema.NullOr(TrimmedNonEmptyString),
  familyRule: Schema.Struct({
    differentFromParent: Schema.Boolean,
    allowedDrivers: Schema.Array(ProviderDriverKind),
  }),
});
export type HelperTaskType = typeof HelperTaskType.Type;
// Ordered best-first by the owner's client. Missing entries are unavailable to helpers.
export const HelperVisibleModel = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
const fields = {
  enabled: Schema.Boolean,
  taskTypes: Schema.Array(HelperTaskType),
  visibleModels: Schema.Array(HelperVisibleModel),
};
export const HelperPolicy = Schema.Struct({
  ...fields,
  projectOverrides: Schema.Record(
    ProjectId,
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      taskTypes: Schema.optional(Schema.Array(HelperTaskType)),
      visibleModels: Schema.optional(Schema.Array(HelperVisibleModel)),
    }),
  ),
});
export type HelperPolicy = typeof HelperPolicy.Type;
export const DEFAULT_HELPER_POLICY: HelperPolicy = {
  enabled: false,
  taskTypes: [],
  visibleModels: [],
  projectOverrides: {},
};
export function helperPolicyForProject(policy: HelperPolicy, projectId: ProjectId) {
  const override = policy.projectOverrides[projectId];
  return {
    enabled: override?.enabled ?? policy.enabled,
    taskTypes: override?.taskTypes ?? policy.taskTypes,
    visibleModels: override?.visibleModels ?? policy.visibleModels,
  };
}

/**
 * The model family helpers route by. Drivers with one lab behind them
 * (claudeAgent, codex, grok) name it directly; multi-lab drivers (cursor,
 * opencode, ACP agents, antigravity) take it from the model id. Exarch's
 * private route instances report "private" so agents never mistake a private
 * helper for an ordinary one; `labFamily` still says which lab is behind it.
 */
export const ModelFamily = Schema.Literals(["claude", "gpt", "grok", "gemini", "private", "other"]);
export type ModelFamily = typeof ModelFamily.Type;
export const LabFamily = Schema.Literals(["claude", "gpt", "grok", "gemini", "other"]);
export type LabFamily = typeof LabFamily.Type;

const DRIVER_FAMILIES: Readonly<Record<string, LabFamily>> = {
  claudeAgent: "claude",
  codex: "gpt",
  grok: "grok",
};
const VENDOR_FAMILIES: Readonly<Record<string, LabFamily>> = {
  anthropic: "claude",
  openai: "gpt",
  google: "gemini",
  xai: "grok",
};
// Exarch names its private route instances: the Tinfoil "private" OpenCode
// instance and the zero-retention lab instances ("zdr-anthropic", ...). Its
// OpenCode fallback lists models as "tinfoil/<id>" or "zero-retention/<id>".
const PRIVATE_INSTANCE_IDS = new Set(["private", "zdr-anthropic", "zdr-openai", "zdr-xai"]);
const PRIVATE_MODEL_PREFIXES = ["tinfoil/", "zero-retention/"];

export function labFamilyForModelId(modelId: string): LabFamily {
  const id = modelId.trim().toLowerCase();
  const slash = id.indexOf("/");
  const vendor = slash > 0 ? id.slice(0, slash) : "";
  const bare = slash > 0 ? id.slice(slash + 1) : id;
  const byVendor = VENDOR_FAMILIES[vendor];
  if (byVendor) return byVendor;
  if (bare.startsWith("claude")) return "claude";
  if (/^(?:gpt|codex|o[1-9](?:[.-]|$))/u.test(bare)) return "gpt";
  if (bare.startsWith("gemini")) return "gemini";
  if (bare.startsWith("grok")) return "grok";
  return "other";
}

export function labFamilyForDriver(driver: string): LabFamily | null {
  return DRIVER_FAMILIES[driver] ?? null;
}

export function isPrivateRouteInstance(instanceId: string, modelId?: string): boolean {
  return (
    PRIVATE_INSTANCE_IDS.has(instanceId) ||
    instanceId.startsWith("zdr-") ||
    PRIVATE_MODEL_PREFIXES.some((prefix) => modelId?.startsWith(prefix) === true)
  );
}

/** The family a model runs in and, for a private route, the lab behind it. */
export function modelFamilyFor(input: {
  readonly driver: string;
  readonly instanceId: string;
  readonly model: string;
}): { readonly family: ModelFamily; readonly labFamily: LabFamily } {
  const labFamily = labFamilyForDriver(input.driver) ?? labFamilyForModelId(input.model);
  const family = isPrivateRouteInstance(input.instanceId, input.model) ? "private" : labFamily;
  return { family, labFamily };
}

/** The families a task type's allowedDrivers name; multi-lab drivers stay driver-only. */
export function allowedFamiliesForDrivers(
  drivers: ReadonlyArray<string>,
): ReadonlyArray<LabFamily> {
  return [...new Set(drivers.flatMap((driver) => labFamilyForDriver(driver) ?? []))];
}
