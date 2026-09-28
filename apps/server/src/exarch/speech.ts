/**
 * Account-authorized forwarding to the owner's other computers. Credentials stay inside the engine.
 * `/api/exarch/computer-bridge/<environment>/<path>` reaches `/api/exarch/<path>` on that computer;
 * `speech-bridge` is the same bridge under the name speech clients already use.
 */
import { EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";
import { relayUrlConfig } from "../cloud/publicConfig.ts";
import { isPreviewPath, previewHeaders } from "./http.ts";
import { linkedComputers, makeProof, type LinkedSession } from "./linkedComputers.ts";

/** Exarch's largest attachment is 50 MiB of raw bytes; the rest covers the request around it. */
const MAX_BODY_BYTES = 51 * 1024 * 1024;
const decodeEnvironmentId = Schema.decodeEffect(EnvironmentId);

export const speechBridge = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/api/exarch/speech-account/computers") {
    return HttpServerResponse.jsonUnsafe(yield* linkedComputers({ action: "computers" }));
  }
  let target: string, headers: Record<string, string>;
  let remote: { environmentId: EnvironmentId; path: string } | undefined;
  // Speech keeps its short wait for a dead host; a window's calls, such as starting a turn, may take longer to answer.
  let answerWithin: "20 seconds" | undefined = "20 seconds";
  if (url.pathname === "/api/exarch/speech-account") {
    const tokens = yield* CliTokenManager.CloudCliTokenManager;
    const stored = yield* tokens.getExisting;
    if (Option.isNone(stored)) return HttpServerResponse.empty({ status: 401 });
    target = `${yield* relayUrlConfig}/v1/exarch/speech-primary`;
    headers = {
      authorization: `Bearer ${stored.value.accessToken}`,
      "content-type": "application/json",
    };
  } else {
    const match = /^\/api\/exarch\/(speech|computer)-bridge\/([^/]+)(\/.+)$/.exec(url.pathname);
    if (!match) return HttpServerResponse.empty({ status: 404 });
    if (match[1] === "computer") answerWithin = undefined;
    const environmentId = yield* decodeEnvironmentId(decodeURIComponent(match[2]!));
    remote = { environmentId, path: match[3]! };
    const value = yield* linkedComputers({ action: "session", environmentId });
    if (!value || typeof value !== "object" || !("token" in value))
      return HttpServerResponse.empty({ status: 401 });
    const session = value as LinkedSession;
    target = `${session.origin}/api/exarch${remote.path}${url.search}`;
    headers = yield* signed(session, request.method, target);
  }
  const preview = remote !== undefined && isPreviewPath(remote.path);
  const passed: Record<string, string> = {
    "content-type": request.headers["content-type"] ?? "application/json",
  };
  for (const name of ["last-event-id", ...(preview ? ["cookie"] : [])]) {
    const value = request.headers[name];
    if (value !== undefined) passed[name] = value;
  }
  // Buffered so a renewed session can send the same bytes again.
  const body = request.method === "POST" ? new Uint8Array(yield* request.arrayBuffer) : undefined;
  if (body && body.byteLength > MAX_BODY_BYTES) return HttpServerResponse.empty({ status: 413 });
  const client = yield* HttpClient.HttpClient;
  const send = (url: string, auth: Record<string, string>) => {
    let upstream = HttpClientRequest.make(request.method)(url, { headers: { ...passed, ...auth } });
    if (body !== undefined)
      upstream = HttpClientRequest.bodyUint8Array(upstream, body, passed["content-type"]);
    const sent = client
      .execute(upstream)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
    return answerWithin ? sent.pipe(Effect.timeout(answerWithin)) : sent;
  };
  let response = yield* send(target, headers);
  if (response.status === 401 && remote) {
    yield* response.text;
    const value = yield* linkedComputers({
      action: "session",
      environmentId: remote.environmentId,
      refresh: true,
    });
    if (!value || typeof value !== "object" || !("token" in value))
      return HttpServerResponse.empty({ status: 401 });
    const session = value as LinkedSession;
    target = `${session.origin}/api/exarch${remote.path}${url.search}`;
    response = yield* send(target, yield* signed(session, request.method, target));
  }
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers: {
      "content-type": response.headers["content-type"] ?? "application/json",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      ...(preview ? previewHeaders(response.headers) : {}),
    },
    ...(preview ? { cookies: response.cookies } : {}),
  });
});

const signed = (session: LinkedSession, method: string, target: string) =>
  Effect.map(Clock.currentTimeMillis, (now) => ({
    authorization: `DPoP ${session.token}`,
    dpop: makeProof(session.privateKey, session.jwk, method, target, now, session.token),
  }));
