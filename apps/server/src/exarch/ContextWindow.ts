import type { OrchestrationV2Run } from "@t3tools/contracts";

/**
 * Ordinal of the clean run that opens a run's context window, or 0 when none
 * does. With a target run, only clean runs that ran before it count: the
 * target itself when clean, otherwise clean runs that have left the queue.
 * The queue runs one at a time in queue position, which a reorder can move
 * away from ordinal order, so a still-queued clean run never moves the window.
 * Without a target the window is the next new message's, which runs after
 * everything already queued, so every clean run counts.
 */
export function contextWindowStart(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "startClean" | "status">>,
  target?: Pick<OrchestrationV2Run, "id" | "ordinal" | "startClean">,
): number {
  if (target?.startClean === true) return target.ordinal;
  return runs.reduce(
    (start, run) =>
      run.startClean === true &&
      run.ordinal > start &&
      (target === undefined || (run.id !== target.id && run.status !== "queued"))
        ? run.ordinal
        : start,
    0,
  );
}
