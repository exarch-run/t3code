import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";
import { createServer, type Server } from "node:http";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as StrataHostClient from "../../StrataHostClient.ts";
import { StrataToolkitHandlersLive } from "./handlers.ts";
import { StrataToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread-1");
const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: ENVIRONMENT_ID,
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(),
  issuedAt: 1,
};

interface Received {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** A stand-in for Strata's listener: records every request and answers what the test scripted. */
async function stubHost(
  answer: (received: Received) => { status: number; body: unknown },
): Promise<{ url: string; received: Received[]; close: () => Promise<void>; server: Server }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry: Received = {
        path: request.url ?? "",
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      received.push(entry);
      const reply = answer(entry);
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    received,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const makeHarness = (env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const client = StrataHostClient.layer({ env: () => env, timeoutMs: 2_000 });
    const toolkit = yield* StrataToolkit.pipe(
      Effect.provide(StrataToolkitHandlersLive.pipe(Layer.provide(client))),
    );
    const call = <Name extends keyof typeof StrataToolkit.tools>(
      name: Name,
      params: Parameters<typeof toolkit.handle<Name>>[1],
    ) =>
      toolkit.handle(name, params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map(
          (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof StrataToolkit.tools)[Name]>,
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provide(client),
      );
    return { call };
  });

describe("strata toolkit handlers", () => {
  it.effect("posts each tool request to Strata with the thread and environment and returns its JSON", () =>
    Effect.gen(function* () {
      const host = yield* Effect.promise(() =>
        stubHost((received) => ({
          status: 200,
          body: { ok: true, result: { echo: received.body, tool: received.path } },
        })),
      );
      try {
        const harness = yield* makeHarness({
          STRATA_HOST_URL: host.url,
          STRATA_HOST_TOKEN: "secret-token",
        });
        const result = yield* harness.call("strata_act", {
          actionId: "act-1",
          entries: [{ verb: "save", document: "/docs/a.md" }],
        });
        expect(result).toEqual({
          tool: "/tools/strata_act",
          echo: {
            threadId: "thread-1",
            environmentId: "environment-1",
            input: { actionId: "act-1", entries: [{ verb: "save", document: "/docs/a.md" }] },
          },
        });
        expect(host.received[0]?.authorization).toBe("Bearer secret-token");
        const documents = yield* harness.call("strata_open_documents", {});
        expect(documents).toMatchObject({ tool: "/tools/strata_open_documents" });
      } finally {
        yield* Effect.promise(host.close);
      }
    }),
  );

  it.effect("a refusal from Strata surfaces its code and message", () =>
    Effect.gen(function* () {
      const host = yield* Effect.promise(() =>
        stubHost(() => ({
          status: 400,
          body: { ok: false, error: { code: "NOT_ATTACHED", message: "Attach the thread first." } },
        })),
      );
      try {
        const harness = yield* makeHarness({ STRATA_HOST_URL: host.url, STRATA_HOST_TOKEN: "t" });
        const error = yield* harness.call("strata_document", {}).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "StrataToolFailedError",
          tool: "strata_document",
          code: "NOT_ATTACHED",
          detail: "Attach the thread first.",
        });
        expect(error.message).toBe("NOT_ATTACHED: Attach the thread first.");
      } finally {
        yield* Effect.promise(host.close);
      }
    }),
  );

  it.effect("unset variables and an unreachable host are one not-connected error", () =>
    Effect.gen(function* () {
      const unset = yield* makeHarness({});
      const missing = yield* unset.call("strata_items", {}).pipe(Effect.flip);
      expect(missing).toMatchObject({ _tag: "StrataNotConnectedError" });
      expect(missing.message).toBe(StrataHostClient.STRATA_NOT_CONNECTED_MESSAGE);

      const host = yield* Effect.promise(() => stubHost(() => ({ status: 200, body: { ok: true, result: {} } })));
      yield* Effect.promise(host.close);
      const gone = yield* makeHarness({ STRATA_HOST_URL: host.url, STRATA_HOST_TOKEN: "t" });
      const unreachable = yield* gone.call("strata_items", {}).pipe(Effect.flip);
      expect(unreachable).toMatchObject({ _tag: "StrataNotConnectedError" });
      expect(unreachable.message).toBe(StrataHostClient.STRATA_NOT_CONNECTED_MESSAGE);
    }),
  );
});
