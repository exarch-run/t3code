import * as NodeCrypto from "node:crypto";
import { EnvironmentId } from "@t3tools/contracts";
import {
  RelayListEnvironmentsResponse,
  RelayEnvironmentConnectResponse,
  RelayDpopAccessTokenResponse,
} from "@t3tools/contracts/relay";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import * as Clock from "effect/Clock";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";
import { relayUrlConfig } from "../cloud/publicConfig.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

export const linkedComputerRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({
    action: Schema.Literal("send"),
    environmentId: EnvironmentId,
    packet: Schema.Unknown,
  }),
]);
type Session = {
  privateKey: NodeCrypto.KeyObject;
  jwk: DpopPublicJwk;
  origin: string;
  token: string;
  expires: number;
};
const sessions = new Map<string, Session>();
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Uses the existing account, relay discovery, DPoP exchange, and remote Exarch route. No credential leaves this process. */
export const linkedComputers = Effect.fn("exarch.linkedComputers")(function* (
  input: typeof linkedComputerRequest.Type,
) {
  const tokens = yield* CliTokenManager.CloudCliTokenManager;
  const stored = yield* tokens.getExisting;
  if (Option.isNone(stored)) return { computers: [] };
  const relay = yield* relayUrlConfig;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const ownId = yield* identity.getEnvironmentId;
  const client = yield* HttpClient.HttpClient;
  const request = Effect.fn("exarch.linkedComputerRequest")(function* (
    url: string,
    method: "GET" | "POST",
    headers: Record<string, string>,
    body?: string,
  ) {
    let input = HttpClientRequest.make(method)(url, { headers });
    if (body !== undefined)
      input = HttpClientRequest.bodyText(
        input,
        body,
        headers["content-type"] ?? "application/json",
      );
    const response = yield* client
      .execute(input)
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.timeout("20 seconds"),
      );
    if (response.status < 200 || response.status >= 300)
      return yield* new LinkedComputerError({ status: response.status });
    const text = yield* response.text;
    if (Buffer.byteLength(text) > 24 * 1024 * 1024) return yield* new LinkedComputerError({});
    return yield* decodeJson(text);
  });
  const now = yield* Clock.currentTimeMillis;
  const sessionKey =
    input.action === "send" ? `${stored.value.accessToken}:${input.environmentId}` : "";
  const cached = sessions.get(sessionKey);
  if (input.action === "send" && cached && cached.expires > now) {
    const url = `${cached.origin}/api/exarch/personal-setup`;
    return yield* request(
      url,
      "POST",
      {
        authorization: `DPoP ${cached.token}`,
        dpop: makeProof(cached.privateKey, cached.jwk, "POST", url, now, cached.token),
        "content-type": "application/json",
      },
      encode(input.packet),
    ).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (isLinkedComputerError(error) && (error.status === 401 || error.status === 403))
            sessions.delete(sessionKey);
        }),
      ),
    );
  }
  const list = yield* request(`${relay}/v1/environments`, "GET", {
    authorization: `Bearer ${stored.value.accessToken}`,
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RelayListEnvironmentsResponse)));
  const computers = list.environments.filter((computer) => computer.environmentId !== ownId);
  if (input.action === "list")
    return {
      computers: computers.map((computer) => ({
        id: computer.environmentId,
        name: computer.label,
      })),
    };
  if (!computers.some((computer) => computer.environmentId === input.environmentId))
    return yield* new LinkedComputerError({});
  const pair = yield* Effect.sync(() =>
    NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" }),
  );
  const jwk = pair.publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  const proof = Effect.fn("exarch.linkedComputerProof")(function* (
    method: string,
    url: string,
    accessToken?: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    return makeProof(pair.privateKey, jwk, method, url, now, accessToken);
  });
  const tokenUrl = `${relay}/v1/client/dpop-token`;
  const relayToken = yield* request(
    tokenUrl,
    "POST",
    { "content-type": "application/x-www-form-urlencoded", dpop: yield* proof("POST", tokenUrl) },
    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: stored.value.accessToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      resource: relay,
      scope: "environment:connect",
      client_id: "t3-web",
    }).toString(),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RelayDpopAccessTokenResponse)));
  const connectUrl = `${relay}/v1/environments/${encodeURIComponent(input.environmentId)}/connect`;
  const connection = yield* request(
    connectUrl,
    "POST",
    {
      authorization: `DPoP ${relayToken.access_token}`,
      dpop: yield* proof("POST", connectUrl, relayToken.access_token),
      "content-type": "application/json",
    },
    encode({ clientProofKeyThumbprint: computeDpopJwkThumbprint(jwk) }),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RelayEnvironmentConnectResponse)));
  const origin = connection.endpoint.httpBaseUrl.replace(/\/$/, "");
  if (new URL(origin).protocol !== "https:") return yield* new LinkedComputerError({});
  const exchangeUrl = `${origin}/oauth/token`;
  const token = yield* request(
    exchangeUrl,
    "POST",
    {
      "content-type": "application/x-www-form-urlencoded",
      dpop: yield* proof("POST", exchangeUrl),
    },
    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: connection.credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "orchestration:read orchestration:operate",
      client_label: "Exarch personal setup",
      client_device_type: "desktop",
    }).toString(),
  ).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String, expires_in: Schema.Finite }),
      ),
    ),
  );
  for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key);
  if (sessions.size >= 32) sessions.delete(sessions.keys().next().value!);
  sessions.set(sessionKey, {
    privateKey: pair.privateKey,
    jwk,
    origin,
    token: token.access_token,
    expires: now + Math.max(0, token.expires_in - 30) * 1000,
  });
  const url = `${origin}/api/exarch/personal-setup`;
  return yield* request(
    url,
    "POST",
    {
      authorization: `DPoP ${token.access_token}`,
      dpop: yield* proof("POST", url, token.access_token),
      "content-type": "application/json",
    },
    encode(input.packet),
  );
});

class LinkedComputerError extends Schema.TaggedError<LinkedComputerError>()("LinkedComputerError", {
  status: Schema.optionalKey(Schema.Finite),
}) {
  override get message() {
    return "The linked computer is unavailable or needs account authorization.";
  }
}
function makeProof(
  privateKey: NodeCrypto.KeyObject,
  jwk: DpopPublicJwk,
  method: string,
  url: string,
  now: number,
  accessToken?: string,
) {
  const header = Buffer.from(encode({ typ: "dpop+jwt", alg: "ES256", jwk })).toString("base64url");
  const payload = Buffer.from(
    encode({
      htm: method,
      htu: url,
      jti: NodeCrypto.randomUUID(),
      iat: Math.floor(now / 1000),
      ...(accessToken ? { ath: computeDpopAccessTokenHash(accessToken) } : {}),
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const isLinkedComputerError = Schema.is(LinkedComputerError);
