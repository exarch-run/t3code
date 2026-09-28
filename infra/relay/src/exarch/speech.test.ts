import { afterEach, expect, it } from 'vite-plus/test';
import { RelayClientAuth, RelayClientPrincipal } from '@t3tools/contracts/relay';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { PgDialect } from 'drizzle-orm/pg-core';
import { RelayDb } from '../db.ts';
import { EnvironmentLinks } from '../environments/EnvironmentLinks.ts';
import { relaySpeechPrimary } from '../persistence/schema.ts';
import { speechRoutes } from './speech.ts';

type Row = typeof relaySpeechPrimary.$inferSelect;
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
function fixture() {
  const rows = new Map<string, Row>();
  const owned = new Set(['host-a', 'host-b']);
  const params = (condition: unknown) => new PgDialect().sqlToQuery(condition as never).params;
  const db = {
    select: () => ({ from: () => ({ where: (condition: unknown) => Effect.sync(() => { const row = rows.get(String(params(condition)[0])); return row ? [row] : []; }) }) }),
    insert: () => ({ values: (row: Row) => ({ onConflictDoNothing: () => ({ returning: () => Effect.sync(() => { if (rows.has(row.userId)) return []; rows.set(row.userId, row); return [row]; }) }) }) }),
    update: () => ({ set: (row: Row) => ({ where: (condition: unknown) => ({ returning: () => Effect.sync(() => { const [user, revision] = params(condition); if (rows.get(String(user))?.revision !== revision) return []; rows.set(row.userId, row); return [row]; }) }) }) }),
  } as unknown as RelayDb['Service'];
  let userId = 'user-one';
  const app = HttpRouter.toWebHandler(speechRoutes.pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(RelayDb, db),
    Layer.mock(EnvironmentLinks, { listForUser: () => Effect.succeed([...owned].map(environmentId => ({ environmentId })) as never) }),
    Layer.succeed(RelayClientAuth, { clientBearer: effect => Effect.provideService(effect, RelayClientPrincipal, { userId, token: 'test' }) }),
    HttpServer.layerServices,
  ))), { disableLogger: true });
  disposers.push(app.dispose);
  const request = (body?: unknown) => app.handler(new Request('https://relay.test/v1/exarch/speech-primary', { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  return { request, rows, owned, user: (id: string) => { userId = id; } };
}
it('keeps one account choice, compares revisions, rejects unlinked hosts and accepts arbitrary integration ids', async () => {
  const f = fixture();
  expect(await (await f.request()).json()).toEqual({ primary: null, revision: 0 });
  const primary = { environmentId: 'host-a', integrationId: 'user-created-runtime' };
  expect((await f.request({ primary, revision: 0 })).status).toBe(200);
  const responses = await Promise.all([f.request({ primary: null, revision: 1 }), f.request({ primary, revision: 1 })]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  expect((await f.request({ primary: { ...primary, environmentId: 'stranger' }, revision: 2 })).status).toBe(403);
  expect((await f.request({ primary, revision: 2 })).status).toBe(200);
  f.user('user-two');
  expect(await (await f.request()).json()).toEqual({ primary: null, revision: 0 });
  f.user('user-one'); f.owned.delete('host-a');
  expect(await (await f.request()).json()).toEqual({ primary: null, revision: 3 });
  expect(Object.keys(f.rows.get('user-one')!).sort()).toEqual(['environmentId', 'integrationId', 'revision', 'userId']);
});
