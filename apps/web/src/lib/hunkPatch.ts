import type { FileDiffMetadata } from "@pierre/diffs";
import { resolveFileDiffPath } from "./diffRendering";

export interface HunkPatch {
  readonly index: number;
  readonly label: string;
  readonly patch: string;
}

/**
 * Rebuilds one git-applyable unified patch per hunk from Pierre file metadata.
 * Headers use a/ b/ prefixes so `git apply --cached` accepts the hunk alone.
 */
export function buildHunkPatchesFromFileDiff(fileDiff: FileDiffMetadata): ReadonlyArray<HunkPatch> {
  const path = resolveFileDiffPath(fileDiff).replaceAll("\\", "/");
  const previousPath = (fileDiff.prevName ?? path).replaceAll("\\", "/");
  const fileHeader = [
    `diff --git a/${previousPath} b/${path}`,
    `--- a/${previousPath}`,
    `+++ b/${path}`,
  ];

  return fileDiff.hunks.map((hunk, index) => {
    const specs =
      hunk.hunkSpecs ??
      `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@${
        hunk.hunkContext ? ` ${hunk.hunkContext}` : ""
      }`;
    const lines: string[] = [specs];
    let additionIndex = hunk.additionLineIndex;
    let deletionIndex = hunk.deletionLineIndex;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          const text =
            fileDiff.additionLines[additionIndex + offset] ??
            fileDiff.deletionLines[deletionIndex + offset] ??
            "";
          lines.push(` ${text}`);
        }
        additionIndex += content.lines;
        deletionIndex += content.lines;
        continue;
      }

      for (let offset = 0; offset < content.deletions; offset += 1) {
        lines.push(`-${fileDiff.deletionLines[deletionIndex + offset] ?? ""}`);
      }
      deletionIndex += content.deletions;
      for (let offset = 0; offset < content.additions; offset += 1) {
        lines.push(`+${fileDiff.additionLines[additionIndex + offset] ?? ""}`);
      }
      additionIndex += content.additions;
    }

    if (hunk.noEOFCRDeletions || hunk.noEOFCRAdditions) {
      lines.push("\\ No newline at end of file");
    }

    return {
      index,
      label: specs,
      patch: `${[...fileHeader, ...lines].join("\n")}\n`,
    };
  });
}

/** Whole-file patch (every hunk) for stage/unstage/discard-file shortcuts. */
export function buildFilePatchFromFileDiff(fileDiff: FileDiffMetadata): string | null {
  const hunks = buildHunkPatchesFromFileDiff(fileDiff);
  if (hunks.length === 0) return null;
  const path = resolveFileDiffPath(fileDiff).replaceAll("\\", "/");
  const previousPath = (fileDiff.prevName ?? path).replaceAll("\\", "/");
  const body = hunks
    .map((hunk) =>
      hunk.patch
        .split("\n")
        .filter(
          (line) =>
            !line.startsWith("diff --git ") && !line.startsWith("--- ") && !line.startsWith("+++ "),
        )
        .join("\n")
        .replace(/\n$/, ""),
    )
    .join("\n");
  return [
    `diff --git a/${previousPath} b/${path}`,
    `--- a/${previousPath}`,
    `+++ b/${path}`,
    body,
    "",
  ].join("\n");
}
