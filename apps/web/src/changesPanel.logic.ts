import type { GitStatus } from "@pierre/trees";
import type { VcsChangedFile, VcsFileChangeStatus, VcsStatusResult } from "@t3tools/contracts";

export interface ChangesFileGroups {
  readonly staged: ReadonlyArray<VcsChangedFile>;
  readonly unstaged: ReadonlyArray<VcsChangedFile>;
}

/** Split index vs worktree files, falling back to legacy combined status. */
export function resolveChangesFileGroups(status: VcsStatusResult): ChangesFileGroups {
  if (status.staged !== undefined || status.unstaged !== undefined) {
    return {
      staged: status.staged?.files ?? [],
      unstaged: status.unstaged?.files ?? [],
    };
  }
  return {
    staged: [],
    unstaged: status.workingTree.files.map((file) => ({
      path: file.path,
      status: "M" as const,
      insertions: file.insertions,
      deletions: file.deletions,
    })),
  };
}

export function displayPathForRepository(repositoryPath: string, filePath: string): string {
  const prefix =
    repositoryPath === "" || repositoryPath === "." ? "" : `${repositoryPath.replace(/\/+$/, "")}/`;
  return prefix ? `${prefix}${filePath}` : filePath;
}

export function changesFilePathParts(filePath: string): { name: string; directory: string } {
  const normalized = filePath.replaceAll("\\", "/").replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  return {
    name: normalized.slice(lastSlash + 1),
    directory: lastSlash < 0 ? "" : normalized.slice(0, lastSlash),
  };
}

/** Stable key for the one open inline diff in Changes. */
export function changesExpandedFileKey(input: {
  readonly cwd: string;
  readonly scope: "staged" | "unstaged";
  readonly path: string;
}): string {
  return `${input.cwd}\0${input.scope}\0${input.path}`;
}

export function repositoryScopedFilePath(repositoryPath: string, displayPath: string): string {
  const normalizedRepositoryPath = repositoryPath.replaceAll("\\", "/");
  const normalizedDisplayPath = displayPath.replaceAll("\\", "/");
  const prefix =
    normalizedRepositoryPath === "" || normalizedRepositoryPath === "."
      ? ""
      : `${normalizedRepositoryPath.replace(/\/+$/, "")}/`;
  if (!prefix) return normalizedDisplayPath;
  return normalizedDisplayPath.startsWith(prefix)
    ? normalizedDisplayPath.slice(prefix.length)
    : normalizedDisplayPath;
}

export function vcsFileStatusToTreeStatus(status: VcsFileChangeStatus): GitStatus {
  switch (status) {
    case "A":
    case "?":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "M":
    case "U":
      return "modified";
  }
}

/**
 * Full-page spinner only while we still do not know which repositories exist.
 * Once the configured list (or the single project cwd) is known, each card shows
 * its own pending state — waiting on every VCS status would hang multi-root
 * workspaces whenever one checkout is slow or not a git repo.
 */
export function changesPanelIsLoading(input: {
  readonly hasConfiguredRepositories: boolean;
  readonly repositoryCardCount: number;
  readonly configPending: boolean;
  readonly primaryStatusPending: boolean;
}): boolean {
  if (input.hasConfiguredRepositories) return false;
  return input.repositoryCardCount === 0 && (input.configPending || input.primaryStatusPending);
}
