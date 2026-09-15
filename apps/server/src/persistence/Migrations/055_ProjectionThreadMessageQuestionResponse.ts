import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The owner's answers to asynchronous agent questions, kept beside the message that carries them: JSON, null for ordinary messages. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;

  if (!columns.some((column) => column.name === "question_response_json")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN question_response_json TEXT
    `;
  }
});
