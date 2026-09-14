import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "./Migrations.ts";

{
  for (const legacy of [false, true])
    it.effect(`preserves data and admits upstream 51 once (${legacy ? "legacy" : "fresh"})`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`INSERT INTO strata_task_progress_v2 (thread_id, revision, generation, markdown) VALUES ('t1', 7, 'g1', 'Saved card')`;
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, session_files_json) VALUES ('p1', 'Project', '/tmp/project', '[]', 'now', 'now', '["context.md"]')`;
        if (legacy) {
          yield* sql`INSERT INTO effect_sql_migrations SELECT * FROM strata_sql_migrations`;
          yield* sql`DROP TABLE strata_sql_migrations`;
        }
        yield* runMigrations();
        const upstream = yield* sql<{
          readonly id: number;
        }>`SELECT MAX(migration_id) AS id FROM effect_sql_migrations`;
        assert.strictEqual(upstream[0]?.id, 50);
        const fork = yield* sql<{
          readonly migration_id: number;
        }>`SELECT migration_id FROM strata_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          fork.map((row) => row.migration_id),
          [51, 52, 53, 54],
        );
        const next = Migrator.make({})({
          loader: Migrator.fromRecord({
            "51_NextUpstream": Effect.gen(function* () {
              yield* sql`CREATE TABLE upstream_51_probe (id INTEGER PRIMARY KEY)`;
              yield* sql`INSERT INTO upstream_51_probe VALUES (1)`;
            }),
          }),
        });
        yield* next;
        yield* runMigrations();
        assert.deepStrictEqual(yield* next, []);
        assert.strictEqual(
          (yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM upstream_51_probe`)[0]?.count,
          1,
        );
        assert.deepStrictEqual(
          (yield* sql`SELECT revision, markdown FROM strata_task_progress_v2 WHERE thread_id = 't1'`)[0],
          { revision: 7, markdown: "Saved card" },
        );
        assert.strictEqual(
          (yield* sql<{
            readonly session_files_json: string;
          }>`SELECT session_files_json FROM projection_projects WHERE project_id = 'p1'`)[0]
            ?.session_files_json,
          '["context.md"]',
        );
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
    );

  for (const invalid of ["mismatch", "duplicate"])
    it.effect(`refuses ${invalid} history without changing it`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        if (invalid === "duplicate")
          yield* sql`INSERT INTO effect_sql_migrations SELECT * FROM strata_sql_migrations`;
        else {
          yield* sql`INSERT INTO effect_sql_migrations SELECT * FROM strata_sql_migrations`;
          yield* sql`DROP TABLE strata_sql_migrations`;
          yield* sql`UPDATE effect_sql_migrations SET name = 'WrongMigration' WHERE migration_id = 52`;
        }
        const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          before,
        );
        if (invalid === "mismatch")
          assert.deepStrictEqual(
            yield* sql`SELECT name FROM sqlite_master WHERE name = 'strata_sql_migrations'`,
            [],
          );
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
    );
}
