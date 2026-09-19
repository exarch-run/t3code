// @effect-diagnostics nodeBuiltinImport:off
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type TaskProgressCardV2,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, type Tool } from "effect/unstable/ai";
import * as NodeHttp from "node:http";
import * as Fiber from "effect/Fiber";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ExarchHostClient from "../../ExarchHostClient.ts";
import { installBridge } from "../../../exarch/TaskProgressRuntime.ts";
import {
  CODEX_MCP_WRITE_REFUSED,
  registerCodexRoute,
} from "../../../exarch/TaskProgressCodexRoute.ts";
import { ExarchToolkitHandlersLive } from "./handlers.ts";
import { ExarchToolkit } from "./tools.ts";

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

/** A stand-in for Exarch's listener: records every request and answers what the test scripted. */
async function stubHost(
  answer: (received: Received) => { status: number; body: unknown },
): Promise<{
  url: string;
  received: Received[];
  close: () => Promise<void>;
  server: NodeHttp.Server;
}> {
  const received: Received[] = [];
  const server = NodeHttp.createServer((request, response) => {
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

const makeHarness = (
  env: NodeJS.ProcessEnv,
  options: Omit<ExarchHostClient.ExarchHostClientOptions, "env"> = {},
) =>
  Effect.gen(function* () {
    const client = ExarchHostClient.layer({ env: () => env, timeoutMs: 2_000, ...options });
    const toolkit = yield* ExarchToolkit.pipe(
      Effect.provide(ExarchToolkitHandlersLive.pipe(Layer.provide(client))),
    );
    const call = <Name extends keyof typeof ExarchToolkit.tools>(
      name: Name,
      params: Parameters<typeof toolkit.handle<Name>>[1],
    ) =>
      toolkit.handle(name, params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map(
          (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof ExarchToolkit.tools)[Name]>,
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provide(client),
      );
    return { call };
  });

describe("exarch toolkit handlers", () => {
  it.effect(
    "posts each tool request to Exarch with the thread and environment and returns its JSON",
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
            EXARCH_HOST_URL: host.url,
            EXARCH_HOST_TOKEN: "secret-token",
          });
          const result = yield* harness.call("exarch_act", {
            actionId: "act-1",
            entries: [{ verb: "save", document: "/docs/a.md" }],
          });
          expect(result).toEqual({
            tool: "/tools/exarch_act",
            echo: {
              threadId: "thread-1",
              environmentId: "environment-1",
              input: { actionId: "act-1", entries: [{ verb: "save", document: "/docs/a.md" }] },
            },
          });
          expect(host.received[0]?.authorization).toBe("Bearer secret-token");
          const library = yield* harness.call("exarch_library", {});
          expect(library).toMatchObject({ tool: "/tools/exarch_library" });
          const documents = yield* harness.call("exarch_open_documents", {});
          expect(documents).toMatchObject({ tool: "/tools/exarch_open_documents" });
        } finally {
          yield* Effect.promise(host.close);
        }
      }),
  );

  it.effect("a refusal from Exarch surfaces its code and message", () =>
    Effect.gen(function* () {
      const host = yield* Effect.promise(() =>
        stubHost(() => ({
          status: 400,
          body: { ok: false, error: { code: "NOT_ATTACHED", message: "Attach the thread first." } },
        })),
      );
      try {
        const harness = yield* makeHarness({ EXARCH_HOST_URL: host.url, EXARCH_HOST_TOKEN: "t" });
        const error = yield* harness.call("exarch_document", {}).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ExarchToolFailedError",
          tool: "exarch_document",
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
      const missing = yield* unset.call("exarch_items", {}).pipe(Effect.flip);
      expect(missing).toMatchObject({ _tag: "ExarchNotConnectedError" });
      expect(missing.message).toBe(ExarchHostClient.EXARCH_NOT_CONNECTED_MESSAGE);

      const host = yield* Effect.promise(() =>
        stubHost(() => ({ status: 200, body: { ok: true, result: {} } })),
      );
      yield* Effect.promise(host.close);
      const gone = yield* makeHarness({ EXARCH_HOST_URL: host.url, EXARCH_HOST_TOKEN: "t" });
      const unreachable = yield* gone.call("exarch_items", {}).pipe(Effect.flip);
      expect(unreachable).toMatchObject({ _tag: "ExarchNotConnectedError" });
      expect(unreachable.message).toBe(ExarchHostClient.EXARCH_NOT_CONNECTED_MESSAGE);
    }),
  );
});

describe("task card handlers", () => {
  const card = {
    version: 2 as const,
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    markdown: "Halfway",
    steps: [{ step: "Read", status: "completed" as const }],
  };
  const fakeBridge = () => {
    const written: unknown[] = [];
    let current: TaskProgressCardV2 | null = card;
    const close = installBridge({
      enabled: Effect.succeed(true),
      write: (input) => {
        written.push(input);
        const empty = input.input.markdown === undefined && input.input.steps === undefined;
        current = empty
          ? null
          : {
              version: 2 as const,
              revision: 2,
              updatedAt: "2026-01-01T00:00:01.000Z",
              ...(input.input.markdown !== undefined ? { markdown: input.input.markdown } : {}),
              ...(input.input.steps !== undefined ? { steps: input.input.steps } : {}),
            };
        return Effect.succeed({
          card: current,
          revision: 2,
          updatedAt: "2026-01-01T00:00:01.000Z",
          generation: "g",
          turnId: null,
        });
      },
      read: () =>
        Effect.succeed({
          card: current,
          revision: current ? current.revision : 2,
          updatedAt: "2026-01-01T00:00:00.000Z",
          generation: "g",
          turnId: null,
        }),
    });
    return { written, close };
  };

  it.effect("writes the chat's card from the raw call and answers with the acknowledgement", () =>
    Effect.gen(function* () {
      const bridge = fakeBridge();
      try {
        const harness = yield* makeHarness({});
        expect(yield* harness.call("exarch_progress_card_read", {})).toEqual({ card });
        const result = yield* harness.call("exarch_progress_card", {
          markdown: "Halfway",
          plan: [
            { step: "Read", status: "completed" },
            { step: "Patch", status: "in_progress" },
          ],
        });
        expect(result).toEqual({
          message: "Progress card updated (rev 2, 1/2 done)",
          revision: 2,
          steps: { completed: 1, total: 2 },
        });
        expect(bridge.written).toEqual([
          {
            threadId: "thread-1",
            input: {
              markdown: "Halfway",
              steps: [
                { step: "Read", status: "completed" },
                { step: "Patch", status: "in_progress" },
              ],
            },
          },
        ]);
        // The earlier Exarch field names still decode into the same write.
        yield* harness.call("exarch_progress_card", {
          writeId: "native-2",
          plan: [{ text: "Legacy", status: "pending" }],
        });
        expect(bridge.written.at(-1)).toEqual({
          threadId: "thread-1",
          input: { steps: [{ step: "Legacy", status: "pending" }] },
        });
        expect(yield* harness.call("exarch_progress_card", {})).toEqual({
          message: "Progress card cleared",
          revision: null,
          steps: null,
        });
        expect(yield* harness.call("exarch_progress_card_read", {})).toEqual({ card: null });
      } finally {
        bridge.close();
      }
    }),
  );

  it.effect(
    "refuses the MCP writer for a chat whose card travels the Codex route, but still reads",
    () =>
      Effect.gen(function* () {
        const bridge = fakeBridge();
        const route = registerCodexRoute({ threadId: THREAD_ID, root: Effect.succeed("root") });
        try {
          const harness = yield* makeHarness({});
          const refused = yield* harness
            .call("exarch_progress_card", { markdown: "Through MCP" })
            .pipe(Effect.flip);
          expect(refused).toMatchObject({
            _tag: "TaskProgressRefusedError",
            detail: CODEX_MCP_WRITE_REFUSED,
          });
          expect(bridge.written).toEqual([]);
          expect(yield* harness.call("exarch_progress_card_read", {})).toEqual({ card });
        } finally {
          route.close();
          bridge.close();
        }
      }),
  );

  it.effect("refuses a misnamed checklist before writing, so the previous card survives", () =>
    Effect.gen(function* () {
      const bridge = fakeBridge();
      try {
        const harness = yield* makeHarness({});
        // The September 12 review sent its steps under the wrong name; the
        // decoder must not turn that into a note-only update.
        const refused = yield* harness
          .call("exarch_progress_card", {
            markdown: "Reviewing",
            steps: [{ step: "Read", status: "completed" }],
          })
          .pipe(Effect.flip);
        expect(refused).toMatchObject({
          _tag: "TaskProgressRefusedError",
          detail: expect.stringContaining('unknown field "steps"'),
        });
        const wrongStep = yield* harness
          .call("exarch_progress_card", { plan: [{ title: "Read", status: "completed" }] })
          .pipe(Effect.flip);
        expect(wrongStep).toMatchObject({
          detail: expect.stringContaining('plan[0] has an unknown field "title"'),
        });
        const twoActive = yield* harness
          .call("exarch_progress_card", {
            plan: [
              { step: "a", status: "in_progress" },
              { step: "b", status: "in_progress" },
            ],
          })
          .pipe(Effect.flip);
        expect(twoActive).toMatchObject({
          detail: expect.stringContaining("at most one in_progress"),
        });
        expect(bridge.written).toEqual([]);
        expect(yield* harness.call("exarch_progress_card_read", {})).toEqual({ card });
      } finally {
        bridge.close();
      }
    }),
  );
});

describe("uncertain document action outcomes", () => {
  for (const ending of ["lost-reply", "host-stop", "timeout"] as const) {
    it.effect(`keeps the action ID through ${ending} after admission`, () =>
      Effect.gen(function* () {
        let admitted!: () => void, release!: () => void, committed!: () => void;
        const admission = new Promise<void>((resolve) => {
          admitted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const commit = new Promise<void>((resolve) => {
          committed = resolve;
        });
        let effects = 0;
        const server = NodeHttp.createServer((request, response) => {
          request.resume();
          request.on("end", () => {
            admitted();
            void (async () => {
              if (ending === "host-stop") await gate;
              effects++;
              committed();
              if (ending === "lost-reply") response.destroy();
            })();
          });
        });
        yield* Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
        );
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("host did not bind");
        const harness = yield* makeHarness(
          { EXARCH_HOST_URL: `http://127.0.0.1:${address.port}`, EXARCH_HOST_TOKEN: "synthetic" },
          { timeoutMs: ending === "timeout" ? 100 : 2_000 },
        );
        try {
          const pending = yield* harness
            .call("exarch_act", { actionId: "original-action", entries: [{ verb: "comment" }] })
            .pipe(Effect.flip, Effect.forkScoped);
          yield* Effect.promise(() => admission);
          if (ending === "host-stop") server.closeAllConnections();
          const error = yield* Fiber.join(pending);
          expect(error).toMatchObject({
            _tag: "ExarchOutcomeUncertainError",
            actionId: "original-action",
          });
          expect(error.message).toContain('same actionId "original-action"');
          expect(error.message).toContain("Do not create a new action ID");
          expect(error.message).not.toContain("Propose the action");
          if (ending === "host-stop") {
            expect(effects).toBe(0);
            release();
          }
          yield* Effect.promise(() => commit);
          expect(effects).toBe(1);
        } finally {
          release();
          server.closeAllConnections();
          yield* Effect.promise(
            () => new Promise<void>((resolve) => server.close(() => resolve())),
          );
        }
      }),
    );
  }

  it.effect("preserves uncertainty for a failed or malformed successful response body", () =>
    Effect.gen(function* () {
      for (const body of ["throws", "malformed"] as const) {
        const fetch = (async () =>
          new Response(
            body === "throws"
              ? new ReadableStream({
                  start(controller) {
                    controller.error(new Error("body connection lost"));
                  },
                })
              : "not-json",
            { status: 200 },
          )) as typeof globalThis.fetch;
        const harness = yield* makeHarness(
          { EXARCH_HOST_URL: "http://synthetic.invalid", EXARCH_HOST_TOKEN: "synthetic" },
          { fetch },
        );
        const error = yield* harness
          .call("exarch_act", { actionId: "body-action", entries: [] })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ExarchOutcomeUncertainError",
          actionId: "body-action",
        });
        expect(error.message).toContain('same actionId "body-action"');
      }
    }),
  );

  it.effect("distinguishes an unsent action and an explicit refusal", () =>
    Effect.gen(function* () {
      const missing = yield* makeHarness({});
      expect(
        yield* missing.call("exarch_act", { actionId: "unsent", entries: [] }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "ExarchNotConnectedError" });
      const host = yield* Effect.promise(() =>
        stubHost(() => ({
          status: 409,
          body: {
            ok: false,
            error: { code: "NOT_LEAD", message: "The owner has not assigned the Lead." },
          },
        })),
      );
      try {
        const refused = yield* makeHarness({
          EXARCH_HOST_URL: host.url,
          EXARCH_HOST_TOKEN: "synthetic",
        });
        const error = yield* refused
          .call("exarch_act", { actionId: "refused", entries: [] })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "ExarchToolFailedError", code: "NOT_LEAD" });
      } finally {
        yield* Effect.promise(host.close);
      }
    }),
  );
});

it.effect("returns same-ID uncertainty advice in the actual MCP tool error result", () => {
  const host = ExarchHostClient.layer({
    env: () => ({ EXARCH_HOST_URL: "http://synthetic.invalid", EXARCH_HOST_TOKEN: "synthetic" }),
    fetch: (async () => {
      throw new Error("reply lost");
    }) as typeof globalThis.fetch,
  });
  const registration = McpServer.toolkit(ExarchToolkit).pipe(
    Layer.provide(ExarchToolkitHandlersLive),
    Layer.provide(host),
    Layer.provideMerge(McpServer.McpServer.layer),
  );
  const client = McpSchema.McpServerClient.of({
    clientId: 1,
    clientCapabilities: {},
    clientInfo: { name: "exarch-test", version: "1" },
    protocolVersion: "2025-06-18",
    initializePayload: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "exarch-test", version: "1" },
    },
    getClient: Effect.die("unused"),
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "exarch_act", arguments: { actionId: "wire-action", entries: [] } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining('same actionId "wire-action"') },
    ]);
  }).pipe(Effect.provide(registration));
});
