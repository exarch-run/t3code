import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Keep fork migrations in their own ledger so upstream additions cannot reuse an id.
const applyMigrations = Migrator.make({})({
  table: "exarch_v2_sql_migrations",
  loader: Migrator.fromRecord({
    "4_ScheduledTaskOutcome": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_outcome_kind TEXT`;
      yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_outcome_at TEXT`;
      yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_outcome_message TEXT`;
      yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_run_thread_id TEXT`;
    }),
    "3_ScheduledTaskPlugin": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN plugin_id TEXT`;
    }),
    "2_ScheduledTaskStartClean": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN start_clean INTEGER NOT NULL DEFAULT 0`;
    }),
    "1_ProjectSessionFiles": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE projection_projects ADD COLUMN session_files_json TEXT`;
    }),
  }),
});

// Adopt the fork ledger by its stable suffix when the application name changes.
// The ledger must move before the migrator runs, or it would repeat ALTER TABLE.
export const runExarchMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
  if (!tables.some((table) => table.name === "exarch_v2_sql_migrations")) {
    const previous = tables.filter((table) => table.name.endsWith("_v2_sql_migrations"));
    if (previous.length > 1) {
      return yield* Effect.die(
        new Error("Multiple fork migration ledgers found; refusing to choose one"),
      );
    }
    if (previous[0]) {
      yield* sql`ALTER TABLE ${sql(previous[0].name)} RENAME TO exarch_v2_sql_migrations`;
    }
  }
  return yield* applyMigrations;
});
