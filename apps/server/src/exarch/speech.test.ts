import { afterEach, expect, it } from "vite-plus/test";
import { AuthSessionId, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ConfigProvider from "effect/ConfigProvider";
import {
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  type HttpClientRequest,
} from "effect/unstable/http";
import { CloudCliTokenManager } from "../cloud/CliTokenManager.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { exarchRouteLayer } from "../http.ts";
import { randomUUID } from "node:crypto";
import { verifyDpopProof } from "@t3tools/shared/dpop";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});
/** The remote computer's own check: the proof must pass for the exact request it arrived on. */
function expectAcceptedProof(request: HttpClientRequest.HttpClientRequest) {
  expect(request.headers.authorization).toBe("DPoP remote-token");
  expect(
    verifyDpopProof({
      proof: request.headers.dpop,
      method: request.method,
      url: request.url,
      // @effect-diagnostics-next-line globalDate:off
      nowEpochSeconds: Math.floor(Date.now() / 1000),
      expectedAccessToken: "remote-token",
    }),
  ).toMatchObject({ ok: true });
}
function fixture() {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const endpoint = {
    httpBaseUrl: "https://speech.test",
    wsBaseUrl: "wss://speech.test",
    providerKind: "manual",
  };
  let push!: ReadableStreamDefaultController<Uint8Array>,
    rejectFirst = true,
    rejectCall = true;
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      push = controller;
    },
  });
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      let value: unknown = {};
      if (request.url.endsWith("/v1/environments"))
        value = {
          environments: [
            {
              environmentId: "speech",
              label: "Speech",
              endpoint,
              linkedAt: "2026-09-27T00:00:00Z",
            },
          ],
        };
      else if (request.url.endsWith("/dpop-token"))
        value = {
          access_token: "relay-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "DPoP",
          expires_in: 3600,
          scope: "environment:connect",
        };
      else if (request.url.endsWith("/connect"))
        value = {
          environmentId: "speech",
          endpoint,
          credential: "bootstrap",
          expiresAt: "2026-09-28T00:00:00Z",
        };
      else if (request.url.endsWith("/oauth/token"))
        value = { access_token: "remote-token", expires_in: 3600 };
      else if (request.url.includes("/speech/record/events")) {
        if (rejectFirst) {
          rejectFirst = false;
          return HttpClientResponse.fromWeb(request, new Response("", { status: 401 }));
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(stream, { headers: { "content-type": "text/event-stream" } }),
        );
      } else if (request.url.includes("/api/exarch/desktop/call")) {
        if (rejectCall) {
          rejectCall = false;
          return HttpClientResponse.fromWeb(request, new Response("", { status: 401 }));
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response((request.body as { body: Uint8Array }).body.slice(), {
            headers: { "content-type": "application/octet-stream" },
          }),
        );
      } else if (request.url.includes("/api/exarch/desktop/preview/")) {
        const headers = new Headers({
          location: "/v1/preview/5173/signed-in",
          "content-type": "text/html",
        });
        headers.append("set-cookie", "session=abc; Path=/v1/preview/5173/; HttpOnly");
        headers.append("set-cookie", "theme=dark; Path=/v1/preview/5173/");
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 302, headers }));
      }
      return HttpClientResponse.fromWeb(request, Response.json(value));
    }),
  );
  const app = HttpRouter.toWebHandler(
    exarchRouteLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, client),
          Layer.succeed(CloudCliTokenManager, {
            getExisting: Effect.succeed(Option.some({ accessToken: randomUUID() })),
          } as unknown as CloudCliTokenManager["Service"]),
          Layer.succeed(ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("chat")),
          } as ServerEnvironmentIdentity["Service"]),
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ T3CODE_RELAY_URL: "https://relay.test" }),
          ),
          Layer.succeed(EnvironmentAuth, {
            authenticateHttpRequest: () =>
              Effect.succeed({
                sessionId: AuthSessionId.make("desktop"),
                subject: "cloud-connect",
                method: "dpop-access-token",
                scopes: ["orchestration:read", "orchestration:operate", "relay:write"],
              }),
          } as unknown as EnvironmentAuth["Service"]),
        ),
      ),
    ),
    { disableLogger: true },
  );
  disposers.push(app.dispose);
  return {
    app,
    requests,
    push: (text: string) => push.enqueue(new TextEncoder().encode(text)),
    end: () => push.close(),
  };
}
it("streams a separate speech host immediately, preserves private routing, and renews an unauthorized session once", async () => {
  const f = fixture();
  const response = await f.app.handler(
    new Request("https://chat.test/api/exarch/speech-bridge/speech/speech/record/events?private=1"),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  f.push('data: {"sealed":"opaque"}\n\n');
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(
    'data: {"sealed":"opaque"}\n\n',
  );
  const forwards = f.requests.filter((r) => r.url.includes("/speech/record/events"));
  expect(forwards).toHaveLength(2);
  expect(forwards[1]!.url).toBe("https://speech.test/api/exarch/speech/record/events?private=1");
  expectAcceptedProof(forwards[1]!);
  expect(f.requests.filter((r) => r.url.endsWith("/oauth/token"))).toHaveLength(2);
  expect(f.requests.some((r) => r.url.endsWith("/api/exarch/events"))).toBe(false);
  f.end();
  await reader.cancel();
});

it("a window call reaches any path, and its buffered bytes are sent again after the session renews", async () => {
  const f = fixture();
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  const response = await f.app.handler(
    new Request("https://chat.test/api/exarch/computer-bridge/speech/desktop/call", {
      method: "POST",
      body: bytes,
      headers: { "content-type": "application/octet-stream", cookie: "mine=1" },
    }),
  );
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  const calls = f.requests.filter((r) => r.url.includes("/desktop/call"));
  expect(calls).toHaveLength(2);
  expect(calls[1]!.url).toBe("https://speech.test/api/exarch/desktop/call");
  expect(calls[1]!.headers["content-type"]).toBe("application/octet-stream");
  expectAcceptedProof(calls[1]!);
  expect(calls[1]!.headers.cookie).toBeUndefined();
  expect(response.headers.get("set-cookie")).toBeNull();
});

it("a window request carrying a query keeps it and is signed so the remote check accepts it", async () => {
  const f = fixture();
  const events = await f.app.handler(
    new Request("https://chat.test/api/exarch/computer-bridge/speech/desktop/events?control=c%201"),
  );
  expect(events.status).toBe(200);
  const upload = await f.app.handler(
    new Request(
      "https://chat.test/api/exarch/computer-bridge/speech/desktop/attachment?control=c&name=a.png",
      { method: "POST", body: new Uint8Array([1, 2]) },
    ),
  );
  expect(upload.status).toBe(200);
  const forwarded = f.requests.filter((r) => /\/desktop\/(events|attachment)/.test(r.url));
  expect(forwarded.map((r) => r.url)).toEqual([
    "https://speech.test/api/exarch/desktop/events?control=c%201",
    "https://speech.test/api/exarch/desktop/attachment?control=c&name=a.png",
  ]);
  for (const request of forwarded) expectAcceptedProof(request);
});

it("a preview page passes its own cookie, redirect and set-cookies through, and nothing else does", async () => {
  const f = fixture();
  const response = await f.app.handler(
    new Request(
      "https://chat.test/api/exarch/computer-bridge/speech/desktop/preview/control/5173/login",
      {
        redirect: "manual",
        headers: { cookie: "session=old" },
      },
    ),
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/v1/preview/5173/signed-in");
  expect(response.headers.getSetCookie()).toHaveLength(2);
  expect(response.headers.getSetCookie().join(";")).toContain("session=abc");
  const forward = f.requests.find((r) => r.url.includes("/desktop/preview/control/5173/login"))!;
  expect(forward.headers.cookie).toBe("session=old");
});
