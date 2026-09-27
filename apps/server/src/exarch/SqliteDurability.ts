import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import type { AuthPairingLinkRepository } from "../persistence/AuthPairingLinks.ts";
import type { AuthSessionRepository } from "../persistence/AuthSessions.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";

/**
 * Exarch runs the engine's database with the durability SQLite recommends for
 * WAL mode. With the default FULL, every commit waits for the disk on the
 * engine's only thread; the engine commits each agent event on its own, so
 * those waits stall the whole server. NORMAL syncs at checkpoints instead.
 * The database cannot be corrupted by this, and an app or engine crash still
 * loses nothing. A power cut or kernel crash can lose the most recent commits.
 * The checkpoint interval stays at SQLite's default, since a longer one would
 * widen that window.
 *
 * The page cache grows from SQLite's 2 MB default to about 64 MB, so hot
 * projection pages stay in memory. A negative cache_size is in KiB.
 */
export const EXARCH_SQLITE_CACHE_KIB = 64 * 1024;

export const applyExarchSqliteDurability = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA synchronous = NORMAL;`;
  yield* sql.unsafe(`PRAGMA cache_size = -${EXARCH_SQLITE_CACHE_KIB};`);
});

/**
 * Losing recent agent events after a power cut is accepted; losing an auth
 * write is not. A revoked session or a consumed pairing link that came back
 * would make a spent credential work again. So every auth write commits with
 * synchronous = FULL, which syncs the WAL before the commit returns.
 *
 * The setting belongs to the connection and SQLite refuses to change it inside
 * a transaction, so each write runs between two pragma changes. Writes from
 * other fibers that land in between are only synced sooner. Auth writes take
 * turns, so none can restore NORMAL while another is still waiting to commit.
 */
const authWriteTurn = Semaphore.makeUnsafe(1);

const fullySynced =
  (sql: SqlClient.SqlClient) =>
  <A, E>(write: Effect.Effect<A, E>): Effect.Effect<A, E | PersistenceSqlError> =>
    authWriteTurn.withPermits(1)(
      Effect.acquireUseRelease(
        sql`PRAGMA synchronous = FULL;`.pipe(
          Effect.mapError(
            (cause) => new PersistenceSqlError({ operation: "ExarchSqliteDurability.full", cause }),
          ),
        ),
        () => write,
        // Failing to restore NORMAL leaves the connection slower, never less safe.
        () => Effect.ignore(sql`PRAGMA synchronous = NORMAL;`),
      ),
    );

export const fullySyncedAuthSessions = Effect.fn("ExarchSqliteDurability.authSessions")(function* (
  sessions: AuthSessionRepository["Service"],
) {
  const synced = fullySynced(yield* SqlClient.SqlClient);
  return {
    ...sessions,
    create: (input) => synced(sessions.create(input)),
    createReplacingActive: (input) => synced(sessions.createReplacingActive(input)),
    createIfAbsent: (input) => synced(sessions.createIfAbsent(input)),
    revoke: (input) => synced(sessions.revoke(input)),
    revokeAllExcept: (input) => synced(sessions.revokeAllExcept(input)),
    setLastConnectedAt: (input) => synced(sessions.setLastConnectedAt(input)),
    setClientConnection: (input) => synced(sessions.setClientConnection(input)),
  } satisfies AuthSessionRepository["Service"];
});

export const fullySyncedAuthPairingLinks = Effect.fn("ExarchSqliteDurability.authPairingLinks")(
  function* (links: AuthPairingLinkRepository["Service"]) {
    const synced = fullySynced(yield* SqlClient.SqlClient);
    return {
      ...links,
      create: (input) => synced(links.create(input)),
      consumeAvailable: (input) => synced(links.consumeAvailable(input)),
      revoke: (input) => synced(links.revoke(input)),
    } satisfies AuthPairingLinkRepository["Service"];
  },
);
