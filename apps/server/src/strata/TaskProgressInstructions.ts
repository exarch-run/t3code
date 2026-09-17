/**
 * The standing instruction every root session gets while the setting allows
 * publishing. Task selection follows OpenClaw's progress card prompt
 * (src/agents/progress-card-system-prompt.ts at commit 11921d88, MIT; see
 * strata/THIRD_PARTY_NOTICES.md); the tool description carries the rest.
 */
export const TASK_PROGRESS_INSTRUCTIONS = `<task_progress>
Strata shows one task card beside the owner's composer for this chat. Create a card with strata_progress_card only for substantial work with at least two meaningful sequential steps, never for greetings, quick questions, or single-step requests. Update or clear existing cards as needed. If the tool answers that task progress is disabled, continue without it.
</task_progress>`;

export const CLAUDE_TASK_PROGRESS_INSTRUCTIONS = `When the request clearly calls for substantial work with at least two meaningful sequential steps, publish the task card before your first work tool call, including reading project files or delegating. If the scope is unclear, inspect only enough to decide whether a card is warranted, then publish it before continuing. Treat each checklist step as a work phase. When a step finishes, call strata_progress_card to mark it completed and set the next step in progress before reasoning about or starting that next phase. Do not leave an earlier step active while doing later work. Also update when background results arrive, a blocker appears, or the owner changes direction. A request for status includes reconciling the card before replying. Before your final answer, leave the card accurate about completed and remaining work. Do not mark unverified work complete. Keep simple questions card-free and do not rewrite an already accurate card just to refresh its timestamp.`;
