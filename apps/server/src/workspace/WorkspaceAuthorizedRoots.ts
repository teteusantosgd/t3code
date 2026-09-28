/**
 * WorkspaceAuthorizedRoots - membership checks for Files RPC workspace roots.
 *
 * A Files RPC cwd must match an active project's workspace root or one of its
 * code-workspace repo roots after path normalization.
 *
 * @module WorkspaceAuthorizedRoots
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import { expandHomePathWith } from "../pathExpansion.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";

export class WorkspaceCwdNotAuthorizedError extends Schema.TaggedError<WorkspaceCwdNotAuthorizedError>()(
  "WorkspaceCwdNotAuthorizedError",
  {
    cwd: Schema.String,
    normalizedCwd: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace cwd is not authorized for file operations: ${this.normalizedCwd}`;
  }
}

export class WorkspaceAuthorizedRootsLoadError extends Schema.TaggedError<WorkspaceAuthorizedRootsLoadError>()(
  "WorkspaceAuthorizedRootsLoadError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load authorized workspace roots while checking '${this.cwd}'.`;
  }
}

/** Collect workspace + repo roots authorized for one project. */
export function authorizedRootsForProject(input: {
  readonly workspaceRoot: string;
  readonly repoRoots: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const seen = new Set<string>();
  const roots: Array<string> = [];
  for (const root of [input.workspaceRoot, ...input.repoRoots]) {
    const normalized = normalizeProjectPathForComparison(root);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    roots.push(root);
  }
  return roots;
}

/** True when `normalizedCwd` matches any authorized root after comparison normalization. */
export function isNormalizedCwdAuthorized(
  normalizedCwd: string,
  authorizedRoots: ReadonlyArray<string>,
): boolean {
  const normalizedRequest = normalizeProjectPathForComparison(normalizedCwd);
  return authorizedRoots.some(
    (root) => normalizeProjectPathForComparison(root) === normalizedRequest,
  );
}

export function normalizeFilesRpcCwdForComparison(cwd: string, path: Path.Path): string {
  return normalizeProjectPathForComparison(path.resolve(expandHomePathWith(cwd.trim(), path)));
}

export class WorkspaceAuthorizedRoots extends Context.Service<
  WorkspaceAuthorizedRoots,
  {
    readonly ensureFilesCwdAuthorized: (
      cwd: string,
    ) => Effect.Effect<void, WorkspaceCwdNotAuthorizedError | WorkspaceAuthorizedRootsLoadError>;
  }
>()("t3/workspace/WorkspaceAuthorizedRoots") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const projectionProjects = yield* ProjectionProjectRepository;
  const projectionThreads = yield* ProjectionThreadRepository;

  const ensureFilesCwdAuthorized: WorkspaceAuthorizedRoots["Service"]["ensureFilesCwdAuthorized"] =
    Effect.fn("WorkspaceAuthorizedRoots.ensureFilesCwdAuthorized")(function* (cwd) {
      const normalizedCwd = normalizeFilesRpcCwdForComparison(cwd, path);
      const activeProjects = yield* projectionProjects.listActive().pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceAuthorizedRootsLoadError({
              cwd,
              cause,
            }),
        ),
      );
      const worktreePaths = yield* projectionThreads.listActiveWorktreePaths().pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceAuthorizedRootsLoadError({
              cwd,
              cause,
            }),
        ),
      );
      const authorizedRoots = [
        ...activeProjects.flatMap((project) =>
          authorizedRootsForProject({
            workspaceRoot: project.workspaceRoot,
            repoRoots: project.repoRoots ?? [],
          }),
        ),
        ...worktreePaths,
      ];
      if (!isNormalizedCwdAuthorized(normalizedCwd, authorizedRoots)) {
        return yield* new WorkspaceCwdNotAuthorizedError({ cwd, normalizedCwd });
      }
    });

  return WorkspaceAuthorizedRoots.of({ ensureFilesCwdAuthorized });
});

export const layer = Layer.effect(WorkspaceAuthorizedRoots, make);
