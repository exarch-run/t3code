import { afterEach, expect, it } from 'vite-plus/test';
import { AuthSessionId, EnvironmentId } from '@t3tools/contracts';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as ConfigProvider from 'effect/ConfigProvider';
import { HttpClient, HttpClientResponse, HttpRouter, type HttpClientRequest } from 'effect/unstable/http';
import { CloudCliTokenManager } from '../cloud/CliTokenManager.ts';
import { ServerEnvironmentIdentity } from '../environment/ServerEnvironment.ts';
import { EnvironmentAuth } from '../auth/EnvironmentAuth.ts';
import { exarchRouteLayer } from '../http.ts';
import { randomUUID } from 'node:crypto';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
function fixture() {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const endpoint = { httpBaseUrl: 'https://speech.test', wsBaseUrl: 'wss://speech.test', providerKind: 'manual' };
  let push!: ReadableStreamDefaultController<Uint8Array>, rejectFirst = true;
  const stream = new ReadableStream<Uint8Array>({ start: controller => { push = controller; } });
  const client = HttpClient.make(request => Effect.sync(() => {
    requests.push(request);
    let value: unknown = {};
    if (request.url.endsWith('/v1/environments')) value = { environments: [{ environmentId: 'speech', label: 'Speech', endpoint, linkedAt: '2026-09-27T00:00:00Z' }] };
    else if (request.url.endsWith('/dpop-token')) value = { access_token: 'relay-token', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'DPoP', expires_in: 3600, scope: 'environment:connect' };
    else if (request.url.endsWith('/connect')) value = { environmentId: 'speech', endpoint, credential: 'bootstrap', expiresAt: '2026-09-28T00:00:00Z' };
    else if (request.url.endsWith('/oauth/token')) value = { access_token: 'remote-token', expires_in: 3600 };
    else if (request.url.includes('/speech/record/events')) {
      if (rejectFirst) { rejectFirst = false; return HttpClientResponse.fromWeb(request, new Response('', { status: 401 })); }
      return HttpClientResponse.fromWeb(request, new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    }
    return HttpClientResponse.fromWeb(request, Response.json(value));
  }));
  const app = HttpRouter.toWebHandler(exarchRouteLayer.pipe(Layer.provideMerge(Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(CloudCliTokenManager, { getExisting: Effect.succeed(Option.some({ accessToken: randomUUID() })) } as unknown as CloudCliTokenManager['Service']),
    Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(EnvironmentId.make('chat')) } as ServerEnvironmentIdentity['Service']),
    Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ T3CODE_RELAY_URL: 'https://relay.test' })),
    Layer.succeed(EnvironmentAuth, { authenticateHttpRequest: () => Effect.succeed({ sessionId: AuthSessionId.make('desktop'), subject: 'cloud-connect', method: 'dpop-access-token', scopes: ['orchestration:read', 'orchestration:operate', 'relay:write'] }) } as unknown as EnvironmentAuth['Service']),
  ))), { disableLogger: true });
  disposers.push(app.dispose);
  return { app, requests, push: (text: string) => push.enqueue(new TextEncoder().encode(text)), end: () => push.close() };
}
it('streams a separate speech host immediately, preserves private routing, and renews an unauthorized session once', async () => {
  const f = fixture();
  const response = await f.app.handler(new Request('https://chat.test/api/exarch/speech-bridge/speech/speech/record/events?private=1'));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const reader = response.body!.getReader();
  f.push('data: {"sealed":"opaque"}\n\n');
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: {"sealed":"opaque"}\n\n');
  const forwards = f.requests.filter(r => r.url.includes('/speech/record/events'));
  expect(forwards).toHaveLength(2);
  expect(forwards[1]!.url).toBe('https://speech.test/api/exarch/speech/record/events?private=1');
  expect(forwards[1]!.headers.authorization).toBe('DPoP remote-token');
  expect(forwards[1]!.headers.dpop).toBeTruthy();
  expect(f.requests.filter(r => r.url.endsWith('/oauth/token'))).toHaveLength(2);
  expect(f.requests.some(r => r.url.endsWith('/api/exarch/events'))).toBe(false);
  f.end(); await reader.cancel();
});
