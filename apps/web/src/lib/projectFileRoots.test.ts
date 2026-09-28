import { describe, expect, it } from "vite-plus/test";

import { projectFileBrowserRoots, resolveProjectFileTarget } from "./projectFileRoots";

describe("projectFileRoots", () => {
  it("keeps single-root browsing on the workspace cwd", () => {
    expect(
      projectFileBrowserRoots({
        workspaceRoot: "/work/workspace",
        repoRoots: ["/work/repo-a"],
      }),
    ).toEqual([{ cwd: "/work/workspace", label: "" }]);
  });

  it("resolves tree paths to the owning repo cwd", () => {
    expect(
      resolveProjectFileTarget({
        workspaceRoot: "/work/workspace",
        repoRoots: ["/work/repo-a", "/work/repo-b"],
        treePath: "repo-a/src/index.ts",
      }),
    ).toEqual({ cwd: "/work/repo-a", relativePath: "src/index.ts" });
  });
});
