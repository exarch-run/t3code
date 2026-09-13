import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const StoredCard = Schema.Struct({
  revision: Schema.Number,
  generation: Schema.String,
  markdown: Schema.optionalKey(Schema.NullOr(Schema.String)),
  plan: Schema.optionalKey(
    Schema.Array(Schema.Struct({ text: Schema.String, status: Schema.String })),
  ),
  runId: Schema.optionalKey(Schema.String),
  updatedAt: Schema.optionalKey(Schema.String),
});
const decodeStored = Schema.decodeUnknownResult(Schema.fromJsonString(StoredCard));
const encodeSteps = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ step: Schema.String, status: Schema.String })),
  ),
);

/**
 * The canonical task card record: one row per thread with the card's
 * content, revision, generation and update time, and the turn the last write
 * landed in for the version 1 projection. Cards saved by 052's table move
 * over as they are, including content the new write limits would refuse; the
 * limits apply to new writes, not to what a chat already had.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS strata_task_progress_v2 (
    thread_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    generation TEXT NOT NULL,
    markdown TEXT,
    steps_json TEXT,
    turn_id TEXT,
    updated_at TEXT
  )`;
  const rows = yield* sql<{
    readonly thread_id: string;
    readonly card_json: string;
  }>`SELECT thread_id, card_json FROM strata_task_progress`;
  for (const row of rows) {
    const decoded = decodeStored(row.card_json);
    if (Result.isFailure(decoded)) continue;
    const card = decoded.success;
    const steps = (card.plan ?? []).map((step) => ({ step: step.text, status: step.status }));
    yield* sql`INSERT INTO strata_task_progress_v2 (thread_id, revision, generation, markdown, steps_json, turn_id, updated_at)
      VALUES (${row.thread_id}, ${card.revision}, ${card.generation}, ${card.markdown ? card.markdown : null}, ${steps.length > 0 ? encodeSteps(steps) : null}, ${card.runId ?? null}, ${card.updatedAt ?? null})
      ON CONFLICT(thread_id) DO NOTHING`;
  }
});
