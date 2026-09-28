import {
  isCodeWorkspaceFilePath,
  resolveAddProjectPath,
} from "@t3tools/client-runtime/operations/projects";
import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import {
  appendBrowsePathSegment,
  getBrowseDirectoryPath,
  hasTrailingPathSeparator,
} from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { FileIcon, FolderIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { buildRepoRootLabels } from "../../lib/repoRootLabels";
import { filesystemEnvironment } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

const CODE_WORKSPACE_EXTENSIONS = [".code-workspace"] as const;

function normalizeRootPath(pathValue: string): string {
  return pathValue.replace(/[\\/]+$/, "");
}

function WorkspaceFolderList(props: {
  readonly roots: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onRemove: (root: string) => void;
}) {
  const labels = useMemo(() => buildRepoRootLabels(props.roots), [props.roots]);
  if (props.roots.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No Git folders yet. Add a folder or refresh from the workspace file.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5 rounded-md border border-border-subtle px-3 py-2 text-sm">
      {props.roots.map((root) => (
        <li key={root} className="flex min-w-0 items-start gap-2">
          <FolderIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{labels.get(root) ?? root}</span>
            <span className="block truncate text-muted-foreground text-xs">{root}</span>
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${labels.get(root) ?? root}`}
            disabled={props.disabled}
            onClick={() => props.onRemove(root)}
          >
            <XIcon aria-hidden className="size-4" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function ProjectCodeWorkspaceSettings({
  environmentId,
  projectId,
  workspaceRoot,
  workspaceFile,
  repoRoots,
  platform,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  workspaceRoot: string;
  workspaceFile: string | null;
  repoRoots: ReadonlyArray<string>;
  platform: string;
}) {
  const { environments } = useEnvironments();
  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const loadBrowsePath = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    reportDefect: false,
  });
  const [browseNavigation] = useState(createBrowseNavigationCoordinator);
  const [pathInput, setPathInput] = useState(workspaceFile ?? `${workspaceRoot}/`);
  const [isSaving, setIsSaving] = useState(false);
  const [addingFolder, setAddingFolder] = useState(false);
  const [folderPathInput, setFolderPathInput] = useState(`${workspaceRoot}/`);

  useEffect(() => {
    setPathInput(workspaceFile ?? `${workspaceRoot}/`);
  }, [workspaceFile, workspaceRoot]);

  useEffect(
    () => () => {
      browseNavigation.invalidate();
    },
    [browseNavigation],
  );

  const workspaceBrowsePath = useMemo(
    () =>
      getFilesystemBrowsePath(
        pathInput,
        platform,
        !addingFolder && isCodeWorkspaceFilePath(pathInput),
      ),
    [addingFolder, pathInput, platform],
  );
  const folderBrowsePath = useMemo(
    () => getFilesystemBrowsePath(folderPathInput, platform, addingFolder),
    [addingFolder, folderPathInput, platform],
  );
  const activeBrowsePath = addingFolder ? folderBrowsePath : workspaceBrowsePath;
  const activeBrowseQuery = addingFolder ? folderPathInput : pathInput;
  const includeWorkspaceFiles = !addingFolder;

  const browseState = useEnvironmentQuery(
    activeBrowsePath.isBrowsing &&
      activeBrowsePath.directoryPath.length > 0 &&
      !(includeWorkspaceFiles && isCodeWorkspaceFilePath(activeBrowseQuery))
      ? filesystemEnvironment.browse({
          environmentId,
          input: {
            partialPath: activeBrowsePath.directoryPath,
            ...(includeWorkspaceFiles
              ? { includeFileExtensions: [...CODE_WORKSPACE_EXTENSIONS] }
              : {}),
          },
        })
      : null,
  );
  const { visibleEntries: visibleBrowseEntries } = useMemo(
    () =>
      filterFilesystemBrowseEntries(browseState.data?.entries ?? [], activeBrowsePath.filterQuery),
    [activeBrowsePath.filterQuery, browseState.data?.entries],
  );

  const persistRepoRoots = useCallback(
    async (nextRoots: ReadonlyArray<string>) => {
      if (!canPreloadBrowsePath(environment?.connection.phase)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Environment unavailable",
            description: "Connect this environment and try again.",
          }),
        );
        return false;
      }
      setIsSaving(true);
      const result = await updateProject({
        environmentId,
        input: { projectId, repoRoots: [...nextRoots] },
      });
      setIsSaving(false);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to update folders",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return false;
      }
      return true;
    },
    [environment?.connection.phase, environmentId, projectId, updateProject],
  );

  const applyWorkspaceFile = useCallback(
    async (workspaceFilePath: string) => {
      if (!canPreloadBrowsePath(environment?.connection.phase)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Environment unavailable",
            description: "Connect this environment and try again.",
          }),
        );
        return;
      }
      const resolved = resolveAddProjectPath({
        rawPath: workspaceFilePath,
        currentProjectCwd: null,
        platform,
      });
      if (!resolved.ok) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Invalid workspace path",
            description: resolved.error,
          }),
        );
        return;
      }
      if (!isCodeWorkspaceFilePath(resolved.path)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Choose a workspace file",
            description: "Path must end with .code-workspace.",
          }),
        );
        return;
      }
      setIsSaving(true);
      const result = await updateProject({
        environmentId,
        input: { projectId, workspaceFile: resolved.path },
      });
      setIsSaving(false);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to update workspace",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      setPathInput(resolved.path);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: workspaceFile ? "Workspace updated" : "Workspace linked",
        }),
      );
    },
    [
      environment?.connection.phase,
      environmentId,
      platform,
      projectId,
      updateProject,
      workspaceFile,
    ],
  );

  const unlinkWorkspace = useCallback(async () => {
    setIsSaving(true);
    const result = await updateProject({
      environmentId,
      input: { projectId, workspaceFile: null },
    });
    setIsSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to unlink workspace",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return;
    }
    toastManager.add(stackedThreadToast({ type: "success", title: "Workspace unlinked" }));
    setAddingFolder(false);
  }, [environmentId, projectId, updateProject]);

  const removeRoot = useCallback(
    async (root: string) => {
      const next = repoRoots.filter(
        (candidate) => normalizeRootPath(candidate) !== normalizeRootPath(root),
      );
      if (next.length === repoRoots.length) return;
      const ok = await persistRepoRoots(next);
      if (ok) {
        toastManager.add(stackedThreadToast({ type: "success", title: "Folder removed" }));
      }
    },
    [persistRepoRoots, repoRoots],
  );

  const addRoot = useCallback(
    async (rawPath: string) => {
      const resolved = resolveAddProjectPath({
        rawPath,
        currentProjectCwd: null,
        platform,
      });
      if (!resolved.ok) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Invalid folder path",
            description: resolved.error,
          }),
        );
        return;
      }
      if (isCodeWorkspaceFilePath(resolved.path)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Choose a folder",
            description: "Add a Git folder path, not a .code-workspace file.",
          }),
        );
        return;
      }
      const normalized = normalizeRootPath(resolved.path);
      if (repoRoots.some((root) => normalizeRootPath(root) === normalized)) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Folder already listed",
            description: normalized,
          }),
        );
        return;
      }
      const ok = await persistRepoRoots([...repoRoots, normalized]);
      if (ok) {
        setAddingFolder(false);
        setFolderPathInput(`${workspaceRoot}/`);
        toastManager.add(stackedThreadToast({ type: "success", title: "Folder added" }));
      }
    },
    [persistRepoRoots, platform, repoRoots, workspaceRoot],
  );

  const navigateBrowse = useCallback(
    async (input: {
      readonly browseDirectoryPath: string;
      readonly selectedName?: string;
      readonly forFolderAdd: boolean;
    }) => {
      const nextPath = input.selectedName
        ? appendBrowsePathSegment(input.browseDirectoryPath, input.selectedName)
        : input.browseDirectoryPath;
      await browseNavigation.run(
        async () => {
          if (canPreloadBrowsePath(environment?.connection.phase)) {
            await loadBrowsePath({
              environmentId,
              input: {
                partialPath: getBrowseDirectoryPath(nextPath),
                ...(input.forFolderAdd
                  ? {}
                  : { includeFileExtensions: [...CODE_WORKSPACE_EXTENSIONS] }),
              },
            });
          }
        },
        () => {
          if (input.forFolderAdd) {
            setFolderPathInput(nextPath);
          } else {
            setPathInput(nextPath);
          }
        },
      );
    },
    [browseNavigation, environment?.connection.phase, environmentId, loadBrowsePath],
  );

  const showFolders = workspaceFile !== null || repoRoots.length > 0 || addingFolder;

  return (
    <>
      {workspaceFile ? (
        <SettingsRow
          title="Linked workspace file"
          description={workspaceFile}
          control={
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={isSaving}
                onClick={() => void applyWorkspaceFile(workspaceFile)}
              >
                Refresh from file
              </Button>
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={isSaving}
                onClick={() => void unlinkWorkspace()}
              >
                Unlink
              </Button>
            </div>
          }
        />
      ) : null}

      {showFolders ? (
        <SettingsRow
          title="Workspace folders"
          description="Used for Diff and Files. Refresh from file reloads folders from the .code-workspace."
          control={
            <div className="flex w-full flex-col gap-2 sm:w-96">
              <WorkspaceFolderList
                roots={repoRoots}
                disabled={isSaving}
                onRemove={(root) => void removeRoot(root)}
              />
              {addingFolder ? (
                <div className="flex flex-col gap-2">
                  <Input
                    size="sm"
                    aria-label="Folder path to add"
                    value={folderPathInput}
                    disabled={isSaving}
                    onChange={(event) => setFolderPathInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void addRoot(folderPathInput);
                      }
                    }}
                  />
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isSaving}
                      onClick={() => {
                        setAddingFolder(false);
                        setFolderPathInput(`${workspaceRoot}/`);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={isSaving || folderPathInput.trim().length === 0}
                      onClick={() => void addRoot(folderPathInput)}
                    >
                      Add folder
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isSaving}
                    onClick={() => {
                      setAddingFolder(true);
                      setFolderPathInput(`${workspaceRoot}/`);
                    }}
                  >
                    <PlusIcon aria-hidden className="size-4" />
                    Add folder
                  </Button>
                </div>
              )}
            </div>
          }
        />
      ) : null}

      <SettingsRow
        title={workspaceFile ? "Replace workspace file" : "Link VS Code workspace"}
        description="Choose a .code-workspace file. Git folders sync into this project automatically."
        control={
          <div className="flex w-full flex-col gap-2 sm:w-80">
            <Input
              size="sm"
              aria-label="VS Code workspace file path"
              value={pathInput}
              disabled={isSaving || addingFolder}
              onChange={(event) => setPathInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void applyWorkspaceFile(pathInput);
                }
              }}
            />
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                size="sm"
                disabled={isSaving || addingFolder || pathInput.trim().length === 0}
                onClick={() => void applyWorkspaceFile(pathInput)}
              >
                {workspaceFile ? "Replace" : "Link workspace"}
              </Button>
            </div>
          </div>
        }
      />

      {activeBrowsePath.isBrowsing &&
      !(includeWorkspaceFiles && isCodeWorkspaceFilePath(activeBrowseQuery)) ? (
        <SettingsRow
          title="Browse"
          description={
            addingFolder
              ? "Pick a folder to add as a Diff/Files root."
              : "Pick a folder or workspace file on the connected environment."
          }
          control={
            <div className="w-full space-y-1 sm:w-80">
              {activeBrowsePath.canBrowseUp && activeBrowsePath.parentPath ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => {
                    void navigateBrowse({
                      browseDirectoryPath: activeBrowsePath.parentPath!,
                      forFolderAdd: addingFolder,
                    });
                  }}
                >
                  ..
                </Button>
              ) : null}
              {visibleBrowseEntries.map((entry) => (
                <Button
                  key={entry.fullPath}
                  size="sm"
                  variant="ghost"
                  className="w-full justify-start gap-2"
                  onClick={() => {
                    if (addingFolder) {
                      if (entry.kind === "file") return;
                      void navigateBrowse({
                        browseDirectoryPath: activeBrowsePath.directoryPath,
                        selectedName: entry.name,
                        forFolderAdd: true,
                      });
                      return;
                    }
                    if (entry.kind === "file") {
                      void applyWorkspaceFile(entry.fullPath);
                      return;
                    }
                    void navigateBrowse({
                      browseDirectoryPath: activeBrowsePath.directoryPath,
                      selectedName: entry.name,
                      forFolderAdd: false,
                    });
                  }}
                >
                  {entry.kind === "file" ? (
                    <FileIcon aria-hidden className="size-4 shrink-0" />
                  ) : (
                    <FolderIcon aria-hidden className="size-4 shrink-0" />
                  )}
                  <span className="truncate">{entry.name}</span>
                </Button>
              ))}
              {addingFolder && folderBrowsePath.isBrowsing ? (
                <Button
                  size="sm"
                  className="mt-1 w-full"
                  disabled={isSaving}
                  onClick={() => {
                    const target = hasTrailingPathSeparator(folderPathInput)
                      ? folderBrowsePath.directoryPath || folderPathInput
                      : folderPathInput;
                    void addRoot(target);
                  }}
                >
                  Use this folder
                </Button>
              ) : null}
            </div>
          }
        />
      ) : null}
    </>
  );
}
