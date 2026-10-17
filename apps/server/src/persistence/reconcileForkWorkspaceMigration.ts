import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The V1 fork used 55 for multi-root projects before upstream assigned it to V2.
 * Retire only that known ledger entry in the copied V2 database. Its extra
 * nullable columns remain harmless; project rows and the V1 source stay intact.
 */
export const reconcileForkWorkspaceMigration = Effect.fn("reconcileForkWorkspaceMigration")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table'
        `;
        if (!tables.some((table) => table.name === "effect_sql_migrations")) return;
        if (tables.some((table) => table.name.startsWith("orchestration_v2_"))) return;
        const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 55
        `;
        if (
          history.length !== 1 ||
          history[0]?.migration_id !== 55 ||
          history[0].name !== "ProjectionProjectsCodeWorkspace"
        )
          return;
        const columns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_projects)`;
        if (!columns.some((column) => column.name === "workspace_file")) return;
        if (!columns.some((column) => column.name === "repo_roots_json")) return;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 55 AND name = 'ProjectionProjectsCodeWorkspace'`;
      }),
    );
  },
);
