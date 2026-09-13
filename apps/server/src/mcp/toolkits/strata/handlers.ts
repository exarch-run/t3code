import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as StrataHostClient from "../../StrataHostClient.ts";
import {
  publishProgress,
  readProgressCard,
  TaskProgressRefusedError,
} from "../../../strata/TaskProgressRuntime.ts";
import { StrataToolkit, type StrataResult } from "./tools.ts";

/**
 * Every Strata document tool is one request to the host with the invocation's
 * thread and environment ids; Strata answers with JSON. No capability gates
 * these handlers: the fork engine serves only Strata, and a Strata that is not
 * running answers as one not-connected error the agent can act on.
 *
 * The task card tools never leave the server: the chat comes from the
 * invocation and the card is written inside the orchestration transaction,
 * so they work with the document host off. The writer receives the raw call
 * and validates it itself (see TaskProgressInput).
 */
const make = Effect.gen(function* () {
  const client = yield* StrataHostClient.StrataHostClient;
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
      ) as StrataResult;
    });
  return StrataToolkit.of({
    strata_document: call("strata_document"),
    strata_open_documents: call("strata_open_documents"),
    strata_items: call("strata_items"),
    strata_changes: call("strata_changes"),
    strata_resolve: call("strata_resolve"),
    strata_act: call("strata_act"),
    strata_render_check: call("strata_render_check"),
    strata_components: call("strata_components"),
    // The writer is a dynamic tool (raw JSON Schema), which cannot declare
    // the invocation context as a dependency; the MCP server still provides
    // it on every call, so read it from the context without requiring it.
    strata_progress_card: (input: unknown) =>
      Effect.gen(function* () {
        const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
        if (Option.isNone(scope))
          return yield* new TaskProgressRefusedError({
            detail: "strata_progress_card requires an agent session.",
          });
        return yield* publishProgress(scope.value.threadId, input);
      }),
    strata_progress_card_read: () =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        return { card: yield* readProgressCard(scope.threadId) } as StrataResult;
      }),
  });
});

export const StrataToolkitHandlersLive = StrataToolkit.toLayer(make);

/** The one registration McpHttpServer lists beside preview, pull requests, and device. */
export const StrataToolkitRegistrationLive = McpServer.toolkit(StrataToolkit).pipe(
  Layer.provide(StrataToolkitHandlersLive),
  Layer.provide(StrataHostClient.layer()),
);
