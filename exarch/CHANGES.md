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

Policy lives in `apps/server/src/exarch/SqliteDurability.ts`. Every persistence connection opens with `synchronous = NORMAL` and a page cache of about 64 MB, so commits stop waiting for the disk on the engine's only thread. The checkpoint interval stays at SQLite's default. The owner accepted that a power cut or kernel crash can lose the most recent agent events; an app or engine crash loses nothing. Auth writes are the exception. Every session and pairing-link write commits with `synchronous = FULL`, one at a time, so a revocation or a consumed pairing link can't come back after a power cut. Server secrets are files, not SQLite, and are unaffected.

| Hook                              | Reason                                                                                                              | Regression coverage                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `persistence/Layers/Sqlite.ts`    | One import and one call in the shared setup, after upstream's `journal_size_limit` line so refreshes merge cleanly. | `exarch/SqliteDurability.test.ts`, `persistence/Layers/Sqlite.test.ts` |
| `persistence/AuthSessions.ts`     | One import, and the layer wraps the repository so all seven write methods commit with FULL sync.                    | `exarch/SqliteDurability.test.ts`                                      |
| `persistence/AuthPairingLinks.ts` | One import, and the layer wraps the repository so its three write methods commit with FULL sync.                    | `exarch/SqliteDurability.test.ts`                                      |

## Background subagent events written once

Policy lives in `apps/server/src/exarch/ChildThreadEventWrites.ts`. Every live run of a chat routes the events of its background subagents' child threads, so each was written once per live run, and a lagging run could land a stale copy after a newer one. Only a run that writes an event claims it, so a run whose streaming filter drops a preview leaves it for the others. Writes for one child entity run one at a time, and an event is skipped when another run already wrote it or a newer update for that entity is already written, using the order the provider session emitted them. A child entity never goes back to an older state, even when a run subscribed after another run's backlog built up. A failed or interrupted write claims nothing. Routing, lifecycle tracking, and the run's ownership-gated provider-thread writes are unchanged.

| Hook                                         | Reason                                                                                                                                         | Regression coverage                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `orchestration-v2/ProviderSessionManager.ts` | Stamp each adapter event with its emission order just before fanning it out to subscribed runs.                                                | `ProviderSessionManager.test.ts`, `exarch/ChildThreadEventWrites.test.ts` |
| `orchestration-v2/RunExecutionService.ts`    | Join the session when a run subscribes and leave when the subscription closes, and send each delivered event's write through it before ingest. | `exarch/ChildThreadEventWrites.test.ts`, `RunExecutionService.test.ts`    |

The events' run tag comes from whichever run wrote them. What was written is kept in memory per provider session while any run subscribed to it is live, since only those runs can deliver its older events, and the last run to leave releases it. No schema, migration, or persisted state is introduced.

## Shared speech integration

Policy lives in `apps/server/src/exarch/speech.ts` and `infra/relay/src/exarch/speech.ts`. Exarch speech uses its normal plugin lifecycle. The relay stores one account host/integration pointer with a revision, validates ownership, and compares revisions on writes. Runtime/model configuration stays on the speech host. The desktop bridge reuses linked-computer DPoP enrollment and streams a dedicated speech endpoint; chat subscriptions remain independent.

| Hook                                                                                          | Reason                                                                                                                                      | Coverage                                |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `apps/server/src/http.ts`                                                                     | Thin authenticated dispatch for speech account discovery and linked-host forwarding.                                                        | `apps/server/src/exarch/speech.test.ts` |
| `apps/server/src/exarch/linkedComputers.ts`                                                   | Internal speech discovery includes the current host; reuse and renewal of its signed connection. Public personal-setup schema is unchanged. | `linkedComputers.test.ts`               |
| `apps/server/src/mcp/toolkits/exarch/tools.ts`, `handlers.ts`                                 | Register origin-computer recording recovery; Exarch derives storage/access from the calling chat.                                           | `tools.test.ts`                         |
| `infra/relay/src/persistence/schema.ts`, `migrations/postgres/20260927230300_speech_primary/` | Account primary pointer and compare-and-set revision. No audio or model credentials.                                                        | `infra/relay/src/exarch/speech.test.ts` |
| `infra/relay/src/worker.ts`                                                                   | Compose authenticated speech routes with the relay.                                                                                         | Relay typecheck and speech route test   |
| `infra/relay/src/account/AccountDeletions.ts`                                                 | Remove the pointer during the existing account deletion transaction.                                                                        | `AccountDeletions.test.ts`              |

No provider adapter changes. The tool uses the existing Exarch toolkit on every driver that exposes it. These source changes require a subsequent authorized engine package and relay deployment before account speech is available in an installed app.

## Desktop windows for other computers

Policy lives in `apps/server/src/exarch/speech.ts`, `linkedComputers.ts` and `http.ts`. The speech bridge is now the general computer bridge. `/api/exarch/computer-bridge/<environment>/<path>` reaches `/api/exarch/<path>` on another computer on the owner's account, using the same signed session speech uses. Speech keeps its old prefix and its 20-second wait for an answer. Window calls have no wait limit, because a turn can take longer to start. POST bodies are buffered up to 51 MiB, so a renewed session can send them again. Linked computers gain `computers` (every computer, this one marked `self`), `status` (a parallel relay health check with a status-scoped pass, where a failed check reads `unknown`) and `unlink` (removes another computer from the account, never this one). On `/preview/` paths only, the bridge and the forwarder pass the page's own cookie, set-cookie and location. Authentication stays the signed engine session.

| Hook                      | Reason                                                                                                              | Regression coverage                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `apps/server/src/http.ts` | The existing speech-bridge dispatch also accepts the `computer-bridge` prefix, behind the same `relay:write` check. | `apps/server/src/exarch/speech.test.ts` |

No provider adapter changes. An installed app gets this only after an authorized engine package.

## Agent schedule controls

Policy lives in `apps/server/src/exarch/ScheduledTaskWorkspace.ts`. `schedule_task` and `update_scheduled_task` accept the settings the app's Schedules page sets: account, model and options (`target`, checked like `delegate_task`'s), `runtimeMode`, `interactionMode`, and `workspaceStrategy`. Access can't be broader than the calling chat's, and a left-out access level keeps the saved one without a check. Build or Plan is a working style, not a permission, so it is taken as asked. A fresh chat per run defaults to a new worktree from the project's current local branch, not fetched; upstream fetched `main` from origin. A named local ref must exist, and a fixed branch for a new worktree is refused because the second run would collide with it. A workspace for runs that post into a chat is refused, not stored unused. The schedule tool inputs refuse unknown fields instead of dropping them.

| Hook                                                                        | Reason                                                                                                                               | Regression coverage                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `packages/contracts/src/orchestratorMcp.ts` (path from the repository root) | New schedule tool fields, the saved settings in the task summary, and unknown-field refusal on the create, update and delete inputs. | `mcp/OrchestratorMcpToolkit.integration.test.ts`                                          |
| `mcp/OrchestratorMcpService.ts`                                             | Replace the hard-coded `main`-from-origin default with the policy, and resolve target and modes on create and update.                | `mcp/OrchestratorMcpToolkit.integration.test.ts`, `exarch/ScheduledTaskWorkspace.test.ts` |
| `mcp/toolkits/orchestrator/tools.ts`, `handlers.ts`                         | Tool descriptions, and the project and git services the workspace check needs.                                                       | `mcp/OrchestratorMcpToolkit.integration.test.ts`                                          |

Existing saved tasks are not migrated.

## Relay expiry cleanup warnings

Policy lives in `infra/relay/src/exarch/cleanup.ts`. The fork's five-minute cron removes expired DPoP proofs, agent activity, Live Activity content and delivery attempts, each running even when another fails. A failure now leaves a warning, as upstream's did, instead of vanishing while tracing is off. Pruning completed account deletions and expired AI reports warns the same way.

| Hook                        | Reason                                                                                                   | Regression coverage                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `infra/relay/src/worker.ts` | The cron runs the policy's expiry cleanup and wraps the tombstone and report pruning in its failure log. | `infra/relay/src/exarch/cleanup.test.ts` |

A relay deployment is needed before this reaches the live relay.

## Schedule edits and saves

Policy lives in `apps/server/src/exarch/ScheduledTaskWorkspace.ts`. Every editor that saves an existing schedule sends its plugin, so a rename or reschedule still runs the plugin. The service itself keeps saving a plugin only when it's sent, because Exarch's Library turns a plugin schedule back into an agent schedule by leaving it out. Library and settings saves of a fresh chat per run get the agent tools' workspace checks and are saved as chosen, so a missing local ref, a fixed worktree branch, or a checkout outside the project is refused at save instead of at launch. Runs that post into a chat, and plugin runs, don't launch from the workspace and aren't checked. `exarch_personal_setup` configure passes `keys`, Exarch's key-sharing choice, which the tool used to drop, so an agent's configure turned key sharing off.

| Hook                                                                                                                        | Reason                                                            | Regression coverage                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `ws.ts`                                                                                                                     | The schedule save handler runs the workspace check before upsert. | `exarch/ScheduledTaskWorkspace.test.ts`                                 |
| `mcp/OrchestratorMcpService.ts`                                                                                             | `update_scheduled_task` carries the saved plugin.                 | `mcp/OrchestratorMcpToolkit.integration.test.ts`                        |
| `apps/web/src/components/settings/scheduledTasksSettings.logic.ts`, `ScheduledTasksSettings.tsx` (from the repository root) | The settings form keeps the plugin it can't edit and sends it.    | `apps/web/src/components/settings/scheduledTasksSettings.logic.test.ts` |
| `apps/mobile/src/features/settings/SettingsScheduledTasksRouteScreen.tsx` (from the repository root)                        | The phone form sends the edited task's plugin.                    | Mobile typecheck only                                                   |
| `mcp/toolkits/exarch/tools.ts`                                                                                              | The `keys` choice in the personal-setup tool schema.              | `mcp/toolkits/exarch/handlers.test.ts`                                  |

Existing saved tasks are not migrated. A saved schedule that fails the workspace check is refused on its next save until its workspace is changed.

## Clean-run context window and shared worktree moves

Policy lives in `apps/server/src/exarch/ContextWindow.ts`. A run's context window opens at the last clean run that ran before it. The floor used to be the last clean run anywhere, so a clean run queued behind a provider switch erased the switch's history and the switch started with no handoff. A run being started, restarted or recovered now counts itself when clean, and otherwise only clean runs that have left the queue. The queue follows queue position, so a clean run moved ahead of the switch still bounds it, and one left behind doesn't. The next new message runs after everything queued, so dispatch and the handoff preview count every clean run, as before. The preview now reads every run, like dispatch, so a supplied package's range matches what the engine expects. It keeps its old default of 1, so a provider thread that has never run still reads as a newcomer. Coverage is still an ordinal range, so a chat where several clean runs were reordered past each other can't be described exactly. The floor is the highest-numbered clean run that has run.

The worktree handoff guard moved to module scope in `mcp/WorktreeMcpService.ts`. Owner moves over WebSocket build a service per request and agent moves use the MCP server's, so a guard held per service instance never serialized them.

| Hook                                           | Reason                                                                                    | Regression coverage                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `orchestration-v2/Orchestrator.ts`             | Queue activation, restart and provider-thread reuse take the window for their target run. | `orchestration-v2/testkit/ProviderSwitch.integration.test.ts` |
| `orchestration-v2/ProviderTurnStartService.ts` | Resume fallback takes the window for its run.                                             | `orchestration-v2/ProviderTurnStartService.test.ts`           |
| `orchestration-v2/HandoffPlan.ts`              | The preview takes the next message's window.                                              | `orchestration-v2/testkit/ProviderSwitch.integration.test.ts` |
| `mcp/WorktreeMcpService.ts`                    | One process-wide per-thread handoff guard.                                                | `mcp/WorktreeMcpService.test.ts`                              |

## Project session files

Policy lives in `apps/server/src/exarch/ProjectSessionFiles.ts`. A project's session files, which go into the model's context at session start, are stored in `projection_projects.session_files_json` (Exarch migration `1_ProjectSessionFiles`) through upstream's project store. A NULL column reads back as no field, and an explicit clear stores `[]`. The contract fields in `orchestrationProject.ts`, `project.ts` and `applicationEvent.ts` and the `ProjectService.ts` hooks carry them from the app.

| Hook                                  | Reason                                                                             | Regression coverage                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `orchestration-v2/ProjectStore.ts`    | Optional `sessionFiles` on the row, in its SQL reads and writes, and in the shell. | `exarch/ProjectSessionFiles.test.ts`                                   |
| `orchestration-v2/ProjectCommands.ts` | Create and meta-update commands carry `sessionFiles` into their events.            | `exarch/ProjectSessionFiles.test.ts`, `project/ProjectService.test.ts` |
| `orchestration-v2/RuntimePolicy.ts`   | Reads the project's files for the session context; app-owned helpers get none.     | `exarch/ProjectSessionFiles.test.ts`, `RuntimePolicy.test.ts`          |

The engine refresh to upstream `30f21318` moved this off the deleted V1 projection pipeline. The same refresh moved `questionResponseInput.ts` from the deleted `orchestration/` folder to `apps/server/src/exarch/`.

## Claude subagents and shared-session restart

No policy files. Both were resolved by hand in the refresh to upstream `30f21318`, which rewrote the same lines.

| Hook                                           | Reason                                                                                                                                                                                                                                               | Regression coverage                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `orchestration-v2/Adapters/ClaudeAdapterV2.ts` | Each subagent keeps `launchToolUseId`, so only the Agent launch's result finishes it, not a later SendMessage, and `emittedTextNativeItemIds` drops repeated text snapshots. Upstream's `recoverResumedClaudeSubagent` sets both. From `53bde662a5`. | `Adapters/ClaudeAdapterV2.test.ts`, `testkit/fixtures/subagent_text` |
| `orchestration-v2/RestartContinuation.ts`      | A live turn on a `ready` shared session can continue after a restart, alongside upstream's `running` rule. From `a00fcd65e1`.                                                                                                                        | `RestartContinuation.test.ts`                                        |
