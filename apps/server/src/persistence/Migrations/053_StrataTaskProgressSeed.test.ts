import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = () => it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const cursor = (sql: SqlClient.SqlClient) =>
  sql<{ readonly sequence: number }>`
    SELECT last_applied_sequence AS sequence FROM projection_state WHERE projector = 'strata_task_progress'
  `;

layer()("053_StrataTaskProgressSeed on an existing store", (it) => {
  it.effect(
    "starts the task progress projector at the other projectors' position on an existing store",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        for (const [projector, sequence] of [
          ["projection.threads", 525176],
          ["projection.projects", 525176],
          ["projection.thread-messages", 525100],
          ["projection.attachment-cleanup", 524928],
        ] as const) {
          yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES (${projector}, ${sequence}, '2026-09-12T21:44:18.570Z')
        `;
        }
        yield* runMigrations({ toMigrationInclusive: 53 });
        assert.strictEqual((yield* cursor(sql))[0]?.sequence, 525100);
        // Running again is a no-op and never moves an existing cursor.
        yield* sql`UPDATE projection_state SET last_applied_sequence = 7 WHERE projector = 'strata_task_progress'`;
        yield* runMigrations({ toMigrationInclusive: 53 });
        assert.strictEqual((yield* cursor(sql))[0]?.sequence, 7);
      }),
  );
});

layer()("053_StrataTaskProgressSeed on a fresh store", (it) => {
  it.effect("seeds a fresh store at zero", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      assert.strictEqual((yield* cursor(sql))[0]?.sequence, 0);
    }),
  );
});
