import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { CodeWorkspaceFile, CodeWorkspaceFileError, layer } from "./CodeWorkspaceFile.ts";

const TestLayer = layer.pipe(Layer.provideMerge(NodeServices.layer));

describe("CodeWorkspaceFile", () => {
  it.effect("resolves relative and absolute git folders from a .code-workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-code-workspace-" });
      const repoA = path.join(dir, "repo-a");
      const repoB = path.join(dir, "nested", "repo-b");
      yield* fileSystem.makeDirectory(path.join(repoA, ".git"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(repoB, ".git"), { recursive: true });
      const workspaceFile = path.join(dir, "app.code-workspace");
      yield* fileSystem.writeFileString(
        workspaceFile,
        JSON.stringify({
          folders: [{ path: "repo-a", name: "Alpha" }, { path: repoB }, { path: "missing-cousin" }],
        }),
      );

      const service = yield* CodeWorkspaceFile;
      const result = yield* service.read(workspaceFile);

      expect(result.anchorDir).toBe(path.dirname(result.workspaceFilePath));
      expect(
        result.folders.map((folder) => ({
          name: folder.name,
          exists: folder.exists,
          isGit: folder.isGit,
        })),
      ).toEqual([
        { name: "Alpha", exists: true, isGit: true },
        { name: "repo-b", exists: true, isGit: true },
        { name: "missing-cousin", exists: false, isGit: false },
      ]);
      expect(result.repoRoots).toHaveLength(2);
      expect(result.repoRoots[0]?.endsWith(`${path.sep}repo-a`)).toBe(true);
      expect(result.repoRoots[1]?.endsWith(`${path.sep}repo-b`)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("accepts JSONC comments in the workspace file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-code-workspace-jsonc-" });
      yield* fileSystem.makeDirectory(path.join(dir, "only", ".git"), { recursive: true });
      const workspaceFile = path.join(dir, "app.code-workspace");
      yield* fileSystem.writeFileString(
        workspaceFile,
        `{
  // comment
  "folders": [{ "path": "only" }]
}
`,
      );

      const service = yield* CodeWorkspaceFile;
      const result = yield* service.read(workspaceFile);
      expect(result.repoRoots.map((root) => path.basename(root))).toEqual(["only"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails clearly when the workspace file is missing", () =>
    Effect.gen(function* () {
      const service = yield* CodeWorkspaceFile;
      const error = yield* service
        .read("/tmp/t3-missing-workspace-file.code-workspace")
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(CodeWorkspaceFileError);
      expect(error.failure).toBe("read_failed");
    }).pipe(Effect.provide(TestLayer)),
  );
});
