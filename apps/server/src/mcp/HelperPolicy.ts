import {
  allowedFamiliesForDrivers,
  helperPolicyForProject,
  modelFamilyFor,
  type HelperPolicy,
  type HelperTaskType,
  type LabFamily,
  type ModelFamily,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { helperUsageLimitReason, roomiestHelperAccount } from "../exarch/HelperAccounts.ts";

export const HELPERS_OFF_REASON =
  "Helper tasks are turned off in Settings for this project; the current provider's native subagents are unaffected.";

/** Why a helper cannot run on this provider right now, in plain words, or null when it can. */
export function providerUnavailableReason(
  provider: ServerProvider | undefined,
  instanceId: string,
  availableInstanceIds: ReadonlySet<string>,
): string | null {
  if (!provider) return `Provider '${instanceId}' is not configured.`;
  if (!availableInstanceIds.has(provider.instanceId))
    return `Provider '${instanceId}' has no orchestration adapter registered.`;
  if (!provider.enabled) return `Provider '${instanceId}' is disabled.`;
  if (!provider.installed) return `Provider '${instanceId}' is not installed.`;
  if (provider.availability === "unavailable")
    return provider.unavailableReason ?? `Provider '${instanceId}' is unavailable.`;
  if (provider.status === "error" || provider.status === "disabled")
    return provider.message ?? `Provider '${instanceId}' status is ${provider.status}.`;
  if (provider.auth.status === "unauthenticated")
    return `Provider '${instanceId}' is not signed in.`;
  return null;
}

/** The option ids drivers use for effort: Claude and Cursor, Codex and Grok, Cursor, OpenCode, Pi. */
const EFFORT_OPTION_IDS = new Set([
  "effort",
  "reasoningEffort",
  "reasoning",
  "variant",
  "thinking",
]);

/**
 * The chosen model's own effort option id when it offers the row's effort
 * value, or null. Delegation refuses options the model does not advertise, so
 * a model without a matching effort choice runs at its default effort instead.
 * A model that advertises no options at all is not checked by delegation and
 * keeps the driver's usual id.
 */
function helperEffortOptionId(candidate: Candidate, effort: string | null): string | null {
  if (effort === null) return null;
  const descriptors = candidate.provider.models.find(
    (model) => model.slug === candidate.selection.model,
  )?.capabilities?.optionDescriptors;
  if (descriptors === undefined)
    return candidate.provider.driver === "claudeAgent" ? "effort" : "reasoningEffort";
  const descriptor = descriptors.find(
    (descriptor) =>
      descriptor.type === "select" &&
      EFFORT_OPTION_IDS.has(descriptor.id) &&
      descriptor.options.some((choice) => choice.id === effort),
  );
  return descriptor?.id ?? null;
}

type Candidate = {
  readonly selection: { readonly instanceId: ServerProvider["instanceId"]; readonly model: string };
  readonly provider: ServerProvider;
  readonly family: ModelFamily;
  readonly labFamily: LabFamily;
};

export type HelperTaskResolution =
  | {
      readonly ok: true;
      readonly row: HelperTaskType;
      readonly modelSelection: ModelSelection;
      readonly family: ModelFamily;
    }
  | { readonly ok: false; readonly row: HelperTaskType | null; readonly reason: string };

/**
 * The single authority for which model a helper task type runs on. Selection
 * walks the owner's visible-model order and applies the row's family rule by
 * lab family (what the model is), not driver (what runs it), so a Cursor thread
 * on a Claude model counts as Claude. Failures carry the concrete reason so
 * orchestrator_capabilities can show it before an agent tries to delegate.
 */
export function explainHelperTask(input: {
  policy: HelperPolicy;
  parent: Pick<OrchestrationV2ThreadProjection, "thread">;
  providers: ReadonlyArray<ServerProvider>;
  availableInstanceIds: ReadonlySet<string>;
  taskType: string | undefined;
  override?: ModelSelection | undefined;
  nowMs: number;
}): HelperTaskResolution {
  const policy = helperPolicyForProject(input.policy, input.parent.thread.projectId);
  if (!policy.enabled) return { ok: false, row: null, reason: HELPERS_OFF_REASON };
  const row = policy.taskTypes.find((row) => row.name === input.taskType);
  if (!row)
    return {
      ok: false,
      row: null,
      reason: `Helper task type '${input.taskType ?? ""}' is not in the owner's table.`,
    };
  const parentSelection = input.parent.thread.modelSelection;
  const parentProvider = input.providers.find((p) => p.instanceId === parentSelection.instanceId);
  if (!parentProvider)
    return {
      ok: false,
      row,
      reason: `Parent provider '${parentSelection.instanceId}' is unavailable.`,
    };
  const parentFamily = modelFamilyFor({
    driver: parentProvider.driver,
    instanceId: parentProvider.instanceId,
    model: parentSelection.model,
  }).labFamily;
  if (policy.visibleModels.length === 0)
    return { ok: false, row, reason: "No model is visible to helpers in Settings." };

  const unavailable: Array<string> = [];
  const available: Array<Candidate> = [];
  for (const selection of policy.visibleModels) {
    const provider = input.providers.find((p) => p.instanceId === selection.instanceId);
    const reason =
      providerUnavailableReason(provider, selection.instanceId, input.availableInstanceIds) ??
      (provider!.models.some((model) => model.slug === selection.model)
        ? helperUsageLimitReason(provider!, selection.model, input.nowMs)
        : `Model '${selection.model}' is not offered by provider '${selection.instanceId}'.`);
    if (reason !== null || !provider) {
      unavailable.push(`${selection.instanceId}/${selection.model}: ${reason}`);
      continue;
    }
    available.push({
      selection,
      provider,
      ...modelFamilyFor({
        driver: provider.driver,
        instanceId: provider.instanceId,
        model: selection.model,
      }),
    });
  }
  if (available.length === 0)
    return {
      ok: false,
      row,
      reason: `No visible model is available to helpers. ${unavailable.join(" ")}`,
    };

  const allowedFamilies = allowedFamiliesForDrivers(row.familyRule.allowedDrivers);
  const inAllowedSet = (candidate: Candidate) =>
    row.familyRule.allowedDrivers.length === 0 ||
    row.familyRule.allowedDrivers.includes(candidate.provider.driver) ||
    allowedFamilies.includes(candidate.labFamily);
  const differsFromParent = (candidate: Candidate) =>
    !row.familyRule.differentFromParent || candidate.labFamily !== parentFamily;
  const familyAllowed = available.filter(inAllowedSet);
  const allowed = familyAllowed.filter(differsFromParent);

  const explicit = input.override ?? row.model;
  let selected = explicit
    ? available.find(
        ({ selection, provider }) =>
          selection.model === explicit.model &&
          ("instanceId" in explicit
            ? selection.instanceId === explicit.instanceId
            : provider.driver === explicit.driverKind),
      )
    : undefined;
  if (selected && !allowed.includes(selected))
    return {
      ok: false,
      row,
      reason: `Task type '${row.name}' forbids family '${selected.labFamily}' (${selected.selection.instanceId}/${selected.selection.model}).`,
    };
  if (input.override && !selected)
    return { ok: false, row, reason: `Model '${input.override.model}' is hidden or unavailable.` };
  selected ??= allowed[0];
  if (!selected) {
    const describe =
      allowedFamilies.length > 0
        ? allowedFamilies.join(", ")
        : row.familyRule.allowedDrivers.join(", ");
    if (familyAllowed.length === 0)
      return {
        ok: false,
        row,
        reason: `Task type '${row.name}' allows only ${describe}, and no visible ${describe} model is available.${unavailable.length > 0 ? ` ${unavailable.join(" ")}` : ""}`,
      };
    return {
      ok: false,
      row,
      reason: `Task type '${row.name}' requires a family different from the parent (${parentFamily}), and ${parentFamily} is the only family available to helpers.${unavailable.length > 0 ? ` ${unavailable.join(" ")}` : ""}`,
    };
  }
  // The table names a model, not an account; an override names an exact account.
  if (!input.override) selected = roomiestHelperAccount(selected, allowed);
  const effortOptionId = helperEffortOptionId(selected, row.effort);
  const options =
    row.effort === null || effortOptionId === null
      ? undefined
      : [{ id: effortOptionId, value: row.effort }];
  return {
    ok: true,
    row,
    family: selected.family,
    modelSelection: {
      ...selected.selection,
      ...(options ? { options } : {}),
    } satisfies ModelSelection,
  };
}

export function resolveHelperTask(input: Parameters<typeof explainHelperTask>[0]) {
  const resolution = explainHelperTask(input);
  if (!resolution.ok) throw new Error(resolution.reason);
  return resolution;
}
