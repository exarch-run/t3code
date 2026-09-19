import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runExarchMigrations } from "./ExarchMigrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
layer("Exarch migration ledger", (it) => {
  it.effect("preserves applied migrations across an application rename", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_projects (id TEXT PRIMARY KEY)`;
      yield* runExarchMigrations;
      const before = yield* sql`SELECT * FROM exarch_v2_sql_migrations`;
      yield* sql`ALTER TABLE exarch_v2_sql_migrations RENAME TO former_brand_v2_sql_migrations`;
      yield* runExarchMigrations;
      assert.deepEqual(yield* sql`SELECT * FROM exarch_v2_sql_migrations`, before);
      const old = yield* sql`SELECT name FROM sqlite_master WHERE name = 'former_brand_v2_sql_migrations'`;
      assert.equal(old.length, 0);
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
      assert.equal(columns.filter((column) => column.name === "session_files_json").length, 1);
      yield* runExarchMigrations;
      assert.deepEqual(yield* sql`SELECT * FROM exarch_v2_sql_migrations`, before);
    }),
  );
});
