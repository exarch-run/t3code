import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Strata's session files per project: a JSON array of relative paths, null when the project has none. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "session_files_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN session_files_json TEXT
    `;
  }
});
