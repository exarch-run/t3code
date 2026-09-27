This inventory starts with the two September 26, 2026 repairs and does not describe all pre-existing fork changes.

# Exarch fork hooks

## Retained Claude Bring back context

Policy lives in `apps/server/src/exarch/ClaudeHandoffContext.ts`. It splits the existing handoff allowance into numbered hook outputs below Claude's output limit, retains them per live query, resets provisional delivery after unsuccessful prompts, and restores accepted same-native-thread context through the existing renderer after compaction.

| Hook                                           | Reason                                                                                                                                                                                                                                 | Regression coverage                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `orchestration-v2/ProviderAdapter.ts`          | Optional internal handoff-only input keeps ordinary messages and base instructions intact.                                                                                                                                             | `ProviderTurnStartService.test.ts`                                               |
| `orchestration-v2/ContextHandoffBudget.ts`     | Export the existing ceiling so transport has no competing package limit.                                                                                                                                                               | `exarch/ClaudeHandoffContext.test.ts`, `ContextHandoffBudget.test.ts`            |
| `orchestration-v2/ProviderTurnStartService.ts` | Route Claude context to hooks, restore accepted context on cold compact, defer delivery and uncertain-retry replacement during native wakes or Claude compaction. Other ordinary uncertain retries keep existing replacement behavior. | `ProviderTurnStartService.test.ts`, `testkit/ProviderSwitch.integration.test.ts` |
| `orchestration-v2/Adapters/ClaudeAdapterV2.ts` | Bind hook state to the live query, preserve it through compaction and native continuation, and reset failed offers and terminal prompts. Existing task-card and ownership hooks stay composed.                                         | `Adapters/ClaudeAdapterV2.test.ts`, `exarch/ClaudeHandoffContext.test.ts`        |
| `orchestration-v2/Orchestrator.ts`             | Native background output offers no new prompt and must not consume a pending Bring back transfer.                                                                                                                                      | `runtimeLayer.test.ts`, `ProviderContinuationService.test.ts`                    |

Paths in the hook table are relative to `apps/server/src`. Adapter tests use SDK fakes. They do not establish actual provider execution, OS background-process survival, or installed-runtime identity.

## Edited queued answers

Policy lives in `apps/server/src/exarch/QueuedAnswerEdit.ts`. A generic content edit preserves the request link with an empty structured-answer list. The persisted message then owns the answer's current text and attachments. Selected question rows retain their linked canonical answer even after removal from the queue.

| Hook                                             | Reason                                                                                                  | Regression coverage                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `orchestration-v2/Orchestrator.ts`               | Normalize once for message and existing user-item updates, and apply the effective text-or-files guard. | `runtimeLayer.test.ts`               |
| `orchestration-v2/ProviderTurnStartService.ts`   | Prompt classification and normal dispatch prefer structured answers only when nonempty.                 | `ProviderTurnStartService.test.ts`   |
| `orchestration-v2/ProviderTurnControlService.ts` | Steering dispatch uses current message prose and files for id-only responses.                           | `ProviderTurnControlService.test.ts` |
| `orchestration-v2/ProjectionStore.ts`            | Extend the selected message cohort with only selected questions' canonical answer ids.                  | `ProjectionStore.test.ts`            |

No public schema, persistent cache, provider-specific answer branch, or migration is introduced. Desktop consumers are owned by the Exarch repository.

## Engine database durability

Policy lives in `apps/server/src/exarch/SqliteDurability.ts`. Every persistence connection opens with `synchronous = NORMAL` and a page cache of about 64 MB, so commits stop waiting for the disk on the engine's only thread. The checkpoint interval stays at SQLite's default. The owner accepted that a power cut or kernel crash can lose the most recent commits; an app or engine crash loses nothing.

| Hook                           | Reason                                                                                                              | Regression coverage                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `persistence/Layers/Sqlite.ts` | One import and one call in the shared setup, after upstream's `journal_size_limit` line so refreshes merge cleanly. | `exarch/SqliteDurability.test.ts`, `persistence/Layers/Sqlite.test.ts` |
