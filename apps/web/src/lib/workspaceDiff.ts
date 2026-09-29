import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, ReviewDiffPreviewSource } from "@t3tools/contracts";
import { createGitDiffFileContentsLoader } from "./diffFileContents";
import {
  buildFileDiffIdentityKey,
  getRenderablePatch,
  resolveFileDiffPath,
  resolveFileDiffPreviousPath,
} from "./diffRendering";

export interface WorkspaceDiffRepository {
  readonly path: string;
  readonly name: string;
  readonly cwd: string;
  readonly available: boolean;
}

export function createWorkspaceDiff<E>(
  entries: readonly { repository: WorkspaceDiffRepository; source: ReviewDiffPreviewSource }[],
  environmentId: EnvironmentId,
  getContents: Parameters<typeof createGitDiffFileContentsLoader<E>>[0],
  theme: string,
) {
  const files: FileDiffMetadata[] = [];
  const warnings: string[] = [];
  const loaders = new Map<string, { original: FileDiffMetadata; load: FileDiffContentsLoader }>();
  for (const { repository, source } of entries) {
    const scope = `${environmentId}:${repository.cwd}:${source.kind}:${source.diffHash}:${theme}`;
    const parsed = getRenderablePatch(source.diff, scope, { compactPartialHunkOffsets: true });
    if (parsed?.kind === "raw") {
      warnings.push(`${repository.name}: ${parsed.reason}`);
      continue;
    }
    const prefix = repository.path === "." || repository.path === "" ? "" : `${repository.path}/`;
    const load = createGitDiffFileContentsLoader(getContents, {
      environmentId,
      cwd: repository.cwd,
      sourceKind: source.kind,
      baseRef: source.baseRef,
      headRef: source.headRef,
      cacheKey: scope,
    });
    for (const original of parsed?.files ?? []) {
      const mapped = {
        ...original,
        workspaceRelativePaths: true as const,
        name: `${prefix}${resolveFileDiffPath(original)}`,
        ...(original.prevName
          ? { prevName: `${prefix}${resolveFileDiffPreviousPath(original)}` }
          : {}),
      };
      files.push(mapped);
      loaders.set(buildFileDiffIdentityKey(mapped), { original, load });
    }
  }
  const loadDiffFiles: FileDiffContentsLoader = async (file) => {
    const route = loaders.get(buildFileDiffIdentityKey(file));
    if (!route) throw new Error("Repository diff contents are unavailable for this file.");
    const contents = await route.load(route.original);
    return {
      ...contents,
      newFile: { ...contents.newFile, name: file.name },
      oldFile: contents.oldFile ? { ...contents.oldFile, name: file.prevName ?? file.name } : null,
    };
  };
  const rawPatch =
    warnings.length > 0
      ? {
          kind: "raw" as const,
          text: entries
            .map(({ repository, source }) => `Repository: ${repository.path}\n${source.diff}`)
            .join("\n\n"),
          reason: warnings.join("\n"),
        }
      : null;
  return { files, warnings, loadDiffFiles, rawPatch };
}

/** Adds a file-only preview when the workspace patch was truncated before that file. */
export function includeWorkspaceDiffFile(
  workspaceDiff: ReturnType<typeof createWorkspaceDiff>,
  fileDiff: ReturnType<typeof createWorkspaceDiff>,
  selectedPath: string,
) {
  if (workspaceDiff.files.some((file) => resolveFileDiffPath(file) === selectedPath)) {
    return workspaceDiff;
  }

  const selectedFile = fileDiff.files.find((file) => resolveFileDiffPath(file) === selectedPath);
  if (!selectedFile) return workspaceDiff;

  const selectedFileKey = buildFileDiffIdentityKey(selectedFile);
  return {
    ...workspaceDiff,
    files: [...workspaceDiff.files, selectedFile],
    // The selected file's bounded preview is parseable, even if another repository's
    // aggregate patch fell back to raw text.
    rawPatch: null,
    loadDiffFiles: (file: FileDiffMetadata) =>
      buildFileDiffIdentityKey(file) === selectedFileKey
        ? fileDiff.loadDiffFiles(file)
        : workspaceDiff.loadDiffFiles(file),
  };
}

export function filterWorkspaceDiffRepositories(
  repositories: readonly WorkspaceDiffRepository[],
  repositoryFilter: string | null,
): WorkspaceDiffRepository[] {
  if (repositoryFilter === null) return [...repositories];
  return repositories.filter((repository) => repository.path === repositoryFilter);
}
