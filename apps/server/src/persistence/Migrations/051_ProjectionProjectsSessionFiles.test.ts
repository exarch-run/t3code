import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("051_ProjectionProjectsSessionFiles", (it) => {
  it.effect("adds a nullable session_files_json column and leaves existing rows null", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* sql`
        INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES ('project-1', 'Project 1', '/tmp/project-1', '[]', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', NULL)
      `;
      yield* runMigrations({ toMigrationInclusive: 51 });
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
      assert.isTrue(columns.some((column) => column.name === "session_files_json"));
      const rows = yield* sql<{ readonly sessionFiles: string | null }>`
        SELECT session_files_json AS "sessionFiles" FROM projection_projects WHERE project_id = 'project-1'
      `;
      assert.strictEqual(rows[0]?.sessionFiles, null);
      // Running again is a no-op.
      yield* runMigrations({ toMigrationInclusive: 51 });
    }),
  );
});
