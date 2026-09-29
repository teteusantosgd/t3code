import { describe, expect, it } from "vite-plus/test";
import type { FileDiffMetadata } from "@pierre/diffs";

import { buildFilePatchFromFileDiff, buildHunkPatchesFromFileDiff } from "./hunkPatch";

function sampleFileDiff(): FileDiffMetadata {
  return {
    name: "src/a.ts",
    type: "change",
    isPartial: true,
    splitLineCount: 0,
    unifiedLineCount: 0,
    deletionLines: ["one", "two", "three"],
    additionLines: ["one", "TWO", "three"],
    hunks: [
      {
        additionStart: 1,
        additionCount: 3,
        additionLines: 1,
        additionLineIndex: 0,
        deletionStart: 1,
        deletionCount: 3,
        deletionLines: 1,
        deletionLineIndex: 0,
        hunkContent: [
          { type: "context", lines: 1, additionLineIndex: 0, deletionLineIndex: 0 },
          {
            type: "change",
            deletions: 1,
            deletionLineIndex: 1,
            additions: 1,
            additionLineIndex: 1,
          },
          { type: "context", lines: 1, additionLineIndex: 2, deletionLineIndex: 2 },
        ],
        hunkSpecs: "@@ -1,3 +1,3 @@",
        splitLineStart: 0,
        splitLineCount: 3,
        unifiedLineStart: 0,
        unifiedLineCount: 3,
        noEOFCRDeletions: false,
        noEOFCRAdditions: false,
      },
    ],
  } as FileDiffMetadata;
}

describe("buildHunkPatchesFromFileDiff", () => {
  it("emits a git-applyable patch with file headers", () => {
    const [hunk] = buildHunkPatchesFromFileDiff(sampleFileDiff());
    expect(hunk?.patch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(hunk?.patch).toContain("@@ -1,3 +1,3 @@");
    expect(hunk?.patch).toContain("-two");
    expect(hunk?.patch).toContain("+TWO");
  });
});

describe("buildFilePatchFromFileDiff", () => {
  it("joins every hunk under one file header", () => {
    const patch = buildFilePatchFromFileDiff(sampleFileDiff());
    expect(patch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(patch?.match(/diff --git /g)?.length).toBe(1);
    expect(patch).toContain("+TWO");
  });
});
