# Strata engine branch

This branch builds the T3 server that StrataMD bundles. It sits on the upstream release tag named in `strata/base.json` and carries only Strata's own commits on top. `git log <upstreamCommit>..strata` is the complete list of Strata's modifications.

## Rules

- New behavior goes in new files. Upstream files are touched only at registration points: the RPC method registry, the settings schema, the reactor list.
- One commit per change, subject prefixed `strata:`.
- Never rename or remove an existing RPC method, event type, field, or enum value. Add under new names and new capability flags. Existing clients, including the web client this package bundles and the T3 mobile app, keep working.
- Never touch auth, pairing, token exchange, or the relay client.
- Native code is not modified. Helper binaries come from the official npm package of the base version.

## Taking an upstream release

1. `git fetch upstream --tags`
2. `git rebase v<version> strata` (merge instead once the branch holds more than about twenty commits)
3. Update `strata/base.json`: tag, commit, npm version, npm integrity (`npm view t3@<version> dist.integrity`)
4. Run upstream's server tests near the files this branch touches: `vp test run` inside `apps/server` with `-t` filters
5. Tag `v<version>-strata.1` and push the tag. The workflow in `.github/workflows/strata-release.yml` builds the package and publishes a GitHub release with the tarball, its SHA-256, a provenance record, and a build attestation.

## Building locally

From the repository root: `vp install --filter=t3... --filter=@t3tools/web... --filter=@t3tools/scripts...`, `cp .env.example .env`, `node scripts/update-release-package-versions.ts <version>`, `vp run --filter t3 build`, copy `dist/resource-monitor` from the official base package into `apps/server/dist`, then `node strata/pack.mjs --version <version> --out <dir>`. The pack script writes the trimmed manifest upstream publishes with and packs it with npm. Revert the version stamp afterwards.

## What the branch carries

- `apps/server/src/mcp/StrataHostClient.ts` and `apps/server/src/mcp/toolkits/strata/`: Strata's document tools, listed in every session's `t3-code` toolkit. The handlers post each call to Strata over a private loopback channel named by `STRATA_HOST_URL` and `STRATA_HOST_TOKEN`, which Strata passes at spawn; with the variables unset or the host unreachable every tool answers "Strata is not connected. Propose the action in a strata block instead." No capability, setting, contract, router, or authorization change: the only upstream file touched is `McpHttpServer.ts`, at the toolkit registration list.

- `apps/server/src/provider/SessionFiles.ts` and `OrchestrationProject.sessionFiles`: files from the project folder that the server places in the model's context at session start, the way an assistant workspace's soul, identity, user, and memory files are loaded. Set through `project.create` and `project.meta.update`; rendered by the provider command reactor into `ProviderSessionStartInput.sessionContext`; appended after the runtime block by the shared builder, at session start for Claude, per turn for Codex, Grok, and OpenCode. Registration points touched: the contract, the decider, the projector, the projection pipeline and repository, migration 051, the snapshot query, the reactor, and one call per adapter.

## Task progress extension

`packages/contracts/src/taskProgress.ts` and `apps/server/src/strata/` define the server-owned card and its transactional projection, after OpenClaw's progress card (commit `11921d88`, MIT; `strata/THIRD_PARTY_NOTICES.md`). Migration 052 added the version 1 tables and 053 seeded the projector cursor; migration 054 adds `strata_task_progress_v2`, the canonical record (content, revision, generation, update time, attributing turn), and copies 052's cards into it. Registration calls extend internal orchestration commands, events, projections, snapshots, server settings/config, thread subscriptions and the shared runtime instructions. Publishing is not a client command and does not use the desktop document host or modify authentication.

Every session of every provider gets the card the same way: `strata_progress_card` and `strata_progress_card_read` sit on the shared `t3-code` toolkit beside the document tools, and `TaskProgressInstructions.ts` adds one standing block to the runtime instructions every adapter builds while the setting allows publishing. The writer is a dynamic tool with the reference's closed JSON Schema (`markdown`, `plan[].step`/`status`); `TaskProgressInput.ts` validates the raw call and refuses unknown fields, so a misnamed checklist is never dropped into a note-only update. A write is accepted from whoever holds the chat's credential while it lives, running turn or not; each call replaces the whole card, an empty call clears it, and the answer is a sentence with the revision and step counts. `TaskProgressOwnership.ts` registers a Claude PreToolUse hook that turns subagent writes away before execution. `TaskProgressCodexRoute.ts` gives Codex chats the same two tools as dynamic tools at `thread/start`, the way OpenClaw's Codex harness delivers its tools: Codex calls back with the calling thread and turn, a helper thread's call is refused before any write, and the MCP writer refuses routed chats so a helper cannot go around the route (the MCP reader stays open). OpenCode and Antigravity children still share the chat's credential (recorded gap). The default-on `enableTaskProgress` setting rejects writes immediately, never needs a session restart, and drops the standing block from the next session start or turn; the tool stays listed while off.

Readers negotiate a version on `orchestration.subscribeThread`: `taskProgressVersion: 2` receives `thread.task-progress-v2-updated` records and the `taskProgressV2` snapshot field; `taskProgressVersion: 1` keeps receiving the published `thread.task-progress-updated` card, projected by `TaskProgressCompatibility.ts` from the canonical record with its real turn, or a replacement snapshot without `taskProgress` when the card was cleared or does not fit the old shape; readers that send neither receive neither. `server.getConfig` keeps `taskProgress.version: 1` and adds `supportedVersions: [1, 2]`. Preserve this for live delivery and replay. Each upstream upgrade must rerun the strata, TaskProgress, migration 054, strata toolkit, RuntimeInstructions, Claude/Codex adapter, snapshot/projector and websocket tests, the bundled web build and Strata's explicit provider proof. Never allocate migrations 052, 053 or 054 again.

## Developing against Strata

Run `vp run dev:server` and pair StrataMD to it as an external engine (Settings → Advanced → Connect to another computer's agents). To use the document tools from that server, source Strata's `strata-host.env` from its data directory before starting the server; Strata writes it on every launch. Cut a tagged build only when the change is ready to ship.
