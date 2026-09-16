import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Keep fork migrations in their own ledger so upstream additions cannot reuse an id.
export const runStrataMigrations = Migrator.make({})({
  table: "strata_v2_sql_migrations",
  loader: Migrator.fromRecord({
    "1_ProjectSessionFiles": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE projection_projects ADD COLUMN session_files_json TEXT`;
    }),
  }),
});
