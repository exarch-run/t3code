import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as StrataHostClient from "../../StrataHostClient.ts";
import { StrataToolkit, type StrataResult } from "./tools.ts";

/**
 * Every Strata tool is one request to the host with the invocation's thread
 * and environment ids; Strata answers with JSON. No capability gates these
 * handlers: the fork engine serves only Strata, and a Strata that is not
 * running answers as one not-connected error the agent can act on.
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
      return (typeof result === "object" && result !== null ? result : { value: result }) as StrataResult;
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
  });
});

export const StrataToolkitHandlersLive = StrataToolkit.toLayer(make);

/** The one registration McpHttpServer lists beside preview, pull requests, and device. */
export const StrataToolkitRegistrationLive = McpServer.toolkit(StrataToolkit).pipe(
  Layer.provide(StrataToolkitHandlersLive),
  Layer.provide(StrataHostClient.layer()),
);
