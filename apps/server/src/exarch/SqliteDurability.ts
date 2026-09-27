import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

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
