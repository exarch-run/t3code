import { and, eq } from 'drizzle-orm';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as HttpApi from 'effect/unstable/httpapi/HttpApi';
import * as HttpApiGroup from 'effect/unstable/httpapi/HttpApiGroup';
import * as HttpApiEndpoint from 'effect/unstable/httpapi/HttpApiEndpoint';
import * as HttpApiBuilder from 'effect/unstable/httpapi/HttpApiBuilder';
import * as HttpApiError from 'effect/unstable/httpapi/HttpApiError';
import { RelayClientAuth, RelayClientPrincipal, RelayBearerRequestHeaders } from '@t3tools/contracts/relay';
import { RelayDb } from '../db.ts';
import { EnvironmentLinks } from '../environments/EnvironmentLinks.ts';
import { relaySpeechPrimary } from '../persistence/schema.ts';

const primary = Schema.NullOr(Schema.Struct({ environmentId: Schema.String, integrationId: Schema.String }));
const choice = Schema.Struct({ primary, revision: Schema.Int });
const errors = [HttpApiError.BadRequest, HttpApiError.Forbidden, HttpApiError.Conflict, HttpApiError.InternalServerError];
export const SpeechApi = HttpApi.make('ExarchSpeech').add(HttpApiGroup.make('speech').add(
  HttpApiEndpoint.get('get', '/v1/exarch/speech-primary', { headers: RelayBearerRequestHeaders, success: choice, error: errors }),
  HttpApiEndpoint.post('set', '/v1/exarch/speech-primary', { headers: RelayBearerRequestHeaders, payload: choice, success: choice, error: errors }),
).middleware(RelayClientAuth));
const handlers = HttpApiBuilder.group(SpeechApi, 'speech', Effect.fnUntraced(function* (handlers) {
  const db = yield* RelayDb, links = yield* EnvironmentLinks;
  const read = Effect.fnUntraced(function* (userId: string) {
    const [row] = yield* db.select().from(relaySpeechPrimary).where(eq(relaySpeechPrimary.userId, userId));
    const owned = row?.environmentId ? (yield* links.listForUser({ userId })).some(link => link.environmentId === row.environmentId) : false;
    return { revision: row?.revision ?? 0, primary: owned && row?.environmentId && row.integrationId ? { environmentId: row.environmentId, integrationId: row.integrationId } : null };
  });
  return handlers.handle('get', () => Effect.gen(function* () {
    const { userId } = yield* RelayClientPrincipal;
    return yield* read(userId).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})));
  })).handle('set', ({ payload }) => Effect.gen(function* () {
    const { userId } = yield* RelayClientPrincipal;
    if (payload.revision < 0 || payload.revision >= 2147483647 || (payload.primary && (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(payload.primary.integrationId) || payload.primary.environmentId.length > 191))) return yield* new HttpApiError.BadRequest({});
    if (payload.primary && !(yield* links.listForUser({ userId }).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))).some(link => link.environmentId === payload.primary!.environmentId)) return yield* new HttpApiError.Forbidden({});
    const value = { userId, environmentId: payload.primary?.environmentId ?? null, integrationId: payload.primary?.integrationId ?? null, revision: payload.revision + 1 };
    const changed = yield* (payload.revision === 0
      ? db.insert(relaySpeechPrimary).values(value).onConflictDoNothing().returning()
      : db.update(relaySpeechPrimary).set(value).where(and(eq(relaySpeechPrimary.userId, userId), eq(relaySpeechPrimary.revision, payload.revision))).returning()
    ).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})));
    if (!changed.length) return yield* new HttpApiError.Conflict({});
    return { primary: payload.primary, revision: value.revision };
  }));
}));
export const speechRoutes = HttpApiBuilder.layer(SpeechApi).pipe(Layer.provide(handlers));
