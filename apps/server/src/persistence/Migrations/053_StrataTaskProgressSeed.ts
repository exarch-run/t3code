import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Seeds the task progress projector's cursor when it has none. Events written
 * before migration 052 cannot carry task progress, so starting the projector
 * at the other projectors' position skips a replay of the whole history. On
 * one 3.4 GB store that replay took over ten minutes before the server would
 * listen. A fresh store has no cursors and seeds at zero, which is unchanged.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const existing = yield* sql<{ readonly projector: string }>`
    SELECT projector FROM projection_state WHERE projector = 'strata_task_progress'
  `;
  if (existing.length > 0) return;
  const rows = yield* sql<{ readonly seed: number | null }>`
    SELECT MIN(last_applied_sequence) AS seed
    FROM projection_state
    WHERE projector LIKE 'projection.%' AND projector <> 'projection.attachment-cleanup'
  `;
  const seed = rows[0]?.seed ?? 0;
  yield* sql`
    INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
    VALUES ('strata_task_progress', ${seed}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `;
});
