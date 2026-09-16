/**
 * The standing instruction every root session gets while the setting allows
 * publishing. Task selection follows OpenClaw's progress card prompt
 * (src/agents/progress-card-system-prompt.ts at commit 11921d88, MIT; see
 * strata/THIRD_PARTY_NOTICES.md); the tool description carries the rest.
 */
export const TASK_PROGRESS_INSTRUCTIONS = `<task_progress>
Strata shows one task card beside the owner's composer for this chat. Create a card with strata_progress_card only for substantial work with at least two meaningful sequential steps, never for greetings, quick questions, or single-step requests. Update or clear existing cards as needed. If the tool answers that task progress is disabled, continue without it.
</task_progress>`;
