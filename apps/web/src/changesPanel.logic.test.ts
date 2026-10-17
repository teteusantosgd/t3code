import { describe, expect, it } from "vite-plus/test";

import {
  changesExpandedFileKey,
  changesFilePathParts,
  changesPanelIsLoading,
  displayPathForRepository,
  resolveChangesFileGroups,
} from "./changesPanel.logic";

describe("resolveChangesFileGroups", () => {
  it("uses staged and unstaged groups when present", () => {
    expect(
      resolveChangesFileGroups({
        isRepo: true,
        hasPrimaryRemote: false,
        isDefaultRef: true,
        refName: "main",
        hasWorkingTreeChanges: true,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        staged: {
          files: [{ path: "a.ts", status: "M", insertions: 1, deletions: 0 }],
          insertions: 1,
          deletions: 0,
        },
        unstaged: {
          files: [{ path: "b.ts", status: "?", insertions: 0, deletions: 0 }],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
    ).toEqual({
      staged: [{ path: "a.ts", status: "M", insertions: 1, deletions: 0 }],
      unstaged: [{ path: "b.ts", status: "?", insertions: 0, deletions: 0 }],
    });
  });

  it("falls back to working tree files when split groups are absent", () => {
    expect(
      resolveChangesFileGroups({
        isRepo: true,
        hasPrimaryRemote: false,
        isDefaultRef: true,
        refName: "main",
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [{ path: "legacy.ts", insertions: 2, deletions: 1 }],
          insertions: 2,
          deletions: 1,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }).unstaged[0]?.path,
    ).toBe("legacy.ts");
  });
});

describe("displayPathForRepository", () => {
  it("prefixes nested repository paths", () => {
    expect(displayPathForRepository("packages/app", "src/index.ts")).toBe(
      "packages/app/src/index.ts",
    );
    expect(displayPathForRepository(".", "README.md")).toBe("README.md");
  });
});

describe("changesFilePathParts", () => {
  it("keeps the file name prominent and its repository-relative directory separate", () => {
    expect(changesFilePathParts("Sanvitron.Parking.API/Controllers/AcessoController.cs")).toEqual({
      name: "AcessoController.cs",
      directory: "Sanvitron.Parking.API/Controllers",
    });
    expect(changesFilePathParts("AGENTS.md")).toEqual({ name: "AGENTS.md", directory: "" });
    expect(changesFilePathParts(".scratch/")).toEqual({ name: ".scratch", directory: "" });
  });

  it("formats Windows separators without changing the underlying file path", () => {
    expect(changesFilePathParts("src\\components\\ChangesPanel.tsx")).toEqual({
      name: "ChangesPanel.tsx",
      directory: "src/components",
    });
  });
});

describe("changesExpandedFileKey", () => {
  it("joins cwd, scope, and path", () => {
    expect(
      changesExpandedFileKey({
        cwd: "/repo",
        scope: "unstaged",
        path: "src/a.ts",
      }),
    ).toBe("/repo\0unstaged\0src/a.ts");
  });
});

describe("changesPanelIsLoading", () => {
  it("does not full-page load once configured repositories are known", () => {
    expect(
      changesPanelIsLoading({
        hasConfiguredRepositories: true,
        repositoryCardCount: 0,
        configPending: true,
        primaryStatusPending: true,
      }),
    ).toBe(false);
  });

  it("loads while a single-root status has not produced a card yet", () => {
    expect(
      changesPanelIsLoading({
        hasConfiguredRepositories: false,
        repositoryCardCount: 0,
        configPending: false,
        primaryStatusPending: true,
      }),
    ).toBe(true);
  });

  it("stops loading once a single-root card exists", () => {
    expect(
      changesPanelIsLoading({
        hasConfiguredRepositories: false,
        repositoryCardCount: 1,
        configPending: true,
        primaryStatusPending: true,
      }),
    ).toBe(false);
  });
});
