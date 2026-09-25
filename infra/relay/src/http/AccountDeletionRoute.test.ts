import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { RelayApi, type RelayDpopAccessTokenScope } from "@t3tools/contracts/relay";

import * as AccountDeletions from "../account/AccountDeletions.ts";
import * as MobileRegistrations from "../agentActivity/MobileRegistrations.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import { accountApi, mobileApi, relayDpopClientAuthLayer } from "./Api.ts";

const requestId = "0b9f8c62-3f5e-4a4b-9d7e-2c1a5f6e7d80";

/**
 * The real DPoP sign-in layer and handlers, with the token, proof and deletion
 * state they read replaced by in-memory values.
 */
function serve(options: {
  readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
  readonly blocked: boolean;
}) {
  const requested: Array<string> = [];
  const registered: Array<string> = [];
  const services = Layer.mergeAll(
    Layer.mock(RelayTokens.RelayTokens, {
      resolveDpopAccessTokenScopes: () => null,
      verifyDpopAccessToken: () =>
        Effect.succeed({
          iss: "https://relay.example.test",
          aud: "https://relay.example.test",
          sub: "user_a",
          jti: "jti",
          iat: 0,
          exp: 9_999_999_999,
          client_id: "t3-mobile" as const,
          scope: options.scopes,
          cnf: { jkt: "thumbprint" },
        }),
    }),
    Layer.mock(DpopProofs.DpopProofReplay, {
      verifyAndConsume: () => Effect.succeed("thumbprint"),
    }),
    Layer.mock(AccountDeletions.AccountDeletions, {
      isBlocked: () => Effect.succeed(options.blocked),
      request: ({ userId }) => {
        requested.push(userId);
        return Effect.succeed({
          status: options.blocked ? ("completed" as const) : ("pending" as const),
          requestedAt: "2026-09-25T00:00:00.000Z",
        });
      },
    }),
    Layer.mock(MobileRegistrations.MobileRegistrations, {
      registerDevice: ({ userId }) => {
        registered.push(userId);
        return Effect.succeed({ ok: true as const });
      },
    }),
  );
  const handlers = Layer.mergeAll(accountApi, mobileApi).pipe(
    Layer.provideMerge(relayDpopClientAuthLayer),
    Layer.provide(services),
  );
  const app = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(
      HttpApi.make("RelayApi").add(RelayApi.groups.account, RelayApi.groups.mobile),
    ).pipe(Layer.provide(handlers), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
  return { app, requested, registered };
}

const dpopHeaders = {
  authorization: "DPoP access-token",
  dpop: "proof",
  "content-type": "application/json",
};

const deletion = () =>
  new Request("https://relay.example.test/v1/account/deletion", {
    method: "POST",
    headers: dpopHeaders,
    body: `{"requestId":"${requestId}"}`,
  });

const registration = () =>
  new Request("https://relay.example.test/v1/mobile/devices", {
    method: "POST",
    headers: dpopHeaders,
    body: `{"deviceId":"phone","label":"Phone","platform":"android","androidApiLevel":34,"preferences":{"notificationsEnabled":true,"liveActivitiesEnabled":false,"notifyOnApproval":true,"notifyOnInput":true,"notifyOnCompletion":false,"notifyOnFailure":true}}`,
  });

describe("account deletion route", () => {
  it.effect("requires the account:delete scope", () =>
    Effect.gen(function* () {
      const { app, requested } = serve({ scopes: ["mobile:registration"], blocked: false });
      const response = yield* Effect.promise(() => app.handler(deletion()));
      expect(response.status).toBe(401);
      expect(requested).toEqual([]);
      yield* Effect.promise(() => app.dispose());
    }),
  );

  it.effect("records the deletion for the signed-in user and never caches the answer", () =>
    Effect.gen(function* () {
      const { app, requested } = serve({ scopes: ["account:delete"], blocked: false });
      const response = yield* Effect.promise(() => app.handler(deletion()));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(yield* Effect.promise(() => response.json())).toEqual({
        status: "pending",
        requestedAt: "2026-09-25T00:00:00.000Z",
      });
      expect(requested).toEqual(["user_a"]);
      yield* Effect.promise(() => app.dispose());
    }),
  );

  it.effect("a blocked account can read its deletion status but nothing else", () =>
    Effect.gen(function* () {
      const { app, registered } = serve({
        scopes: ["account:delete", "mobile:registration"],
        blocked: true,
      });
      const status = yield* Effect.promise(() => app.handler(deletion()));
      expect(status.status).toBe(200);
      expect(yield* Effect.promise(() => status.json())).toMatchObject({ status: "completed" });

      const refused = yield* Effect.promise(() => app.handler(registration()));
      expect(refused.status).toBe(401);
      expect(registered).toEqual([]);
      yield* Effect.promise(() => app.dispose());
    }),
  );

  it.effect("an account that isn't being deleted keeps working", () =>
    Effect.gen(function* () {
      const { app, registered } = serve({ scopes: ["mobile:registration"], blocked: false });
      const response = yield* Effect.promise(() => app.handler(registration()));
      expect(response.status).toBe(200);
      expect(registered).toEqual(["user_a"]);
      yield* Effect.promise(() => app.dispose());
    }),
  );
});
