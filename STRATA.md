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

`packages/contracts/src/taskProgress.ts` and `apps/server/src/strata/` define the server-owned card and its transactional projection. Migration 052 adds cards and content-bound retry receipts. Migration 053 seeds the projector cursor at the other projectors' position on an existing store, so taking the extension never replays the whole history before the server listens. Registration calls extend internal orchestration commands, events, projections, snapshots, server settings/config, thread subscriptions and the shared runtime instructions. Publishing is not a client command and does not use the desktop document host or modify authentication.

Every session of every provider gets the card the same way: `strata_progress_card` and `strata_progress_card_read` sit on the shared `t3-code` toolkit beside the document tools, and `apps/server/src/strata/TaskProgressInstructions.ts` adds one standing block to the runtime instructions every adapter builds. A write is accepted from whoever holds the chat's credential while that chat has a running turn: the chat comes from the credential the engine issued at session start, the turn from the server's own session record. There is no parent-versus-subagent check, provider allowlist, writer lease or "new chats only" rule; the instruction tells the main agent to keep the card, and its next write replaces anything else. The default-on `enableTaskProgress` setting rejects writes immediately when disabled and never needs a session restart.

Readers opt into version 1 progress events with `taskProgressVersion`; old readers receive existing event forms and may ignore the optional snapshot field. Preserve this filtering for live delivery and replay. Cards retain source-turn outcomes outside paginated history. Each upstream upgrade must rerun the TaskProgress, strata toolkit, RuntimeInstructions, snapshot/projector and adapter tests, the bundled web build and Strata's explicit provider proof, including old/new subscriptions, restart, backup restoration and idle-chat refusals. Never allocate migration 052 again.

## Developing against Strata

Run `vp run dev:server` and pair StrataMD to it as an external engine (Settings → Advanced → Connect to another computer's agents). To use the document tools from that server, source Strata's `strata-host.env` from its data directory before starting the server; Strata writes it on every launch. Cut a tagged build only when the change is ready to ship.
