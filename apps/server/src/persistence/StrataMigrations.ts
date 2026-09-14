import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import SessionFiles from "./Migrations/051_ProjectionProjectsSessionFiles.ts";
import Progress from "./Migrations/052_StrataTaskProgress.ts";
import ProgressSeed from "./Migrations/053_StrataTaskProgressSeed.ts";
import ProgressV2 from "./Migrations/054_StrataTaskProgressV2.ts";

const entries = [
  [51, "ProjectionProjectsSessionFiles", SessionFiles],
  [52, "StrataTaskProgress", Progress],
  [53, "StrataTaskProgressSeed", ProgressSeed],
  [54, "StrataTaskProgressV2", ProgressV2],
] as const;
const table = "strata_sql_migrations";
interface Row {
  readonly migration_id: number;
  readonly name: string;
  readonly created_at: string;
}
const badHistory = (message: string) => new Migrator.MigrationError({ kind: "BadState", message });
const validPrefix = (rows: ReadonlyArray<Row>) =>
  rows.every(
    (row, index) => row.migration_id === entries[index]?.[0] && row.name === entries[index]?.[1],
  );

/** Transfer the old fork prefix exactly once, before upstream can reuse its IDs. Table creation and transfer commit together. */
export const prepareStrataHistory = Effect.fn("prepareStrataHistory")(function* (
  upstream: ReadonlyArray<readonly [number, string]>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('effect_sql_migrations', 'strata_sql_migrations')`;
      const oldRows = tables.some((row) => row.name === "effect_sql_migrations")
        ? yield* sql<Row>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`
        : [];
      if (tables.some((row) => row.name === table)) {
        const current =
          yield* sql<Row>`SELECT migration_id, name, created_at FROM strata_sql_migrations ORDER BY migration_id`;
        if (
          !validPrefix(current) ||
          oldRows.some((row) => entries.some(([, name]) => name === row.name))
        ) {
          return yield* badHistory(
            "Strata migration history is duplicated or does not match this build.",
          );
        }
        return;
      }
      if (
        oldRows.some((row) =>
          entries.some(([id, name]) => name === row.name && id !== row.migration_id),
        )
      ) {
        return yield* badHistory(
          "Strata migration names have unexpected IDs. The database was left unchanged.",
        );
      }
      const legacy = oldRows.filter(
        (row) =>
          row.migration_id >= 51 &&
          !upstream.some(([id, name]) => id === row.migration_id && name === row.name),
      );
      if (!validPrefix(legacy))
        return yield* badHistory(
          "Cannot separate unrecognized Strata migration history. The database was left unchanged.",
        );
      yield* sql`CREATE TABLE strata_sql_migrations (migration_id integer PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)`;
      for (const row of legacy) {
        yield* sql`INSERT INTO strata_sql_migrations (migration_id, name, created_at) VALUES (${row.migration_id}, ${row.name}, ${row.created_at})`;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${row.migration_id} AND name = ${row.name}`;
      }
    }),
  );
});

const run = Migrator.make({});
export const runStrataMigrations = (throughId?: number) =>
  run({
    table,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        entries
          .filter(([id]) => throughId === undefined || id <= throughId)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
