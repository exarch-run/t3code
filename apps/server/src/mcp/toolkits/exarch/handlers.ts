import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ExarchHostClient from "../../ExarchHostClient.ts";
import {
  publishProgress,
  readProgressCard,
  TaskProgressRefusedError,
} from "../../../exarch/TaskProgressRuntime.ts";
import { ExarchToolkit, type ExarchResult } from "./tools.ts";

/**
 * Every Exarch document tool is one request to the host with the invocation's
 * thread and environment ids; Exarch answers with JSON. No capability gates
 * these handlers: the fork engine serves only Exarch, and a Exarch that is not
 * running answers as one not-connected error the agent can act on.
 *
 * The task card tools never leave the server: the chat comes from the
 * invocation and the card is written inside the orchestration transaction,
 * so they work with the document host off. The writer receives the raw call
 * and validates it itself (see TaskProgressInput).
 */
const make = Effect.gen(function* () {
  const client = yield* ExarchHostClient.ExarchHostClient;
  const call = (tool: string) => (input: unknown) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const result = yield* client.invoke({
        tool,
        threadId: scope.threadId,
        environmentId: scope.environmentId,
        input,
      });
      return (
        typeof result === "object" && result !== null ? result : { value: result }
      ) as ExarchResult;
    });
  return ExarchToolkit.of({
    exarch_document: call("exarch_document"),
    exarch_open_documents: call("exarch_open_documents"),
    exarch_items: call("exarch_items"),
    exarch_changes: call("exarch_changes"),
    exarch_resolve: call("exarch_resolve"),
    exarch_act: call("exarch_act"),
    exarch_render_check: call("exarch_render_check"),
    exarch_library: call("exarch_library"),
    exarch_components: call("exarch_components"),
    // The writer is a dynamic tool (raw JSON Schema), which cannot declare
    // the invocation context as a dependency; the MCP server still provides
    // it on every call, so read it from the context without requiring it.
    exarch_progress_card: (input: unknown) =>
      Effect.gen(function* () {
        const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
        if (Option.isNone(scope))
          return yield* new TaskProgressRefusedError({
            detail: "exarch_progress_card requires an agent session.",
          });
        return yield* publishProgress(scope.value.threadId, input);
      }),
    exarch_progress_card_read: () =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        return { card: yield* readProgressCard(scope.threadId) } as ExarchResult;
      }),
  });
});

export const ExarchToolkitHandlersLive = ExarchToolkit.toLayer(make);

/** The one registration McpHttpServer lists beside preview, pull requests, and device. */
export const ExarchToolkitRegistrationLive = McpServer.toolkit(ExarchToolkit).pipe(
  Layer.provide(ExarchToolkitHandlersLive),
  Layer.provide(ExarchHostClient.layer()),
);
