import type { T3ProjectFile } from "@t3tools/contracts";

export interface ConfiguredDiffRepository {
  readonly path: string;
  readonly name: string;
  readonly cwd: string;
}

/** Join a workspace root with a relative repository path (`.` or `../sibling` allowed). */
export function resolveConfiguredRepositoryCwd(
  workspaceRoot: string,
  relativePath: string,
): string | null {
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  if (!root) return null;
  const normalized = relativePath.trim().replace(/\\/g, "/");
  if (!normalized || normalized === ".") return root;
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some((segment) => segment === "")
  ) {
    return null;
  }

  const stack = root.split("/");
  for (const segment of normalized.split("/")) {
    if (segment === ".") continue;
    if (segment === "..") {
      // Keep the leading empty segment on POSIX roots (`""` from `/Users/...`).
      if (stack.length <= 1) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  if (stack.length <= 1 && stack[0] === "") return null;
  return stack.join("/");
}

/**
 * Expand `t3.json` repository path patterns into concrete relative paths.
 * `dir/*` expands using the provided immediate child directory names.
 */
export function expandConfiguredRepositoryPaths(
  paths: ReadonlyArray<string>,
  listChildren: (directoryRelativePath: string) => ReadonlyArray<string>,
): string[] {
  const expanded = new Set<string>();
  for (const raw of paths) {
    const pattern = raw.trim().replace(/\\/g, "/");
    if (!pattern) continue;
    if (pattern.endsWith("/*")) {
      const directory = pattern.slice(0, -2);
      if (directory.includes("*") || directory.includes("?") || directory.includes("[")) continue;
      for (const child of listChildren(directory)) {
        const childName = child.trim().replace(/\\/g, "/");
        if (!childName || childName.includes("/")) continue;
        const relative =
          directory === "" || directory === "." ? childName : `${directory}/${childName}`;
        expanded.add(relative);
      }
      continue;
    }
    if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) continue;
    expanded.add(pattern === "." ? "." : pattern.replace(/^\.\//, ""));
  }
  return [...expanded];
}

/**
 * Map absolute `repoRoots` into Diff repositories. `path` must be the full
 * workspace-relative offset (including intermediate directories), not the repo
 * basename and not the absolute cwd — Diff prefixes git-relative file paths with
 * `path`, then opens them against the workspace root (#12902).
 */
export function repositoriesFromRepoRoots(
  repoRoots: ReadonlyArray<string>,
  workspaceRoot?: string | null,
): ConfiguredDiffRepository[] {
  const repositories: ConfiguredDiffRepository[] = [];
  const seenCwds = new Set<string>();
  const normalizedWorkspace = workspaceRoot
    ? workspaceRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "")
    : "";

  for (const cwd of repoRoots) {
    const normalized = cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalized || seenCwds.has(normalized)) continue;
    seenCwds.add(normalized);
    const relativePath =
      normalizedWorkspace.length > 0
        ? workspaceRelativeRepositoryPath(normalizedWorkspace, normalized)
        : null;
    repositories.push({
      path: relativePath ?? basename(normalized),
      name: basename(normalized),
      cwd: normalized,
    });
  }

  return repositories;
}

/** Relative path from workspace root to a nested repo, or null when outside/equal. */
export function workspaceRelativeRepositoryPath(
  workspaceRoot: string,
  repositoryRoot: string,
): string | null {
  const workspace = workspaceRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const repository = repositoryRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!workspace || !repository) return null;
  if (repository === workspace) return ".";
  const caseInsensitive = /^[A-Za-z]:/.test(workspace);
  const workspaceKey = caseInsensitive ? workspace.toLowerCase() : workspace;
  const repositoryKey = caseInsensitive ? repository.toLowerCase() : repository;
  if (!repositoryKey.startsWith(`${workspaceKey}/`)) return null;
  return repository.slice(workspace.length + 1);
}

export function configuredDiffRepositories(input: {
  workspaceRoot: string;
  projectFile: T3ProjectFile | null;
  listChildren: (directoryRelativePath: string) => ReadonlyArray<string>;
}): ConfiguredDiffRepository[] {
  const paths = input.projectFile?.repositories?.paths;
  if (!paths || paths.length === 0) return [];

  const expanded = expandConfiguredRepositoryPaths(paths, input.listChildren);
  const repositories: ConfiguredDiffRepository[] = [];
  const seenCwds = new Set<string>();

  for (const relativePath of expanded) {
    const cwd = resolveConfiguredRepositoryCwd(input.workspaceRoot, relativePath);
    if (!cwd || seenCwds.has(cwd)) continue;
    seenCwds.add(cwd);
    const pathKey = relativePath === "." ? "." : relativePath;
    repositories.push({
      path: pathKey,
      name: pathKey === "." ? basename(input.workspaceRoot) : basename(pathKey),
      cwd,
    });
  }

  return repositories;
}

export function basename(pathValue: string): string {
  const normalized = pathValue.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}
