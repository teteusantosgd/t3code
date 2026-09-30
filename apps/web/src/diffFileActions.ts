import type { ScopedThreadRef } from "@t3tools/contracts";
import { isWindowsAbsolutePath, normalizeProjectPathForComparison } from "@t3tools/shared/path";

import { useRightPanelStore } from "./rightPanelStore";
import { resolvePathLinkTarget } from "./terminal-links";

interface OpenDiffFilePrimaryActionInput {
  readonly threadRef: ScopedThreadRef | null;
  readonly filePath: string;
  readonly activeCwd: string | undefined;
  readonly repositoryRoot?: string | undefined;
  readonly openInEditor: (targetPath: string) => void;
}

function normalizedRelativePathSegments(filePath: string): ReadonlyArray<string> | null {
  if (filePath.startsWith("/") || isWindowsAbsolutePath(filePath) || /^[a-zA-Z]:/.test(filePath)) {
    return null;
  }

  const segments = filePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  return segments;
}

function repositoryRelativeWorkspaceSegments(
  workspaceRoot: string | undefined,
  repositoryRoot: string | undefined,
): ReadonlyArray<string> | null {
  if (!workspaceRoot || !repositoryRoot) return null;

  const normalizedWorkspaceRoot = normalizeProjectPathForComparison(workspaceRoot);
  const normalizedRepositoryRoot = normalizeProjectPathForComparison(repositoryRoot);
  if (normalizedWorkspaceRoot === normalizedRepositoryRoot) return [];

  const separator = normalizedRepositoryRoot.includes("\\") ? "\\" : "/";
  const repositoryPrefix = normalizedRepositoryRoot.endsWith(separator)
    ? normalizedRepositoryRoot
    : `${normalizedRepositoryRoot}${separator}`;
  if (!normalizedWorkspaceRoot.startsWith(repositoryPrefix)) return null;

  return normalizedWorkspaceRoot
    .slice(repositoryPrefix.length)
    .split(/[\\/]+/)
    .filter(Boolean);
}

/** When the git repo sits under the project folder, return that offset's segments. */
function workspaceRelativeRepositorySegments(
  workspaceRoot: string | undefined,
  repositoryRoot: string | undefined,
): ReadonlyArray<string> | null {
  if (!workspaceRoot || !repositoryRoot) return null;

  const normalizedWorkspaceRoot = normalizeProjectPathForComparison(workspaceRoot);
  const normalizedRepositoryRoot = normalizeProjectPathForComparison(repositoryRoot);
  if (normalizedWorkspaceRoot === normalizedRepositoryRoot) return [];

  const separator = normalizedWorkspaceRoot.includes("\\") ? "\\" : "/";
  const workspacePrefix = normalizedWorkspaceRoot.endsWith(separator)
    ? normalizedWorkspaceRoot
    : `${normalizedWorkspaceRoot}${separator}`;
  if (!normalizedRepositoryRoot.startsWith(workspacePrefix)) return null;

  // Comparison paths may be lowercased on Windows; keep the repository's casing.
  const displayRepository = repositoryRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const displayWorkspace = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const displayRelative =
    displayRepository.length > displayWorkspace.length + 1 &&
    displayRepository.slice(0, displayWorkspace.length).toLowerCase() ===
      displayWorkspace.toLowerCase() &&
    displayRepository[displayWorkspace.length] === "/"
      ? displayRepository.slice(displayWorkspace.length + 1)
      : normalizedRepositoryRoot.slice(workspacePrefix.length).replaceAll("\\", "/");

  return displayRelative.split("/").filter(Boolean);
}

function segmentsMatchPrefix(
  fileSegments: ReadonlyArray<string>,
  prefixSegments: ReadonlyArray<string>,
  caseInsensitive: boolean,
): boolean {
  return prefixSegments.every((segment, index) => {
    const candidate = fileSegments[index];
    if (candidate === undefined) return false;
    return caseInsensitive
      ? candidate.toLowerCase() === segment.toLowerCase()
      : candidate === segment;
  });
}

function absolutePathUnderWorkspace(
  filePath: string,
  workspaceRoot: string | undefined,
): string | null {
  if (!workspaceRoot) return null;
  if (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath)) return null;

  const normalizedWorkspace = normalizeProjectPathForComparison(workspaceRoot);
  const normalizedFile = normalizeProjectPathForComparison(filePath);
  if (normalizedFile === normalizedWorkspace) return null;

  const separator = normalizedWorkspace.includes("\\") ? "\\" : "/";
  if (!normalizedFile.startsWith(`${normalizedWorkspace}${separator}`)) return null;

  const relative = normalizedFile.slice(normalizedWorkspace.length).replace(/^[\\/]+/, "");
  return relative.length > 0 ? relative.replaceAll("\\", "/") : null;
}

export function resolveDiffPathForWorkspace(input: {
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot: string | undefined;
}): string | null {
  const absoluteUnderWorkspace = absolutePathUnderWorkspace(input.filePath, input.workspaceRoot);
  if (absoluteUnderWorkspace) return absoluteUnderWorkspace;

  const fileSegments = normalizedRelativePathSegments(input.filePath);
  if (!fileSegments) return null;

  const workspaceSegments = repositoryRelativeWorkspaceSegments(
    input.workspaceRoot,
    input.repositoryRoot,
  );
  const caseInsensitive = input.repositoryRoot
    ? isWindowsAbsolutePath(input.repositoryRoot)
    : false;

  // Project folder inside a larger git repo: strip the workspace prefix from the
  // repository-relative diff path (#6166 / #9842).
  if (workspaceSegments && workspaceSegments.length > 0) {
    if (!segmentsMatchPrefix(fileSegments, workspaceSegments, caseInsensitive)) return null;
    const relativeSegments = fileSegments.slice(workspaceSegments.length);
    return relativeSegments.length > 0 ? relativeSegments.join("/") : null;
  }

  // Git repo nested under a non-git (or multi-root) project folder: prefix the
  // full workspace offset, including intermediate directories (#12902).
  const repositorySegments = workspaceRelativeRepositorySegments(
    input.workspaceRoot,
    input.repositoryRoot,
  );
  if (repositorySegments && repositorySegments.length > 0) {
    if (segmentsMatchPrefix(fileSegments, repositorySegments, caseInsensitive)) {
      return fileSegments.join("/");
    }
    return [...repositorySegments, ...fileSegments].join("/");
  }

  return fileSegments.join("/");
}

export function openDiffFilePrimaryAction({
  threadRef,
  filePath,
  activeCwd,
  repositoryRoot,
  openInEditor,
}: OpenDiffFilePrimaryActionInput): void {
  const workspaceFilePath = resolveDiffPathForWorkspace({
    filePath,
    workspaceRoot: activeCwd,
    repositoryRoot,
  });
  if (!workspaceFilePath) return;

  if (threadRef) {
    useRightPanelStore.getState().openFile(threadRef, workspaceFilePath);
    return;
  }

  openInEditor(activeCwd ? resolvePathLinkTarget(workspaceFilePath, activeCwd) : workspaceFilePath);
}
