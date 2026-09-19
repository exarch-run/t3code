import { afterEach, expect, it, vi } from "vite-plus/test";
import { AuthSessionId, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  type HttpClientRequest,
} from "effect/unstable/http";
import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../auth/EnvironmentAuth.ts";
import { exarchRouteLayer } from "../http.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  vi.unstubAllEnvs();
});
function fixture(scopes: AuthEnvironmentScope[] | null) {
  vi.stubEnv("EXARCH_HOST_URL", "http://127.0.0.1:1234");
  vi.stubEnv("EXARCH_HOST_TOKEN", "launch-token");
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  let push!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = controller;
    },
  });
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      return HttpClientResponse.fromWeb(
        request,
        new Response(body, { headers: { "content-type": "text/event-stream" } }),
      );
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    exarchRouteLayer.pipe(
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth, {
          authenticateHttpRequest: () =>
            scopes === null
              ? Effect.fail(new ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make("phone-session"),
                  subject: "cloud-connect",
                  method: "dpop-access-token",
                  scopes,
                }),
        } as unknown as EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return {
    handler,
    requests,
    push: (text: string) => push.enqueue(new TextEncoder().encode(text)),
  };
}
it("refuses unauthenticated and insufficiently scoped requests before contacting the host", async () => {
  for (const [scopes, method, status] of [
    [null, "GET", 401],
    [[], "GET", 403],
    [["orchestration:read"], "POST", 403],
  ] as const) {
    const f = fixture(scopes === null ? null : [...scopes]);
    const response = await f.handler(
      new Request("https://computer.test/api/exarch/events", { method }),
    );
    expect(response.status).toBe(status);
    expect(f.requests).toHaveLength(0);
  }
});
it("preserves streaming, resume, and authenticated identity while dropping phone credentials", async () => {
  const f = fixture(["orchestration:read"]);
  const response = await f.handler(
    new Request("https://computer.test/api/exarch/events?threadId=chat", {
      headers: {
        authorization: "DPoP phone-token",
        dpop: "proof",
        "x-exarch-device": "spoofed",
        "x-exarch-engine": "spoofed-engine",
        "last-event-id": "revision-1",
      },
    }),
  );
  expect(response.status).toBe(200);
  const request = f.requests[0]!;
  expect(request.url).toBe("http://127.0.0.1:1234/v1/events?threadId=chat");
  expect(request.headers.authorization).toBe("Bearer launch-token");
  expect(request.headers["x-exarch-device"]).toBe("phone-session");
  expect(request.headers["last-event-id"]).toBe("revision-1");
  expect(request.headers.dpop).toBeUndefined();
  expect(request.headers["x-exarch-engine"]).toBeUndefined();
  const reader = response.body!.getReader();
  f.push("data: first\n\n");
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
  f.push("data: second\n\n");
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: second\n\n");
  await reader.cancel();
});
it("streams command bodies", async () => {
  const f = fixture(["orchestration:operate"]);
  const response = await f.handler(
    new Request("https://computer.test/api/exarch/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"type":"stop"}',
    }),
  );
  expect(f.requests[0]!.body._tag).toBe("Stream");
  await response.body!.cancel();
});
