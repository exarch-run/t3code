import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ConfigProvider from "effect/ConfigProvider";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http";
import { CloudCliTokenManager } from "../cloud/CliTokenManager.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { linkedComputers } from "./linkedComputers.ts";

function fixture(insecure = false, signedIn = true) {
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
    const [header, payload, signature] = request.headers.dpop!.split(".");
    const decoded = JSON.parse(Buffer.from(header!, "base64url").toString());
    expect(
      NodeCrypto.verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        {
          key: NodeCrypto.createPublicKey({ key: decoded.jwk, format: "jwk" }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({
      htm: "POST",
      htu: "https://remote.test/api/exarch/personal-setup",
    });
  }),
);
it.effect("refuses insecure remote endpoints before transmitting the bootstrap credential", () =>
  Effect.gen(function* () {
    const f = fixture(true);
    expect(
      (yield* f.run({ action: "send", environmentId: f.other, packet: {} }).pipe(Effect.flip))
        .message,
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
    expect((yield* f.run(input).pipe(Effect.flip)).message).toContain("unavailable");
    expect((yield* f.run(input).pipe(Effect.flip)).message).toContain("unavailable");
    expect(f.calls).toHaveLength(initial + 2);
    f.status(401);
    expect((yield* f.run(input).pipe(Effect.flip)).message).toContain("unavailable");
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
        .pipe(Effect.flip)).message,
    ).toContain("unavailable");
    expect(f.calls).toHaveLength(1);
  }),
);
