import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import { EnvironmentId } from "@t3tools/contracts";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ConfigProvider from "effect/ConfigProvider";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http";
import { CloudCliTokenManager } from "../cloud/CliTokenManager.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { linkedComputers } from "./linkedComputers.ts";

function fixture(insecure = false, signedIn = true, offline = false) {
  let remoteStatus = 200;
  const calls: HttpClientRequest.HttpClientRequest[] = [];
  const own = EnvironmentId.make("own"),
    other = EnvironmentId.make("other");
  const endpoint = {
    httpBaseUrl: `${insecure ? "http" : "https"}://remote.test`,
    wsBaseUrl: "wss://remote.test",
    providerKind: "manual",
  };
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      calls.push(request);
      let response: unknown = { received: true };
      if (request.url.endsWith("/v1/environments"))
        response = {
          environments: [own, other].map((environmentId) => ({
            environmentId,
            label: environmentId,
            endpoint,
            linkedAt: "2026-09-21T00:00:00Z",
          })),
        };
      else if (request.url.endsWith("/dpop-token"))
        response = {
          access_token: "relay-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "DPoP",
          expires_in: 3600,
          scope: "environment:connect",
        };
      else if (request.url.endsWith("/connect"))
        response = {
          environmentId: other,
          endpoint,
          credential: "bootstrap",
          expiresAt: "2026-09-22T00:00:00Z",
        };
      else if (request.url.endsWith("/oauth/token"))
        response = { access_token: "remote-token", expires_in: 3600 };
      else if (request.url.endsWith("/status")) {
        if (offline) return HttpClientResponse.fromWeb(request, new Response("", { status: 504 }));
        response = {
          environmentId: other,
          endpoint,
          status: "online",
          checkedAt: "2026-09-27T00:00:00Z",
        };
      } else if (request.method === "DELETE") response = { ok: true };
      return HttpClientResponse.fromWeb(
        request,
        Response.json(response, {
          status: request.url.endsWith("/personal-setup") ? remoteStatus : 200,
        }),
      );
    }),
  );
  const token = NodeCrypto.randomUUID();
  const run = (input: Parameters<typeof linkedComputers>[0]) =>
    linkedComputers(input).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(CloudCliTokenManager, {
        getExisting: Effect.succeed(signedIn ? Option.some({ accessToken: token }) : Option.none()),
      } as unknown as CloudCliTokenManager["Service"]),
      Effect.provideService(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(own),
      } as ServerEnvironmentIdentity["Service"]),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ T3CODE_RELAY_URL: "https://relay.test" }),
      ),
    );
  return {
    calls,
    run,
    other,
    status: (value: number) => {
      remoteStatus = value;
    },
  };
}
it.effect("excludes itself and reuses a signed session without repeating enrollment", () =>
  Effect.gen(function* () {
    const f = fixture();
    expect(yield* f.run({ action: "list" })).toEqual({
      computers: [{ id: "other", name: "other" }],
    });
    yield* f.run({ action: "send", environmentId: f.other, packet: { ciphertext: "opaque" } });
    const count = f.calls.length;
    expect(
      yield* f.run({ action: "send", environmentId: f.other, packet: { ciphertext: "next" } }),
    ).toEqual({ received: true });
    expect(f.calls).toHaveLength(count + 1);
    const request = f.calls.at(-1)!;
    expect(request.headers.authorization).toBe("DPoP remote-token");
    expect(
      verifyDpopProof({
        proof: request.headers.dpop,
        method: request.method,
        url: request.url,
        nowEpochSeconds: Math.floor((yield* Clock.currentTimeMillis) / 1000),
        expectedAccessToken: "remote-token",
      }),
    ).toMatchObject({ ok: true });
  }),
);
it.effect("refuses insecure remote endpoints before transmitting the bootstrap credential", () =>
  Effect.gen(function* () {
    const f = fixture(true);
    expect(
      (yield* f.run({ action: "send", environmentId: f.other, packet: {} }).pipe(
        Effect.match({
          onFailure: (error) => ({ message: String(error) }),
          onSuccess: () => ({ message: "unexpected success" }),
        }),
      )).message,
    ).toContain("unavailable");
    expect(f.calls.every((request) => request.url.startsWith("https://relay.test"))).toBe(true);
  }),
);

it.effect("keeps sessions for unavailable plugins but replaces an unauthorized session", () =>
  Effect.gen(function* () {
    const f = fixture();
    const input = { action: "send" as const, environmentId: f.other, packet: {} };
    yield* f.run(input);
    const initial = f.calls.length;
    f.status(503);
    expect(
      (yield* f.run(input).pipe(
        Effect.match({
          onFailure: (error) => ({ message: String(error) }),
          onSuccess: () => ({ message: "unexpected success" }),
        }),
      )).message,
    ).toContain("unavailable");
    expect(
      (yield* f.run(input).pipe(
        Effect.match({
          onFailure: (error) => ({ message: String(error) }),
          onSuccess: () => ({ message: "unexpected success" }),
        }),
      )).message,
    ).toContain("unavailable");
    expect(f.calls).toHaveLength(initial + 2);
    f.status(401);
    expect(
      (yield* f.run(input).pipe(
        Effect.match({
          onFailure: (error) => ({ message: String(error) }),
          onSuccess: () => ({ message: "unexpected success" }),
        }),
      )).message,
    ).toContain("unavailable");
    f.status(200);
    yield* f.run(input);
    expect(f.calls).toHaveLength(initial + 8);
  }),
);
it.effect("does not contact the network without an account and refuses an unlisted computer", () =>
  Effect.gen(function* () {
    const empty = fixture(false, false);
    expect(yield* empty.run({ action: "list" })).toEqual({ computers: [] });
    expect(empty.calls).toHaveLength(0);
    const f = fixture();
    expect(
      (yield* f
        .run({ action: "send", environmentId: EnvironmentId.make("unlisted"), packet: {} })
        .pipe(
          Effect.match({
            onFailure: (error) => ({ message: String(error) }),
            onSuccess: () => ({ message: "unexpected success" }),
          }),
        )).message,
    ).toContain("unavailable");
    expect(f.calls).toHaveLength(1);
  }),
);

it.effect(
  "discovery marks this host and internal sessions renew without exposing them in discovery",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      expect(yield* f.run({ action: "computers" })).toEqual({
        computers: [
          { id: "own", name: "own", self: true },
          { id: "other", name: "other" },
        ],
      });
      const first = yield* f.run({ action: "session", environmentId: f.other });
      const count = f.calls.length;
      expect(yield* f.run({ action: "session", environmentId: f.other })).toBe(first);
      expect(f.calls).toHaveLength(count);
      expect(yield* f.run({ action: "session", environmentId: f.other, refresh: true })).not.toBe(
        first,
      );
      expect(f.calls.length).toBeGreaterThan(count);
    }),
);

it.effect(
  "status checks each other computer with a status-scoped relay pass and reports a failed check as unknown",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      expect(yield* f.run({ action: "status" })).toEqual({
        computers: [
          { id: "own", status: "online" },
          { id: "other", status: "online" },
        ],
      });
      const pass = f.calls.find((call) => call.url.endsWith("/dpop-token"))!;
      expect(new TextDecoder().decode((pass.body as { body: Uint8Array }).body)).toContain(
        "scope=environment%3Astatus",
      );
      const check = f.calls.find((call) => call.url.endsWith("/status"))!;
      expect(check.url).toBe("https://relay.test/v1/environments/other/status");
      expect(check.headers.authorization).toBe("DPoP relay-token");
      expect(
        verifyDpopProof({
          proof: check.headers.dpop,
          method: check.method,
          url: check.url,
          nowEpochSeconds: Math.floor((yield* Clock.currentTimeMillis) / 1000),
          expectedAccessToken: "relay-token",
        }),
      ).toMatchObject({ ok: true });
      expect(f.calls.some((call) => call.url.endsWith("/connect"))).toBe(false);
      expect(yield* fixture(false, true, true).run({ action: "status" })).toEqual({
        computers: [
          { id: "own", status: "online" },
          { id: "other", status: "unknown" },
        ],
      });
    }),
);

it.effect("unlink removes another computer from the account and refuses this one", () =>
  Effect.gen(function* () {
    const f = fixture();
    expect(yield* f.run({ action: "unlink", environmentId: f.other })).toEqual({ ok: true });
    const removal = f.calls.find((call) => call.method === "DELETE")!;
    expect(removal.url).toBe("https://relay.test/v1/client/environment-links/other");
    expect(removal.headers.authorization).toMatch(/^Bearer /);
    const refused = yield* f
      .run({ action: "unlink", environmentId: EnvironmentId.make("own") })
      .pipe(Effect.match({ onFailure: () => "refused", onSuccess: () => "removed" }));
    expect(refused).toBe("refused");
    expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  }),
);
