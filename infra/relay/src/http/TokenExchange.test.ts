import { createClerkClient, verifyToken } from "@clerk/backend";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { RelayApi } from "@t3tools/contracts/relay";
import { vi } from "vite-plus/test";

import * as AccountDeletions from "../account/AccountDeletions.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as RelayConfiguration from "../Config.ts";
import { tokenApi } from "./Api.ts";

vi.mock("@clerk/backend", () => ({
  createClerkClient: vi.fn(),
  verifyToken: vi.fn(),
}));

const settings = {
  relayIssuer: "https://relay.example.test",
  clerkSecretKey: Redacted.make("clerk-secret-key"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
} as RelayConfiguration.RelayConfiguration["Service"];

/** The real token exchange with the token, proof and deletion state it reads replaced in memory. */
function serve() {
  const checked: Array<string> = [];
  const services = Layer.mergeAll(
    Layer.succeed(RelayConfiguration.RelayConfiguration, settings),
    NodeCryptoLayer.layer,
    Layer.mock(RelayTokens.RelayTokens, {
      resolveDpopAccessTokenScopes: () => ["environment:connect"],
      issueDpopAccessToken: ({ userId }) => Effect.succeed(`relay-token-for-${userId}`),
    }),
    Layer.mock(DpopProofs.DpopProofReplay, {
      verifyAndConsume: () => Effect.succeed("thumbprint"),
    }),
    Layer.mock(AccountDeletions.AccountDeletions, {
      isBlocked: (userId) => {
        checked.push(userId);
        return Effect.succeed(false);
      },
    }),
  );
  const app = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.token)).pipe(
      Layer.provide(tokenApi.pipe(Layer.provide(services))),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
  return { app, checked };
}

const exchange = (subjectToken: string) =>
  new Request("https://relay.example.test/v1/client/dpop-token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", dpop: "proof" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: subjectToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      resource: "https://relay.example.test",
      scope: "environment:connect",
      client_id: "t3-web",
    }).toString(),
  });

const reset = Effect.sync(() => {
  vi.mocked(verifyToken).mockReset();
  vi.mocked(createClerkClient).mockReset();
});

describe("relay token exchange", () => {
  it.effect("accepts the Clerk OAuth sign-in a headless engine holds", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockRejectedValue(new Error("not a session JWT"));
      vi.mocked(createClerkClient).mockReturnValue({
        authenticateRequest: vi.fn().mockResolvedValue({
          isAuthenticated: true,
          toAuth: () => ({ userId: "user_oauth" }),
        }),
      } as never);
      const { app, checked } = serve();
      const response = yield* Effect.promise(() => app.handler(exchange("oauth-token")));
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        access_token: "relay-token-for-user_oauth",
        token_type: "DPoP",
      });
      expect(checked).toEqual(["user_oauth"]);
      yield* Effect.promise(() => app.dispose());
    }).pipe(Effect.ensuring(reset)),
  );

  it.effect("still accepts a relay-audience session token", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: "user_session",
        aud: "t3-code-relay",
      } as never);
      const { app } = serve();
      const response = yield* Effect.promise(() => app.handler(exchange("session-token")));
      expect(response.status).toBe(200);
      expect(createClerkClient).not.toHaveBeenCalled();
      yield* Effect.promise(() => app.dispose());
    }).pipe(Effect.ensuring(reset)),
  );

  it.effect("refuses a token neither verifier accepts", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockRejectedValue(new Error("bad"));
      vi.mocked(createClerkClient).mockReturnValue({
        authenticateRequest: vi
          .fn()
          .mockResolvedValue({ isAuthenticated: false, toAuth: () => ({}) }),
      } as never);
      const { app, checked } = serve();
      const response = yield* Effect.promise(() => app.handler(exchange("junk")));
      expect(response.status).toBe(401);
      expect(checked).toEqual([]);
      yield* Effect.promise(() => app.dispose());
    }).pipe(Effect.ensuring(reset)),
  );
});
