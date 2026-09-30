import { describe, expect, it } from "vite-plus/test";

import {
  longestMatchingWorkspaceRoot,
  projectFileBrowserRoots,
  resolveMarkdownFileOpenPath,
  resolveProjectFileTarget,
} from "./projectFileRoots";

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

  it("resolves absolute paths under a nested repo for code-workspace projects", () => {
    expect(
      resolveProjectFileTarget({
        workspaceRoot: "/Users/dev/Projects/Sanvitron",
        repoRoots: [
          "/Users/dev/Projects/Sanvitron/Sanvitron.Parking.Retro",
          "/Users/dev/Projects/Sanvitron/wssanvipark",
        ],
        treePath: "/Users/dev/Projects/Sanvitron/Sanvitron.Parking.Retro/.scratch/issues/01.md",
      }),
    ).toEqual({
      cwd: "/Users/dev/Projects/Sanvitron/Sanvitron.Parking.Retro",
      relativePath: ".scratch/issues/01.md",
    });
  });

  it("re-derives a nested repo read target from a workspace-relative tree path", () => {
    expect(
      resolveProjectFileTarget({
        workspaceRoot: "/Users/dev/Projects/Sanvitron",
        repoRoots: [
          "/Users/dev/Projects/Sanvitron/Sanvitron.Parking.Retro",
          "/Users/dev/Projects/Sanvitron/wssanvipark",
        ],
        treePath: "Sanvitron.Parking.Retro/.scratch/issues/01.md",
      }),
    ).toEqual({
      cwd: "/Users/dev/Projects/Sanvitron/Sanvitron.Parking.Retro",
      relativePath: ".scratch/issues/01.md",
    });
  });
});

describe("longestMatchingWorkspaceRoot", () => {
  it("prefers the deepest matching root", () => {
    expect(
      longestMatchingWorkspaceRoot("/work/workspace/repo-a/src/main.ts", [
        "/work/workspace",
        "/work/workspace/repo-a",
        "/work/workspace/repo-b",
      ]),
    ).toEqual({ root: "/work/workspace/repo-a", relativePath: "src/main.ts" });
  });
});

describe("resolveMarkdownFileOpenPath", () => {
  const workspaceRoot = "/Users/dev/Projects/Sanvitron";
  const repoRoots = [
    "/Users/dev/Projects/Sanvitron/Sanvitron.Parking.Retro",
    "/Users/dev/Projects/Sanvitron/wssanvipark",
    "/Users/dev/Projects/Sanvitron/websanviticket",
    "/Users/dev/Projects/Sanvitron/totembeagle",
  ];

  it("builds a labeled multi-root tree path from an absolute file under a nested repo", () => {
    expect(
      resolveMarkdownFileOpenPath({
        filePath:
          "/Users/dev/Projects/Sanvitron/Sanvitron.Parking.Retro/.scratch/simplificacao-garagem-admin/issues/01-simplificacao-da-garagem-local.md",
        workspaceRoot,
        repoRoots,
      }),
    ).toEqual({
      treePath:
        "Sanvitron.Parking.Retro/.scratch/simplificacao-garagem-admin/issues/01-simplificacao-da-garagem-local.md",
      cwd: "/Users/dev/Projects/Sanvitron/Sanvitron.Parking.Retro",
      relativePath:
        ".scratch/simplificacao-garagem-admin/issues/01-simplificacao-da-garagem-local.md",
    });
  });

  it("keeps untracked gitignored paths openable when they sit under a repo root", () => {
    const opened = resolveMarkdownFileOpenPath({
      filePath: "/Users/dev/Projects/Sanvitron/Sanvitron.Parking.Retro/.scratch/notes.md",
      workspaceRoot,
      repoRoots,
    });
    expect(opened?.relativePath).toBe(".scratch/notes.md");
    expect(opened?.cwd).toBe(repoRoots[0]);
  });

  it("opens host files outside every project root by absolute path", () => {
    expect(
      resolveMarkdownFileOpenPath({
        filePath: "/tmp/outside-report.md",
        workspaceRoot,
        repoRoots,
      }),
    ).toEqual({
      treePath: "/tmp/outside-report.md",
      cwd: workspaceRoot,
      relativePath: "/tmp/outside-report.md",
    });
  });

  it("keeps single-root paths relative to the workspace anchor", () => {
    expect(
      resolveMarkdownFileOpenPath({
        filePath: "/work/repo/src/main.ts",
        workspaceRoot: "/work/repo",
        repoRoots: ["/work/repo"],
      }),
    ).toEqual({
      treePath: "src/main.ts",
      cwd: "/work/repo",
      relativePath: "src/main.ts",
    });
  });
});
