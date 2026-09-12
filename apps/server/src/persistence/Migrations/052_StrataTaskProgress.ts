import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS strata_task_progress (thread_id TEXT PRIMARY KEY, card_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS strata_task_receipts (command_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, digest TEXT NOT NULL, receipt_json TEXT NOT NULL)`;
});
