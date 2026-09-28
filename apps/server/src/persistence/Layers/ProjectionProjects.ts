import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { ModelSelection, ProjectIconOverride, ProjectScript } from "@t3tools/contracts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionProjectInput,
  ProjectionProject,
  ProjectionProjectRepository,
  type ProjectionProjectRepositoryShape,
} from "../Services/ProjectionProjects.ts";

const ProjectionProjectDbRow = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    autoPull: Schema.Number,
    projectIcon: Schema.NullOr(Schema.fromJsonString(ProjectIconOverride)),
    repoRoots: Schema.NullOr(Schema.fromJsonString(Schema.Array(Schema.String))),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);

const makeProjectionProjectRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionProjectRow = SqlSchema.void({
    Request: ProjectionProject,
    execute: (row) =>
      sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          default_thread_env_mode,
          auto_pull,
          favicon_path,
          project_icon_json,
          workspace_file,
          repo_roots_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.projectId},
          ${row.title},
          ${row.workspaceRoot},
          ${row.defaultModelSelection !== null ? JSON.stringify(row.defaultModelSelection) : null},
          ${row.defaultThreadEnvMode},
          ${row.autoPull ? 1 : 0},
          ${row.faviconPath ?? null},
          ${row.projectIcon ? JSON.stringify(row.projectIcon) : null},
          ${row.workspaceFile ?? null},
          ${row.repoRoots && row.repoRoots.length > 0 ? JSON.stringify(row.repoRoots) : null},
          ${JSON.stringify(row.scripts)},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (project_id)
        DO UPDATE SET
          title = excluded.title,
          workspace_root = excluded.workspace_root,
          default_model_selection_json = excluded.default_model_selection_json,
          default_thread_env_mode = excluded.default_thread_env_mode,
          auto_pull = excluded.auto_pull,
          favicon_path = excluded.favicon_path,
          project_icon_json = excluded.project_icon_json,
          workspace_file = excluded.workspace_file,
          repo_roots_json = excluded.repo_roots_json,
          scripts_json = excluded.scripts_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionProjectRow = SqlSchema.findOneOption({
    Request: GetProjectionProjectInput,
    Result: ProjectionProjectDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          default_thread_env_mode AS "defaultThreadEnvMode",
          auto_pull AS "autoPull",
          favicon_path AS "faviconPath",
          project_icon_json AS "projectIcon",
          workspace_file AS "workspaceFile",
          repo_roots_json AS "repoRoots",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
      `,
  });

  const listActiveProjectionProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRow,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          default_thread_env_mode AS "defaultThreadEnvMode",
          auto_pull AS "autoPull",
          favicon_path AS "faviconPath",
          project_icon_json AS "projectIcon",
          workspace_file AS "workspaceFile",
          repo_roots_json AS "repoRoots",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE deleted_at IS NULL
      `,
  });

  const mapProjectionProjectRow = (
    row: Schema.Schema.Type<typeof ProjectionProjectDbRow>,
  ): ProjectionProject => ({
    ...row,
    autoPull: row.autoPull === 1,
    workspaceFile: row.workspaceFile ?? null,
    repoRoots: row.repoRoots ?? [],
  });

  const upsert: ProjectionProjectRepositoryShape["upsert"] = (row) =>
    upsertProjectionProjectRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.upsert:query")),
    );

  const getById: ProjectionProjectRepositoryShape["getById"] = (input) =>
    getProjectionProjectRow(input).pipe(
      Effect.map(Option.map(mapProjectionProjectRow)),
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.getById:query")),
    );

  const listActive: ProjectionProjectRepositoryShape["listActive"] = () =>
    listActiveProjectionProjectRows(undefined).pipe(
      Effect.map((rows) => rows.map(mapProjectionProjectRow)),
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.listActive:query")),
    );

  return {
    upsert,
    getById,
    listActive,
  } satisfies ProjectionProjectRepositoryShape;
});

export const ProjectionProjectRepositoryLive = Layer.effect(
  ProjectionProjectRepository,
  makeProjectionProjectRepository,
);
