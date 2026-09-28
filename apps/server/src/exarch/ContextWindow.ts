import type { OrchestrationV2Run } from "@t3tools/contracts";

/**
 * Ordinal of the clean run that opens the context window seen by the run at
 * `targetOrdinal`, or 0 when no clean run is at or before it. Omit the target
 * for the next new run. Runs are placed by ordinal, so a clean run queued
 * after the target never moves the target's window.
 */
export function contextWindowStart(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "ordinal" | "startClean">>,
  targetOrdinal = Number.POSITIVE_INFINITY,
): number {
  return runs.reduce(
    (start, run) =>
      run.startClean === true && run.ordinal <= targetOrdinal && run.ordinal > start
        ? run.ordinal
        : start,
    0,
  );
}
