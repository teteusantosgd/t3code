import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { filterWorkspaceDiffRepositories, includeWorkspaceDiffFile } from "./workspaceDiff";

describe("filterWorkspaceDiffRepositories", () => {
  const repositories = [
    { path: "HSpotWeb", name: "HSpotWeb", cwd: "/p/HSpotWeb", available: true },
    { path: "Radius", name: "Radius", cwd: "/p/Radius", available: true },
  ];

  it("keeps every repository for All repos", () => {
    expect(filterWorkspaceDiffRepositories(repositories, null)).toEqual(repositories);
  });

  it("keeps only the selected repository", () => {
    expect(filterWorkspaceDiffRepositories(repositories, "Radius")).toEqual([repositories[1]]);
  });
});

describe("includeWorkspaceDiffFile", () => {
  const file = (name: string): FileDiffMetadata =>
    ({
      type: "change",
      name,
      prevName: name,
      hunks: [],
    }) as FileDiffMetadata;

  it("appends a file-only preview when the aggregate truncated it away", () => {
    const workspaceDiff = {
      files: [file("repo-a/a.ts")],
      warnings: [],
      rawPatch: { kind: "raw" as const, text: "truncated", reason: "too large" },
      loadDiffFiles: async () => {
        throw new Error("aggregate loader");
      },
    };
    const selected = file("repo-b/b.ts");
    const fileDiff = {
      files: [selected],
      warnings: [],
      rawPatch: null,
      loadDiffFiles: async () => ({
        newFile: { name: selected.name, contents: "b" },
        oldFile: { name: selected.name, contents: "a" },
      }),
    };

    const merged = includeWorkspaceDiffFile(workspaceDiff, fileDiff, "repo-b/b.ts");
    expect(merged.files.map((entry) => entry.name)).toEqual(["repo-a/a.ts", "repo-b/b.ts"]);
    expect(merged.rawPatch).toBeNull();
  });

  it("leaves the aggregate alone when the selected file is already present", () => {
    const existing = file("repo-a/a.ts");
    const workspaceDiff = {
      files: [existing],
      warnings: [],
      rawPatch: null,
      loadDiffFiles: async () => {
        throw new Error("unused");
      },
    };
    const fileDiff = {
      files: [file("repo-a/a.ts")],
      warnings: [],
      rawPatch: null,
      loadDiffFiles: async () => {
        throw new Error("unused");
      },
    };

    expect(includeWorkspaceDiffFile(workspaceDiff, fileDiff, "repo-a/a.ts")).toBe(workspaceDiff);
  });
});
