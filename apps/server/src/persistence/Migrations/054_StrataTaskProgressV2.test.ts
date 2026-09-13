import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parse = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = () => it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer()("054_StrataTaskProgressV2", (it) => {
  it.effect("moves saved cards into the canonical record without losing text or steps", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      const wide = "a".repeat(700);
      yield* sql`INSERT INTO strata_task_progress (thread_id, card_json) VALUES ('t1', ${json({
        version: 1,
        revision: 4,
        generation: "g",
        markdown: "Kept",
        plan: [
          { text: "Read", status: "completed" },
          { text: wide, status: "in_progress" },
        ],
        runId: "turn-9",
        providerTurnId: "turn-9",
        updatedAt: "2026-09-12T00:00:00.000Z",
        outcome: "completed",
        endedAt: "2026-09-12T00:01:00.000Z",
      })})`;
      yield* sql`INSERT INTO strata_task_progress (thread_id, card_json) VALUES ('broken', 'not json')`;
      yield* runMigrations({ toMigrationInclusive: 54 });
      const rows = yield* sql<{
        thread_id: string;
        revision: number;
        generation: string;
        markdown: string | null;
        steps_json: string | null;
        turn_id: string | null;
        updated_at: string | null;
      }>`SELECT * FROM strata_task_progress_v2 ORDER BY thread_id`;
      assert.strictEqual(rows.length, 1);
      const row = rows[0]!;
      assert.strictEqual(row.thread_id, "t1");
      assert.strictEqual(row.revision, 4);
      assert.strictEqual(row.markdown, "Kept");
      assert.deepStrictEqual(parse(row.steps_json ?? "[]"), [
        { step: "Read", status: "completed" },
        { step: wide, status: "in_progress" },
      ]);
      assert.strictEqual(row.turn_id, "turn-9");
      assert.strictEqual(row.updated_at, "2026-09-12T00:00:00.000Z");
      // Running again never overwrites a record that already exists.
      yield* sql`UPDATE strata_task_progress_v2 SET revision = 9 WHERE thread_id = 't1'`;
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.strictEqual(
        (yield* sql<{
          revision: number;
        }>`SELECT revision FROM strata_task_progress_v2 WHERE thread_id = 't1'`)[0]?.revision,
        9,
      );
    }),
  );
});
