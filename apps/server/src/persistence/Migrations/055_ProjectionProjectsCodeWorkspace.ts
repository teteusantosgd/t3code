import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "workspace_file")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN workspace_file TEXT
    `;
  }

  if (!columns.some((column) => column.name === "repo_roots_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN repo_roots_json TEXT
    `;
  }
});
