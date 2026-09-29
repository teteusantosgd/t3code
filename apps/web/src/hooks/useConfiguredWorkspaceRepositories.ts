import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";

import {
  configuredDiffRepositories,
  repositoriesFromRepoRoots,
  type ConfiguredDiffRepository,
} from "../lib/configuredRepositories";
import type { WorkspaceDiffRepository } from "../lib/workspaceDiff";
import { useT3ProjectFileState } from "./useT3ProjectFileScripts";
import { projectEnvironment } from "../state/projects";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { useWorkspaceMutationRefresh } from "./useWorkspaceMutationRefresh";

function childrenFromListEntries(
  entries: ReadonlyArray<{ path: string; kind: "file" | "directory" }> | undefined,
  directoryRelativePath: string,
): string[] {
  if (!entries) return [];
  const prefix =
    directoryRelativePath === "" || directoryRelativePath === "."
      ? ""
      : `${directoryRelativePath.replace(/\/+$/, "")}/`;
  return entries
    .filter((entry) => entry.kind === "directory")
    .map((entry) =>
      prefix && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path,
    )
    .filter((name) => name.length > 0 && !name.includes("/"));
}

export function useConfiguredWorkspaceRepositories(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  mutationId: string | null;
  enabled: boolean;
  repoRoots?: ReadonlyArray<string> | null;
}) {
  const { environmentId, cwd, mutationId, enabled, repoRoots = null } = input;
  const useRepoRoots = (repoRoots?.length ?? 0) > 0;
  const projectFile = useT3ProjectFileState(environmentId, useRepoRoots ? null : cwd);
  const configuredPaths = useRepoRoots ? [] : (projectFile.file?.repositories?.paths ?? []);
  const needsChildListing = configuredPaths.some((path) => path.trim().endsWith("/*"));
  const wildcardDirectories = useMemo(() => {
    const directories = new Set<string>();
    for (const path of configuredPaths) {
      const trimmed = path.trim().replace(/\\/g, "/");
      if (!trimmed.endsWith("/*")) continue;
      const directory = trimmed.slice(0, -2);
      directories.add(directory === "" ? "." : directory);
    }
    return [...directories];
  }, [configuredPaths]);

  // listEntries with directoryPath lists immediate children; query the parent for each wildcard.
  const primaryWildcardDirectory = wildcardDirectories[0] ?? null;
  const listQuery = useEnvironmentQuery(
    enabled &&
      needsChildListing &&
      environmentId !== null &&
      cwd !== null &&
      primaryWildcardDirectory !== null
      ? projectEnvironment.listEntries({
          environmentId,
          input: {
            cwd,
            ...(primaryWildcardDirectory === "."
              ? {}
              : { directoryPath: primaryWildcardDirectory }),
          },
        })
      : null,
  );

  const configured = useMemo(() => {
    if (!enabled || !cwd) return [] as ConfiguredDiffRepository[];
    if (useRepoRoots) return repositoriesFromRepoRoots(repoRoots ?? []);
    if (configuredPaths.length === 0) return [] as ConfiguredDiffRepository[];
    const childrenByDirectory = new Map<string, string[]>();
    if (primaryWildcardDirectory !== null) {
      childrenByDirectory.set(
        primaryWildcardDirectory,
        childrenFromListEntries(listQuery.data?.entries, primaryWildcardDirectory),
      );
    }
    return configuredDiffRepositories({
      workspaceRoot: cwd,
      projectFile: projectFile.file,
      listChildren: (directoryRelativePath) =>
        childrenByDirectory.get(directoryRelativePath === "" ? "." : directoryRelativePath) ?? [],
    });
  }, [
    enabled,
    cwd,
    configuredPaths.length,
    projectFile.file,
    primaryWildcardDirectory,
    listQuery.data?.entries,
    repoRoots,
    useRepoRoots,
  ]);

  const statusTargets = useMemo(
    () =>
      environmentId === null
        ? []
        : configured.map((repository) => ({
            repository,
            atom: vcsEnvironment.status({
              environmentId,
              input: { cwd: repository.cwd },
            }),
          })),
    [environmentId, configured],
  );

  const statusesAtom = useMemo(
    () =>
      Atom.make((get) =>
        statusTargets.map(({ repository, atom }) => {
          const result = get(atom);
          return {
            repository,
            status: Option.getOrNull(AsyncResult.value(result)),
            error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
            // Subscription atoms stay `waiting` while live; only treat as pending
            // until the first status snapshot arrives.
            isPending:
              Option.isNone(AsyncResult.value(result)) &&
              (result._tag === "Initial" || result.waiting),
          };
        }),
      ),
    [statusTargets],
  );
  const statuses = useAtomValue(statusesAtom);
  const registry = useContext(RegistryContext);

  const repositories = useMemo<WorkspaceDiffRepository[]>(
    () =>
      configured.map((repository) => {
        const state = statuses.find((entry) => entry.repository.cwd === repository.cwd);
        const available = state?.status?.isRepo === true;
        return { ...repository, available };
      }),
    [configured, statuses],
  );

  const scope = `${environmentId ?? ""}:${cwd ?? ""}:${useRepoRoots ? (repoRoots ?? []).join("|") : ""}`;
  const [repositoryFilter, setRepositoryFilter] = useState<string | null>(null);
  const [filterScope, setFilterScope] = useState<string | null>(null);
  const activeFilter = filterScope === scope ? repositoryFilter : null;

  const selectRepository = useCallback(
    (path: string | null) => {
      setFilterScope(scope);
      setRepositoryFilter(path);
    },
    [scope],
  );

  const refresh = useCallback(() => {
    listQuery.refresh();
    for (const { atom } of statusTargets) registry.refresh(atom);
  }, [listQuery, statusTargets, registry]);

  useWorkspaceMutationRefresh({
    enabled: enabled && cwd !== null,
    mutationId,
    refresh,
    resourceKey: `configured-repositories:${scope}`,
  });

  useEffect(() => {
    if (!enabled || cwd === null) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [enabled, cwd, refresh]);

  return {
    repositories,
    statuses,
    repositoryFilter: activeFilter,
    selectRepository,
    hasConfiguredRepositories: configured.length > 0,
    refresh,
    /** True while discovering which repositories exist (project file / wildcards). */
    isConfigPending:
      (!useRepoRoots && projectFile.status === "loading") ||
      (needsChildListing && listQuery.isPending),
    isPending:
      (!useRepoRoots && projectFile.status === "loading") ||
      (needsChildListing && listQuery.isPending) ||
      statuses.some((entry) => entry.isPending),
    error: listQuery.error,
  };
}
