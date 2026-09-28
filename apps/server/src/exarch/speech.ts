/** Account-authorized speech forwarding. Credentials stay inside the engine. */
import { EnvironmentId } from '@t3tools/contracts';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import * as CliTokenManager from '../cloud/CliTokenManager.ts';
import { relayUrlConfig } from '../cloud/publicConfig.ts';
import { linkedComputers, makeProof, type LinkedSession } from './linkedComputers.ts';


export const speechBridge = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/api/exarch/speech-account/computers') {
    return HttpServerResponse.jsonUnsafe(yield* linkedComputers({ action: 'speech-computers' }));
  }
  let target: string, headers: Record<string,string>;
  let remote: { environmentId: EnvironmentId; path: string } | undefined;
  if (url.pathname === '/api/exarch/speech-account') {
    const tokens = yield* CliTokenManager.CloudCliTokenManager;
    const stored = yield* tokens.getExisting;
    if (Option.isNone(stored)) return HttpServerResponse.empty({ status: 401 });
    target = `${yield* relayUrlConfig}/v1/exarch/speech-primary`;
    headers = { authorization: `Bearer ${stored.value.accessToken}`, 'content-type': 'application/json' };
  } else {
    const match = /^\/api\/exarch\/speech-bridge\/([^/]+)(\/(?:speech\/.*|command))$/.exec(url.pathname);
    if (!match) return HttpServerResponse.empty({ status: 404 });
    const environmentId = yield* Schema.decodeEffect(EnvironmentId)(decodeURIComponent(match[1]!));
    remote = { environmentId, path: match[2]! };
    const value = yield* linkedComputers({ action: 'speech-session', environmentId });
    if (!value || typeof value !== 'object' || !('token' in value)) return HttpServerResponse.empty({ status: 401 });
    const session = value as LinkedSession;
    target = `${session.origin}/api/exarch${match[2]}${url.search}`;
    headers = { authorization: `DPoP ${session.token}`, dpop: makeProof(session.privateKey, session.jwk, request.method, target, yield* Clock.currentTimeMillis, session.token), 'content-type': 'application/json' };
  }
  const body = request.method === 'POST' ? yield* request.text : undefined;
  if (body && Buffer.byteLength(body) > 1_000_000) return HttpServerResponse.empty({ status: 413 });
  const client = yield* HttpClient.HttpClient;
  const send = (url: string, auth: Record<string, string>) => {
    let upstream = HttpClientRequest.make(request.method)(url, { headers: auth });
    if (body !== undefined) upstream = HttpClientRequest.bodyText(upstream, body, 'application/json');
    return client.execute(upstream).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }), Effect.timeout('20 seconds'));
  };
  let response = yield* send(target, headers);
  if (response.status === 401 && remote) {
    yield* response.text;
    const value = yield* linkedComputers({ action: 'speech-session', environmentId: remote.environmentId, refresh: true });
    if (!value || typeof value !== 'object' || !('token' in value)) return HttpServerResponse.empty({ status: 401 });
    const session = value as LinkedSession;
    target = `${session.origin}/api/exarch${remote.path}${url.search}`;
    response = yield* send(target, { authorization: `DPoP ${session.token}`, dpop: makeProof(session.privateKey, session.jwk, request.method, target, yield* Clock.currentTimeMillis, session.token), 'content-type': 'application/json' });
  }
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers: { 'content-type': response.headers['content-type'] ?? 'application/json', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' },
  });
});
