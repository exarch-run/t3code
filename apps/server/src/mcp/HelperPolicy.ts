import {
  helperPolicyForProject,
  type HelperPolicy,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";

export function resolveHelperTask(input: {
  policy: HelperPolicy;
  parent: OrchestrationV2ThreadProjection;
  providers: ReadonlyArray<ServerProvider>;
  availableInstanceIds: ReadonlySet<string>;
  taskType: string | undefined;
  override?: ModelSelection | undefined;
}) {
  const policy = helperPolicyForProject(input.policy, input.parent.thread.projectId);
  if (!policy.enabled) throw new Error("Helpers are turned off for this project.");
  const row = policy.taskTypes.find((row) => row.name === input.taskType);
  if (!row)
    throw new Error(`Helper task type '${input.taskType ?? ""}' is not in the owner's table.`);
  const parent = input.providers.find(
    (p) => p.instanceId === input.parent.thread.modelSelection.instanceId,
  );
  if (!parent)
    throw new Error(
      `Parent provider '${input.parent.thread.modelSelection.instanceId}' is unavailable.`,
    );
  const available = policy.visibleModels.flatMap((selection) => {
    const provider = input.providers.find((p) => p.instanceId === selection.instanceId);
    if (
      !provider ||
      !input.availableInstanceIds.has(provider.instanceId) ||
      !provider.enabled ||
      !provider.installed ||
      provider.availability === "unavailable" ||
      provider.status === "error" ||
      provider.status === "disabled" ||
      provider.auth.status === "unauthenticated" ||
      !provider.models.some((model) => model.slug === selection.model)
    )
      return [];
    return [{ selection, provider }];
  });
  const allowed = available.filter(
    ({ provider }) =>
      (!row.familyRule.differentFromParent || provider.driver !== parent.driver) &&
      (row.familyRule.allowedDrivers.length === 0 ||
        row.familyRule.allowedDrivers.includes(provider.driver)),
  );
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
    throw new Error(
      `Task type '${row.name}' forbids provider family '${selected.provider.driver}'.`,
    );
  if (input.override && !selected)
    throw new Error(`Model '${input.override.model}' is hidden or unavailable.`);
  selected ??= allowed[0];
  if (!selected)
    throw new Error(
      `Task type '${row.name}' has no visible, available model allowed by its family rule.`,
    );
  const options =
    row.effort === null
      ? undefined
      : [
          {
            id: selected.provider.driver === "claudeAgent" ? "effort" : "reasoningEffort",
            value: row.effort,
          },
        ];
  return {
    row,
    modelSelection: {
      ...selected.selection,
      ...(options ? { options } : {}),
    } satisfies ModelSelection,
  };
}
