/**
 * Exarch treats a settled chat as done. Upstream disposes a finished
 * delegated task's report only when the parent is archived or deleted, so a
 * helper that finishes after its parent settles wakes the parent and the
 * wake unsettles it. With this check a settled parent is disposed the same
 * way: the report stays on the task record and the parent stays settled.
 * Reopening the parent by sending it a message works as before.
 */
export const settledParentDisposesReports = (thread: {
  readonly settledOverride: "settled" | "active" | null;
}): boolean => thread.settledOverride === "settled";
