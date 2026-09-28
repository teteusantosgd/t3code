import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { expandHomePath } from "../pathExpansion.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProject,
} from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import {
  authorizedRootsForProject,
  isNormalizedCwdAuthorized,
  normalizeFilesRpcCwdForComparison,
  WorkspaceAuthorizedRoots,
  WorkspaceCwdNotAuthorizedError,
  layer as WorkspaceAuthorizedRootsLayer,
} from "./WorkspaceAuthorizedRoots.ts";

describe("WorkspaceAuthorizedRoots helpers", () => {
  it("treats workspace root and repo roots as authorized members", () => {
    const workspaceRoot = "/tmp/workspace.code-workspace";
    const repoA = "/tmp/repo-a";
    const repoB = "/tmp/repo-b";
    const roots = authorizedRootsForProject({
      workspaceRoot,
      repoRoots: [repoA, repoB],
    });

    assert.deepStrictEqual(roots, [workspaceRoot, repoA, repoB]);
    assert.isTrue(isNormalizedCwdAuthorized(repoA, roots));
    assert.isTrue(isNormalizedCwdAuthorized(workspaceRoot, roots));
    assert.isFalse(isNormalizedCwdAuthorized("/tmp/other", roots));
  });

  it("dedupes identical roots after comparison normalization", () => {
    const roots = authorizedRootsForProject({
      workspaceRoot: "/tmp/repo",
      repoRoots: ["/tmp/repo", "/tmp/repo/"],
    });
    assert.deepStrictEqual(roots, ["/tmp/repo"]);
  });

  it("normalizes cwd the same way as workspace path handling", () =>
    Effect.gen(function* () {
      const path = yield* Effect.service(Path.Path);
      const normalized = normalizeFilesRpcCwdForComparison("./nested", path);
      const expected = normalizeProjectPathForComparison(
        path.resolve(expandHomePath("./nested".trim())),
      );
      assert.equal(normalized, expected);
    }).pipe(Effect.provide(Path.layer)));
});

const makeAuthorizedRootsLayer = (
  activeProjects: ReadonlyArray<ProjectionProject>,
  worktreePaths: ReadonlyArray<string> = [],
) =>
  WorkspaceAuthorizedRootsLayer.pipe(
    Layer.provide(
      Layer.mock(ProjectionProjectRepository)({
        upsert: () => Effect.die("not used"),
        getById: () => Effect.die("not used"),
        listActive: () => Effect.succeed(activeProjects),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionThreadRepository)({
        upsert: () => Effect.die("not used"),
        getById: () => Effect.die("not used"),
        listActiveWorktreePaths: () => Effect.succeed(worktreePaths),
      }),
    ),
    Layer.provideMerge(Path.layer),
  );

describe("WorkspaceAuthorizedRoots service", () => {
  it.effect("authorizes cwd that matches an active project root", () => {
    const workspaceRoot = NodePath.join(process.cwd(), "authorized-root-a");
    const repoRoot = NodePath.join(process.cwd(), "authorized-repo-b");
    const activeProject: ProjectionProject = {
      projectId: ProjectId.make("project-authorized"),
      title: "Authorized",
      workspaceRoot,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      autoPull: false,
      repoRoots: [repoRoot],
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    };

    return Effect.gen(function* () {
      const authorizedRoots = yield* WorkspaceAuthorizedRoots;
      yield* authorizedRoots.ensureFilesCwdAuthorized(workspaceRoot);
      yield* authorizedRoots.ensureFilesCwdAuthorized(repoRoot);
    }).pipe(Effect.provide(makeAuthorizedRootsLayer([activeProject])));
  });

  it.effect("rejects cwd outside active project roots", () => {
    const workspaceRoot = NodePath.join(process.cwd(), "authorized-only-root");
    return Effect.gen(function* () {
      const authorizedRoots = yield* WorkspaceAuthorizedRoots;
      const error = yield* authorizedRoots
        .ensureFilesCwdAuthorized(NodePath.join(process.cwd(), "outside-root"))
        .pipe(Effect.flip);
      assert.instanceOf(error, WorkspaceCwdNotAuthorizedError);
    }).pipe(
      Effect.provide(
        makeAuthorizedRootsLayer([
          {
            projectId: ProjectId.make("project-authorized-only"),
            title: "Authorized only",
            workspaceRoot,
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          },
        ]),
      ),
    );
  });

  it.effect("authorizes active thread worktree paths", () => {
    const workspaceRoot = NodePath.join(process.cwd(), "authorized-root-main");
    const worktreePath = NodePath.join(process.cwd(), "authorized-worktree");
    return Effect.gen(function* () {
      const authorizedRoots = yield* WorkspaceAuthorizedRoots;
      yield* authorizedRoots.ensureFilesCwdAuthorized(worktreePath);
    }).pipe(
      Effect.provide(
        makeAuthorizedRootsLayer(
          [
            {
              projectId: ProjectId.make("project-with-worktree"),
              title: "Authorized",
              workspaceRoot,
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              autoPull: false,
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            },
          ],
          [worktreePath],
        ),
      ),
    );
  });
});
