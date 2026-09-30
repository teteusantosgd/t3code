import type { FileDiffMetadata } from "@pierre/diffs";
import { EnvironmentId, type ReviewDiffPreviewSourceKind } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  createWorkspaceDiff,
  filterWorkspaceDiffRepositories,
  includeWorkspaceDiffFile,
} from "./workspaceDiff";

describe("createWorkspaceDiff", () => {
  for (const kind of [
    "working-tree",
    "staged",
    "unstaged",
    "branch-range",
  ] satisfies ReviewDiffPreviewSourceKind[]) {
    it(`aggregates ${kind} files with the same name and keeps expansion in the correct repository`, async () => {
      const entries = ["repo-a", "repo-b"].map((name) => ({
        repository: { path: name, name, cwd: `/workspace/${name}`, available: true },
        source: {
          id: kind,
          kind,
          title: kind,
          baseRef: "HEAD",
          headRef: null,
          diff: `diff --git a/shared.txt b/shared.txt\nindex 7898192..6178079 100644\n--- a/shared.txt\n+++ b/shared.txt\n@@ -1 +1 @@\n-before\n+after ${name}\n`,
          diffHash: `${name}-${kind}`,
          truncated: false,
        },
      }));
      const calls: Array<{
        cwd: string;
        sourceKind: ReviewDiffPreviewSourceKind;
        oldPath: string;
        newPath: string;
      }> = [];
      const diff = createWorkspaceDiff(
        entries,
        EnvironmentId.make("test"),
        async ({ input }) => {
          calls.push(input);
          return AsyncResult.success({
            oldContents: "before\n",
            newContents: `after ${input.cwd}\n`,
          });
        },
        "dark",
      );
      expect(diff.files.map((file) => file.name)).toEqual([
        "repo-a/shared.txt",
        "repo-b/shared.txt",
      ]);
      expect(diff.warnings).toEqual([]);
      for (const file of diff.files) {
        const contents = await diff.loadDiffFiles(file);
        expect(contents.newFile.name).toEqual(file.name);
      }
      expect(calls).toEqual(
        entries.map(({ repository }) =>
          expect.objectContaining({
            cwd: repository.cwd,
            sourceKind: kind,
            oldPath: "shared.txt",
            newPath: "shared.txt",
          }),
        ),
      );
    });
  }
});

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
