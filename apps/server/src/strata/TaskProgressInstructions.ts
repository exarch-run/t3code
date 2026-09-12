/**
 * The standing instruction every session gets, whatever its provider. The
 * tool description carries the rules; this block only makes sure a model
 * knows the card exists before it starts substantial work.
 */
export const TASK_PROGRESS_INSTRUCTIONS = `<task_progress>
Strata shows a task card beside the owner's composer for this chat. For substantial work, keep it current with the strata_progress_card tool: write it when you start, update it at meaningful milestones or blockers, and write the result before you finish. Skip it for short answers and questions. Each call replaces the whole card. If the tool answers that task progress is disabled or no run is active, continue without it.
</task_progress>`;
