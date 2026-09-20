import type {
  HandoffPlan,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import type { ProviderSwitchPlanV2 } from "./ProviderSwitchService.ts";

export function handoffPlan(
  projection: OrchestrationV2ThreadProjection,
  plan: ProviderSwitchPlanV2,
  capabilities: OrchestrationV2ProviderCapabilities,
  workspaceMove = false,
): HandoffPlan {
  const sources = projection.runs
    .filter(
      (run) =>
        ["completed", "failed", "interrupted"].includes(run.status) ||
        (workspaceMove && ["preparing", "starting", "running", "waiting"].includes(run.status)),
    )
    .toSorted((a, b) => a.ordinal - b.ordinal);
  const latest = sources.at(-1);
  const lastClean = sources.findLast((run) => run.startClean)?.ordinal ?? 1;
  const target =
    workspaceMove || (!plan.instanceChanged && plan.transition.type === "create_with_handoff")
      ? undefined
      : projection.providerThreads.find(
          (thread) =>
            thread.id === plan.targetProviderThreadId && (thread.lastRunOrdinal ?? 0) >= lastClean,
        );
  const lastSeen = target
    ? sources.findLast(
        (run) =>
          run.providerThreadId === target.id &&
          (run.status === "completed" ||
            projection.providerTurns.some((turn) => turn.runAttemptId === run.activeAttemptId)),
      )
    : undefined;
  const needed = workspaceMove || plan.transition.type === "create_with_handoff";
  const covered = needed
    ? sources.filter((run) => run.ordinal >= lastClean && run.ordinal > (lastSeen?.ordinal ?? 0))
    : [];
  return {
    threadId: projection.thread.id,
    required: covered.length > 0,
    strategy:
      covered.length === 0
        ? "none"
        : target
          ? "delta_since_target_last_seen"
          : "full_thread_summary",
    coveredRunOrdinals:
      covered.length === 0 || !latest ? null : { from: covered[0]!.ordinal, to: latest.ordinal },
    cutOffRunOrdinals: covered
      .filter((run) => run.status !== "completed")
      .map((run) => run.ordinal),
    maxRecommendedHandoffChars: capabilities.context.maxRecommendedHandoffChars,
    acceptsSystemContext: capabilities.context.acceptsSystemContext,
    acceptsDeveloperContext: capabilities.context.acceptsDeveloperContext,
  };
}
