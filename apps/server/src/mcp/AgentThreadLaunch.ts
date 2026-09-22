import * as NodePath from "node:path";
import { ServerConfig } from "../config.ts";
import * as NodeCrypto from "node:crypto";
import {
  recoverAgentLaunchWorkspace,
  resolveAgentLaunchWorkspace,
} from "./AgentLaunchWorkspace.ts";
import {
  AgentThreadCreator,
  AgentThreadLaunchEntry,
  type AgentThreadLaunchInput,
  type AgentThreadLaunchResult,
  CommandId,
  MessageId,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Project from "../project/ProjectService.ts";
import * as Claims from "../orchestration-v2/AttachmentClaims.ts";
import * as Intake from "../orchestration-v2/ThreadMessageIntake.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CommandReceiptStoreV2 } from "../orchestration-v2/CommandReceiptStore.ts";
import { providerUnavailableReason } from "./HelperPolicy.ts";
import { readMutationCaller } from "./threadAccess.ts";

const AcceptedEntry = Schema.Struct({
  ...AgentThreadLaunchEntry.fields,
  commandId: CommandId,
  worktreeDestination: Schema.optional(Schema.String),
  threadId: ThreadId,
  messageId: MessageId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
});
const AcceptedRequest = Schema.Struct({
  creator: AgentThreadCreator,
  threads: Schema.Array(AcceptedEntry),
});
const decodeAccepted = Schema.decodeUnknownEffect(Schema.fromJsonString(AcceptedRequest));
const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** Store inherited choices once. A new provider session must replay the same work. */
export const launchAgentThreads = Effect.fn("mcp.launchAgentThreads")(function* (
  input: AgentThreadLaunchInput,
) {
  const { caller, threads } = yield* readMutationCaller();
  if (caller.runtimeMode !== "full-access" || caller.interactionMode !== "default") {
    return yield* failure(`Chat ${caller.id} requires full-access/default mode to launch chats.`);
  }
  if (new Set(input.threads.map((entry) => entry.entryId)).size !== input.threads.length) {
    return yield* failure(`Launch request ${input.requestId} has duplicate entry IDs.`);
  }
  const sql = yield* SqlClient.SqlClient;
  const requestKey = JSON.stringify([caller.id, input.requestId]);
  const inputJson = stableStringify(input);
  const read = () =>
    sql<{ input_json: string; accepted_json: string }>`
    SELECT input_json, accepted_json FROM exarch_agent_launch_requests WHERE request_key = ${requestKey}
  `.pipe(Effect.mapError(() => failure(`Cannot read launch request ${input.requestId}.`)));
  let saved = (yield* read())[0];
  if (!saved) {
    const parent = yield* threads
      .getThreadProjection(caller.id)
      .pipe(Effect.mapError(() => failure(`Cannot read creator chat ${caller.id}.`)));
    const run = parent.runs.find((candidate) => candidate.id === caller.activeRunId);
    if (!run?.rootNodeId) return yield* failure(`Chat ${caller.id} has no active root run.`);
    const projects = yield* Project.ProjectService;
    const providers = yield* (yield* ProviderRegistry).getProviders;
    const instanceIds = new Set(yield* (yield* ProviderAdapterRegistryV2).list());
    const resolved = yield* Effect.forEach(
      input.threads,
      (entry) =>
        Effect.gen(function* () {
          const modelSelection = entry.modelSelection ?? caller.modelSelection;
          const provider = providers.find(
            (candidate) => candidate.instanceId === modelSelection.instanceId,
          );
          const unavailable = providerUnavailableReason(
            provider,
            modelSelection.instanceId,
            instanceIds,
          );
          if (unavailable) return yield* failure(`${entry.entryId}: ${unavailable}`);
          if (
            entry.modelSelection !== undefined &&
            provider &&
            provider.models.length > 0 &&
            !provider.models.some((model) => model.slug === modelSelection.model)
          ) {
            return yield* failure(
              `Launch entry ${entry.entryId}: model ${modelSelection.model} is unavailable on ${modelSelection.instanceId}.`,
            );
          }
          const projectId = entry.projectId ?? caller.projectId;
          const project = yield* projects
            .getById(projectId)
            .pipe(Effect.mapError(() => failure(`Cannot read project ${projectId}.`)));
          if (Option.isNone(project) || project.value.deletedAt !== null) {
            return yield* failure(`Project ${projectId} does not exist.`);
          }
          if (
            (entry.attachments ?? []).some(
              (attachment) => !Claims.attachmentIsPendingUpload(attachment),
            )
          ) {
            return yield* failure(
              `Launch entry ${entry.entryId} accepts only pending attachment uploads.`,
            );
          }
          if (
            projectId !== caller.projectId &&
            (!entry.workspaceStrategy || entry.workspaceStrategy.type === "inherit")
          ) {
            return yield* failure(
              `Launch entry ${entry.entryId} needs an explicit workspace for project ${projectId}.`,
            );
          }
          let workspaceStrategy =
            !entry.workspaceStrategy || entry.workspaceStrategy.type === "inherit"
              ? caller.worktreePath
                ? {
                    type: "existing_worktree" as const,
                    worktreePath: caller.worktreePath,
                    ...(caller.branch ? { branch: caller.branch } : {}),
                  }
                : { type: "root" as const, ...(caller.branch ? { branch: caller.branch } : {}) }
              : entry.workspaceStrategy;
          const identity = `agent-launch:${NodeCrypto.createHash("sha256")
            .update(JSON.stringify([caller.id, input.requestId, entry.entryId]))
            .digest("hex")}`;
          if (entry.workspaceStrategy && entry.workspaceStrategy.type !== "inherit") {
            workspaceStrategy = yield* resolveAgentLaunchWorkspace(
              workspaceStrategy,
              project.value.workspaceRoot,
              identity,
            );
          }
          return {
            ...entry,
            ...(workspaceStrategy.type === "worktree"
              ? {
                  worktreeDestination: NodePath.join(
                    (yield* ServerConfig).worktreesDir,
                    identity.replace(":", "-"),
                  ),
                }
              : {}),
            projectId,
            workspaceStrategy,
            modelSelection,
            runtimeMode: entry.runtimeMode ?? caller.runtimeMode,
            interactionMode: entry.interactionMode ?? caller.interactionMode,
            commandId: CommandId.make(`${identity}:create`),
            threadId: ThreadId.make(identity),
            messageId: MessageId.make(`${identity}:message`),
          };
        }),
      { concurrency: 1 },
    );
    const accepted = {
      creator: { parentThreadId: caller.id, parentRunId: run.id, parentNodeId: run.rootNodeId },
      threads: resolved,
    };
    // Concurrent identical requests share the winner's captured defaults and parent run.
    yield* sql`INSERT INTO exarch_agent_launch_requests (request_key, input_json, accepted_json)
      VALUES (${requestKey}, ${inputJson}, ${JSON.stringify(accepted)}) ON CONFLICT(request_key) DO NOTHING`.pipe(
      Effect.mapError(() => failure(`Cannot save launch request ${input.requestId}.`)),
    );
    saved = (yield* read())[0];
  }
  if (!saved || saved.input_json !== inputJson) {
    return yield* failure(
      `Launch request ${input.requestId} was already used with different input. Use a new request ID.`,
    );
  }
  const accepted = yield* decodeAccepted(saved.accepted_json).pipe(
    Effect.mapError(() => failure(`Launch request ${input.requestId} has unreadable saved input.`)),
  );
  const outcomes = yield* Effect.forEach(
    accepted.threads,
    (entry) =>
      Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          let attachments: NonNullable<
            import("../orchestration-v2/ThreadLaunchService.ts").ThreadLaunchInput["initialMessage"]
          >["attachments"] = entry.attachments ?? [];
          if (attachments.length) {
            const receipts = yield* CommandReceiptStoreV2;
            const receipt = yield* receipts
              .getByCommandId(CommandId.make(`${entry.commandId}:initial-message`))
              .pipe(
                Effect.mapError(() =>
                  failure(`Cannot read message receipt for launch entry ${entry.entryId}.`),
                ),
              );
            if (Option.isSome(receipt) && receipt.value.status === "accepted") {
              const projection = yield* threads
                .getThreadProjection(entry.threadId)
                .pipe(
                  Effect.mapError(() => failure(`Cannot read accepted chat ${entry.threadId}.`)),
                );
              const message = projection.messages.find(
                (candidate) => candidate.id === entry.messageId,
              );
              if (!message)
                return yield* failure(
                  `Accepted message ${entry.messageId} is missing from ${entry.threadId}.`,
                );
              attachments = message.attachments;
            }
          }
          const recoveredWorkspace = yield* recoverAgentLaunchWorkspace({
            commandId: entry.commandId,
            projectId: entry.projectId,
            destination: entry.worktreeDestination,
            branch: entry.workspaceStrategy.branch,
          });
          return yield* Intake.launchThread({
            ...(entry.worktreeDestination
              ? { worktreeDestination: entry.worktreeDestination }
              : {}),
            ...(recoveredWorkspace ? { recoveredWorkspace } : {}),
            commandId: entry.commandId,
            threadId: entry.threadId,
            projectId: entry.projectId,
            title: entry.title,
            modelSelection: entry.modelSelection,
            runtimeMode: entry.runtimeMode,
            interactionMode: entry.interactionMode,
            workspaceStrategy: entry.workspaceStrategy,
            creator: accepted.creator,
            waitForPreparation: true,
            createdBy: "agent",
            creationSource: "mcp",
            ...(entry.message || entry.attachments?.length
              ? {
                  initialMessage: {
                    messageId: entry.messageId,
                    text: entry.message ?? "",
                    attachments,
                  },
                }
              : {}),
          });
        }).pipe(Effect.result);
        const projection =
          result._tag === "Success"
            ? result.success.projection
            : yield* threads
                .getThreadProjection(entry.threadId)
                .pipe(Effect.catch(() => Effect.succeed(null)));
        const prepared = yield* (yield* CommandReceiptStoreV2)
          .getByCommandId(CommandId.make(`${entry.commandId}:prepared`))
          .pipe(
            Effect.mapError(() => failure(`Cannot read preparation receipt for ${entry.entryId}.`)),
          );
        const thread = projection?.thread;
        const run = projection?.runs.find(
          (candidate) => candidate.userMessageId === entry.messageId,
        );
        const failureItem = projection?.visibleTurnItems.find(
          (row) => row.item.runId === run?.id && row.item.type === "error",
        );
        const recordedFailure =
          failureItem?.item.type === "error" ? failureItem.item.failure.message : null;
        return {
          entryId: entry.entryId,
          title: thread?.title ?? entry.title,
          threadId: thread?.id ?? null,
          projectId: entry.projectId,
          modelSelection: entry.modelSelection,
          runId: run?.id ?? null,
          preparationStatus:
            Option.isSome(prepared) && prepared.value.status === "accepted"
              ? ("ready" as const)
              : result._tag === "Failure" || run?.status === "failed"
                ? ("failed" as const)
                : ("preparing" as const),
          status:
            result._tag === "Failure" ? ("failed" as const) : (run?.status ?? ("idle" as const)),
          workspaceStrategy: entry.workspaceStrategy,
          worktreePath: thread?.worktreePath ?? null,
          branch: thread?.branch ?? null,
          error:
            recordedFailure ??
            (result._tag === "Failure" ? `${entry.entryId}: ${result.failure.message}` : null),
        };
      }),
    { concurrency: 1 },
  );
  return { threads: outcomes } satisfies AgentThreadLaunchResult;
});
