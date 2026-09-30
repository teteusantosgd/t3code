import { isAbsolutePath } from "~/terminal-links";

import { buildRepoRootLabels } from "./repoRootLabels";

export interface ProjectFileRoot {
  readonly cwd: string;
  readonly label: string;
}

export function isMultiRootFileBrowsing(
  repoRoots: ReadonlyArray<string> | null | undefined,
): boolean {
  return (repoRoots?.length ?? 0) > 1;
}

/** Repo roots to browse when multi-root; otherwise a single workspace cwd. */
export function projectFileBrowserRoots(input: {
  workspaceRoot: string;
  repoRoots?: ReadonlyArray<string> | null;
}): ProjectFileRoot[] {
  if (!isMultiRootFileBrowsing(input.repoRoots)) {
    return [{ cwd: input.workspaceRoot, label: "" }];
  }
  const roots = [...new Set(input.repoRoots ?? [])];
  const labels = buildRepoRootLabels(roots);
  return roots.map((cwd) => ({ cwd, label: labels.get(cwd) ?? cwd }));
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "") || path;
}

function pathBasename(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

/**
 * Longest authorized root that contains `absolutePath` (root itself or a child).
 */
export function longestMatchingWorkspaceRoot(
  absolutePath: string,
  roots: ReadonlyArray<string>,
): { root: string; relativePath: string } | null {
  const normalizedPath = normalizePath(absolutePath);
  let best: { root: string; relativePath: string } | null = null;
  for (const root of roots) {
    const normalizedRoot = normalizePath(root);
    if (normalizedPath === normalizedRoot) {
      const candidate = { root: normalizedRoot, relativePath: "" };
      if (!best || normalizedRoot.length > best.root.length) best = candidate;
      continue;
    }
    if (!normalizedPath.startsWith(`${normalizedRoot}/`)) continue;
    const candidate = {
      root: normalizedRoot,
      relativePath: normalizedPath.slice(normalizedRoot.length + 1),
    };
    if (!best || normalizedRoot.length > best.root.length) best = candidate;
  }
  return best;
}

/**
 * Map a chat/markdown file path to the Files panel tree path and the cwd/relative
 * pair used to read it.
 *
 * Code-workspace projects keep the `.code-workspace` anchor as `workspaceRoot`
 * while agents launch in `repoRoots[0]`. Relativizing an absolute path only
 * against the agent cwd yields bare paths like `.scratch/foo.md`, which the
 * panel then reads against the anchor and misses. Always derive the open target
 * from the absolute path + every configured root.
 */
export function resolveMarkdownFileOpenPath(input: {
  filePath: string;
  workspaceRoot: string;
  repoRoots?: ReadonlyArray<string> | null;
}): { treePath: string; cwd: string; relativePath: string } | null {
  const workspaceRoot = normalizePath(input.workspaceRoot);
  if (!workspaceRoot) return null;

  const repoRoots = [...new Set((input.repoRoots ?? []).map(normalizePath).filter(Boolean))];
  const absolute = isAbsolutePath(input.filePath)
    ? normalizePath(input.filePath)
    : normalizePath(`${workspaceRoot}/${input.filePath.replace(/^\.\/+/, "")}`);

  const match = longestMatchingWorkspaceRoot(absolute, [workspaceRoot, ...repoRoots]);
  if (!match) {
    // Host file outside the project — Files panel reads absolute paths as-is.
    return { treePath: absolute, cwd: workspaceRoot, relativePath: absolute };
  }

  if (isMultiRootFileBrowsing(repoRoots)) {
    const repoMatch = longestMatchingWorkspaceRoot(absolute, repoRoots);
    if (repoMatch) {
      const labels = buildRepoRootLabels(repoRoots);
      const label = labels.get(repoMatch.root) ?? pathBasename(repoMatch.root);
      const treePath = repoMatch.relativePath ? `${label}/${repoMatch.relativePath}` : label;
      return {
        treePath,
        cwd: repoMatch.root,
        relativePath: repoMatch.relativePath,
      };
    }
  }

  // Single-root (or path only under the workspace anchor): keep a path relative
  // to the workspace root so the tree stays anchored there.
  const workspaceRelative =
    longestMatchingWorkspaceRoot(absolute, [workspaceRoot])?.relativePath ?? match.relativePath;
  return {
    treePath: workspaceRelative,
    cwd: workspaceRoot,
    relativePath: workspaceRelative,
  };
}

export function resolveProjectFileTarget(input: {
  treePath: string;
  workspaceRoot: string;
  repoRoots?: ReadonlyArray<string> | null;
}): { cwd: string; relativePath: string } {
  const normalized = normalizePath(input.treePath);

  if (isAbsolutePath(normalized)) {
    const resolved = resolveMarkdownFileOpenPath({
      filePath: normalized,
      workspaceRoot: input.workspaceRoot,
      repoRoots: input.repoRoots,
    });
    return resolved
      ? { cwd: resolved.cwd, relativePath: resolved.relativePath }
      : { cwd: input.workspaceRoot, relativePath: normalized };
  }

  if (!isMultiRootFileBrowsing(input.repoRoots)) {
    return { cwd: input.workspaceRoot, relativePath: normalized };
  }

  const roots = projectFileBrowserRoots({
    workspaceRoot: input.workspaceRoot,
    repoRoots: input.repoRoots,
  });
  const labelToRoot = new Map(roots.map((root) => [root.label, root.cwd] as const));
  const slash = normalized.indexOf("/");
  const firstSegment = slash === -1 ? normalized : normalized.slice(0, slash);
  const rootCwd = labelToRoot.get(firstSegment);
  if (rootCwd) {
    const relativePath = slash === -1 ? "" : normalized.slice(slash + 1);
    return { cwd: rootCwd, relativePath };
  }

  // Tree path may be workspace-relative including a repo folder name. Rebuild the
  // absolute path under the workspace anchor and re-derive the owning repo.
  const viaWorkspace = resolveMarkdownFileOpenPath({
    filePath: `${normalizePath(input.workspaceRoot)}/${normalized}`,
    workspaceRoot: input.workspaceRoot,
    repoRoots: input.repoRoots,
  });
  if (viaWorkspace && viaWorkspace.cwd !== normalizePath(input.workspaceRoot)) {
    return { cwd: viaWorkspace.cwd, relativePath: viaWorkspace.relativePath };
  }

  return { cwd: input.workspaceRoot, relativePath: normalized };
}
