import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";
import { createServer, type Server } from "node:http";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as StrataHostClient from "../../StrataHostClient.ts";
import { installBridge, NO_ACTIVE_RUN } from "../../../strata/TaskProgressRuntime.ts";
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
  it.effect(
    "posts each tool request to Strata with the thread and environment and returns its JSON",
    () =>
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

      const host = yield* Effect.promise(() =>
        stubHost(() => ({ status: 200, body: { ok: true, result: {} } })),
      );
      yield* Effect.promise(host.close);
      const gone = yield* makeHarness({ STRATA_HOST_URL: host.url, STRATA_HOST_TOKEN: "t" });
      const unreachable = yield* gone.call("strata_items", {}).pipe(Effect.flip);
      expect(unreachable).toMatchObject({ _tag: "StrataNotConnectedError" });
      expect(unreachable.message).toBe(StrataHostClient.STRATA_NOT_CONNECTED_MESSAGE);
    }),
  );
});

describe("task card handlers", () => {
  const receipt = {
    revision: 1,
    generation: "g",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sequence: 7,
  };
  const card = {
    version: 1 as const,
    revision: 1,
    generation: "g",
    runId: "turn-1",
    providerTurnId: "turn-1",
    markdown: "Halfway",
    plan: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    outcome: null,
    endedAt: null,
  };
  const fakeBridge = (activeTurn: string | null) => {
    const published: unknown[] = [];
    const close = installBridge({
      enabled: Effect.succeed(true),
      activeTurn: () => Effect.succeed(activeTurn),
      publish: (input) => {
        published.push(input);
        return Effect.succeed(receipt);
      },
      read: () => Effect.succeed(card),
    });
    return { published, close };
  };

  it.effect("writes the chat's card against the server's active turn and returns the receipt", () =>
    Effect.gen(function* () {
      const bridge = fakeBridge("turn-1");
      try {
        const harness = yield* makeHarness({});
        const result = yield* harness.call("strata_progress_card", {
          writeId: "w1",
          markdown: "Halfway",
          plan: [{ text: "Read", status: "completed" }],
        });
        expect(result).toEqual(receipt);
        expect(bridge.published).toEqual([
          {
            threadId: "thread-1",
            providerTurnId: "turn-1",
            writeId: "w1",
            digest: expect.any(String),
            content: { markdown: "Halfway", plan: [{ text: "Read", status: "completed" }] },
          },
        ]);
        expect(yield* harness.call("strata_progress_card_read", {})).toEqual({ card });
      } finally {
        bridge.close();
      }
    }),
  );

  it.effect("refuses a write when no run is active and when the content is unusable", () =>
    Effect.gen(function* () {
      const idle = fakeBridge(null);
      try {
        const harness = yield* makeHarness({});
        const refused = yield* harness
          .call("strata_progress_card", { writeId: "w1", markdown: "Late" })
          .pipe(Effect.flip);
        expect(refused).toMatchObject({ _tag: "TaskProgressRefusedError", detail: NO_ACTIVE_RUN });
        expect(idle.published).toEqual([]);
      } finally {
        idle.close();
      }
      const running = fakeBridge("turn-1");
      try {
        const harness = yield* makeHarness({});
        const empty = yield* harness
          .call("strata_progress_card", { writeId: "w2" })
          .pipe(Effect.flip);
        expect(empty).toMatchObject({
          _tag: "TaskProgressRefusedError",
          detail: expect.stringContaining("Supply a status note, plan, or both"),
        });
        expect(running.published).toEqual([]);
      } finally {
        running.close();
      }
    }),
  );
});
