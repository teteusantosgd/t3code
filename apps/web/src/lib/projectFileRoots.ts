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

export function resolveProjectFileTarget(input: {
  treePath: string;
  workspaceRoot: string;
  repoRoots?: ReadonlyArray<string> | null;
}): { cwd: string; relativePath: string } {
  const normalized = input.treePath.replace(/\\/g, "/").replace(/\/+$/, "");
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
  if (!rootCwd) {
    return { cwd: input.workspaceRoot, relativePath: normalized };
  }
  const relativePath = slash === -1 ? "" : normalized.slice(slash + 1);
  return { cwd: rootCwd, relativePath };
}
