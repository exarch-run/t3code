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
