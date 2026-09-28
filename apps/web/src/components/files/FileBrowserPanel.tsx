import { RefreshIcon } from "~/components/ui/refresh-icon";
import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from "@pierre/trees/react";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { useFileContextMenu, type FileContextMenuAction } from "~/fileContextMenu";
import {
  isMultiRootFileBrowsing,
  projectFileBrowserRoots,
  resolveProjectFileTarget,
} from "~/lib/projectFileRoots";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";
import { projectEnvironment } from "~/state/projects";
import { useProjectPathSearch } from "~/state/queries";
import { useAtomCommand } from "~/state/use-atom-command";

import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "./fileTreeExpansion";
import { buildFileTreePathUpdates } from "./fileTreePathReconciliation";
import { buildNewWorkspaceFilePath, resolveNewFileDirectory } from "./newWorkspaceFile";
import { useDirectoryEntries } from "./useDirectoryEntries";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  /** Entry currently open in the surface; revealed and selected in the tree. A directory is expanded. */
  selectedPath: string | null;
  /** Bumped when the same path should be revealed again (e.g. re-opened from search). */
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  onRefreshSelectedFile?: () => void;
  workspaceMutationId: string | null;
  repoRoots?: ReadonlyArray<string> | null;
}

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RefreshIcon refreshing={props.isPending} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function FileSearchField(props: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
      <InputGroupInput
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  selectedPathRevealId,
  onOpenFile,
  onRefreshSelectedFile,
  workspaceMutationId,
  repoRoots = null,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const multiRoot = isMultiRootFileBrowsing(repoRoots);
  const browserRoots = useMemo(
    () => projectFileBrowserRoots({ workspaceRoot: cwd, repoRoots }),
    [cwd, repoRoots],
  );
  const defaultNewFileDirectory = multiRoot ? (browserRoots[0]?.label ?? "") : "";
  const composerRef = useComposerHandleContext();
  const fileContextMenu = useFileContextMenu(environmentId);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const newFileNameInputId = useId();
  const resolveTreePath = useCallback(
    (treePath: string) => resolveProjectFileTarget({ treePath, workspaceRoot: cwd, repoRoots }),
    [cwd, repoRoots],
  );
  const {
    entries: directoryEntries,
    load,
    refresh,
    ready,
    error,
    isPending,
  } = useDirectoryEntries(environmentId, cwd, repoRoots);
  const [query, setQuery] = useState("");
  const [expandAll, setExpandAll] = useState(false);
  // null closed; string is the directory path ("" = project root).
  const [newFileDirectory, setNewFileDirectory] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState("");
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const pathSearch = useProjectPathSearch(
    { environmentId, cwd, query: multiRoot ? null : query.slice(0, 256) },
    200,
  );
  const entries = useMemo(() => {
    const result = new Map(directoryEntries.map((entry) => [entry.path, entry]));
    if (query.trim() && !pathSearch.isPending) {
      for (const entry of pathSearch.entries) {
        if (!result.has(entry.path)) result.set(entry.path, entry);
        const segments = entry.path.split("/");
        for (let index = 1; index < segments.length; index++) {
          const path = segments.slice(0, index).join("/");
          if (!result.has(path)) result.set(path, { path, kind: "directory" });
        }
      }
    }
    return [...result.values()];
  }, [directoryEntries, pathSearch.entries, pathSearch.isPending, query]);
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(entryKinds);
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  const directoryPaths = useMemo(
    () => entries.filter((entry) => entry.kind === "directory").map(treePath),
    [entries],
  );
  const previousTreePathsRef = useRef<readonly string[] | null>(null);
  const treeModelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);

  // The tree renders rows in shadow DOM and its anchor rect is unreliable, so
  // capture the right-click position ourselves; contextmenu is a composed
  // event, so a capture-phase listener sees it with viewport coordinates.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => {
    const capturePointer = (event: MouseEvent) => {
      contextMenuPointerRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    };
    document.addEventListener("contextmenu", capturePointer, true);
    return () => document.removeEventListener("contextmenu", capturePointer, true);
  }, []);

  const openNewFileDialog = (directoryPath: string) => {
    setNewFileDirectory(directoryPath);
    setNewFileName("");
  };

  const closeNewFileDialog = () => {
    if (isCreatingFile) return;
    setNewFileDirectory(null);
    setNewFileName("");
  };

  const createNewFile = async () => {
    if (newFileDirectory === null || isCreatingFile) return;
    const treePath = buildNewWorkspaceFilePath(newFileDirectory, newFileName);
    if (treePath === null) {
      toastManager.add({ type: "warning", title: "Enter a valid file name" });
      return;
    }
    if (entryKindsRef.current.has(treePath)) {
      toastManager.add({
        type: "error",
        title: "File already exists",
        description: treePath,
      });
      return;
    }
    const { cwd: writeCwd, relativePath } = resolveTreePath(treePath);

    setIsCreatingFile(true);
    try {
      const result = await writeFile({
        environmentId,
        input: { cwd: writeCwd, relativePath, contents: "" },
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not create file",
          description: treePath,
        });
        return;
      }
      const parentDirectory = newFileDirectory;
      setNewFileDirectory(null);
      setNewFileName("");
      if (parentDirectory) {
        const parentItem =
          treeModelRef.current?.getItem(`${parentDirectory}/`) ??
          treeModelRef.current?.getItem(parentDirectory);
        if (parentItem && "expand" in parentItem) parentItem.expand();
      }
      await load(parentDirectory, true);
      onOpenFile(treePath);
    } finally {
      setIsCreatingFile(false);
    }
  };

  /** Combines the file actions (open/reveal/open with) with the panel's own mention actions. */
  const showEntryContextMenu = async (
    item: TreeContextMenuItem,
    context: TreeContextMenuOpenContext,
  ) => {
    const api = readLocalApi();
    if (!api) {
      context.close();
      return;
    }
    const treePath = item.path.replace(/\/$/, "");
    const { cwd: fileCwd, relativePath } = resolveTreePath(treePath);
    const mention = serializeComposerFileLink(treePath);
    const pointer = contextMenuPointerRef.current;
    const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
    const anchorRect = context.anchorElement.getBoundingClientRect();
    const position = pointerIsFresh
      ? { x: pointer.x, y: pointer.y }
      : { x: anchorRect.left, y: anchorRect.bottom };
    const fileTarget = { environmentId, filePath: relativePath, workspaceRoot: fileCwd };
    const fileMenuItems = fileContextMenu.buildItems(fileTarget);
    const newFileDirectoryPath = resolveNewFileDirectory({
      kind: item.kind,
      path: item.path,
    });
    try {
      const clicked = await api.contextMenu.show(
        [
          { id: "new-file", label: "New File", icon: "pencil" },
          ...fileMenuItems.map((entry, index) =>
            index === 0 ? { ...entry, separatorBefore: true } : entry,
          ),
          {
            id: "copy-mention",
            label: "Copy mention",
            separatorBefore: fileMenuItems.length === 0,
          },
          { id: "add-to-chat", label: "Add to chat" },
        ],
        position,
      );
      if (clicked === null) return;
      if (clicked === "new-file") {
        openNewFileDialog(newFileDirectoryPath);
        return;
      }
      // "Open with" submenu selections report the child id ("editor:<id>"),
      // which is not present in the top-level item list.
      const isFileMenuAction =
        fileMenuItems.some((entry) => entry.id === clicked) || clicked.startsWith("editor:");
      if (isFileMenuAction) {
        await fileContextMenu.activate(clicked as FileContextMenuAction, fileTarget);
        return;
      }
      if (clicked === "copy-mention") {
        try {
          await writeTextToClipboard(mention);
          toastManager.add({ type: "success", title: "Mention copied", description: treePath });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to copy mention",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }
      if (clicked === "add-to-chat") {
        const composer = composerRef?.current;
        if (!composer) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "Open a chat for this project and try again.",
          });
          return;
        }
        const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
        if (!inserted) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "The chat isn't ready to accept input right now.",
          });
        }
      }
    } finally {
      context.close();
    }
  };
  const showEntryContextMenuRef = useRef(showEntryContextMenu);
  useEffect(() => {
    showEntryContextMenuRef.current = showEntryContextMenu;
  });

  const dragMention = useMemo(
    () =>
      createFileTreeDragMentionController({
        deselect: (path) => treeModelRef.current?.getItem(path)?.deselect(),
      }),
    [],
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          void showEntryContextMenuRef.current(item, context);
        },
      },
    },
    // Rows only need to be draggable so entries can be dropped into the chat
    // composer; rearranging files inside the tree stays off.
    dragAndDrop: { canDrop: () => false },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // The drag controller's selection cache must track every change,
      // including reveal-driven ones, or drags act on a stale selection.
      dragMention.handleSelectionChange(selectedPaths);
      // Selection changes driven by the reveal sync below are echoes of an
      // already-open file, not a request to open it again.
      if (syncingSelectionRef.current) return;
      // Starting a drag selects the dragged row; that selection is a side
      // effect of the gesture, not a request to open the file.
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(selectedPath);
      }
    },
    paths: [],
    search: false,
    onSearchChange: (value) => setQuery(value ?? ""),
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  const search = useFileTreeSearch(model);
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, directoryPaths),
  );
  const toggleAllDirectories = () => {
    const expanded = !(expandAll || allDirectoriesExpanded);
    setExpandAll(expanded);
    setAllDirectoriesExpanded(model, directoryPaths, expanded);
  };
  const closeSearch = () => {
    setQuery("");
    search.close();
  };
  const expandedPathsRef = useRef(new Set<string>());
  useEffect(() => {
    const currentPaths = new Set(directoryPaths);
    for (const path of expandedPathsRef.current) {
      if (!currentPaths.has(path)) expandedPathsRef.current.delete(path);
    }
    const loadExpanded = () => {
      if (model.isSearchOpen()) return;
      for (const path of directoryPaths) {
        const item = model.getItem(path);
        if (item?.isDirectory() && "isExpanded" in item && item.isExpanded()) {
          if (!expandedPathsRef.current.has(path)) {
            expandedPathsRef.current.add(path);
            void load(path.replace(/\/$/, ""));
          }
        } else {
          if (item?.isDirectory() && expandedPathsRef.current.has(path)) setExpandAll(false);
          expandedPathsRef.current.delete(path);
        }
      }
    };
    loadExpanded();
    return model.subscribe(loadExpanded);
  }, [directoryPaths, load, model]);
  useEffect(() => {
    model.setGitStatus(
      entries
        .filter((entry) => entry.ignored)
        .map((entry) => ({
          path: treePath(entry),
          status: "ignored",
        })),
    );
  }, [entries, model]);
  useEffect(() => {
    if (!selectedPath) return;
    const controller = new AbortController();
    void (async () => {
      const segments = selectedPath.split("/");
      for (let index = 0; index < segments.length && !controller.signal.aborted; index++) {
        await load(segments.slice(0, index).join("/"));
      }
    })();
    return () => {
      controller.abort();
    };
  }, [load, selectedPath]);
  const handleSearchValueChange = (value: string) => {
    setQuery(value);
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };
  const handleRefresh = () => {
    refresh();
    if (query.trim()) pathSearch.refresh();
    onRefreshSelectedFile?.();
  };
  useWorkspaceMutationRefresh({
    mutationId: workspaceMutationId,
    refresh: () => {
      refresh();
      if (query.trim()) pathSearch.refresh();
    },
    resourceKey: `files:${environmentId}:${cwd}`,
  });

  useEffect(() => {
    if (!ready) return;
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    const previousTreePaths = previousTreePathsRef.current;
    previousTreePathsRef.current = treePaths;
    if (previousTreePaths === null) {
      model.resetPaths(treePaths);
      return;
    }
    const updates = buildFileTreePathUpdates(previousTreePaths, treePaths);
    if (updates.length > 0) model.batch(updates);
  }, [ready, entryKinds, model, treePaths]);

  useEffect(() => {
    if (expandAll && !query.trim()) setAllDirectoriesExpanded(model, directoryPaths, true);
  }, [directoryPaths, expandAll, model, query]);

  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      return;
    }
    const selectedKind = entryKinds.get(selectedPath);
    // An unloaded entry has no row to reveal yet; folders do, and chat links can
    // point at them.
    if (selectedKind === undefined) {
      handledRevealRef.current = null;
      return;
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    const handledReveal = handledRevealRef.current;
    // Entry refreshes rebuild treePaths while the same preview stays open.
    // Replaying a handled reveal would close an active tree search and steal focus.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }
    // Directory rows are registered with a trailing slash (see treePath).
    const selectedTreePath = selectedKind === "directory" ? `${selectedPath}/` : selectedPath;
    const selectedItem = model.getItem(selectedTreePath);
    if (!selectedItem) return;

    // A selection that originated inside the tree (clicking a row, possibly
    // in an active tree search) is already visible; re-revealing it would
    // close the search and clobber the user's context. Only sync external
    // opens (file picker, content search, chat links).
    const selectedInTree = model
      .getSelectedPaths()
      .some((path) => path.replace(/\/$/, "") === selectedPath);
    if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;
      return;
    }
    treeSelectionPathRef.current = null;
    handledRevealRef.current = revealRequest;

    syncingSelectionRef.current = true;
    setQuery("");
    model.closeSearch();
    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect();
    }

    // Directory rows are registered with a trailing slash (see treePath), so
    // ancestor lookups must use the same form to expand them.
    const segments = selectedPath.split("/");
    let ancestorPath = "";
    for (const segment of segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
      if (item && "expand" in item) item.expand();
    }

    if ("expand" in selectedItem) selectedItem.expand();
    selectedItem.select();
    model.scrollToPath(selectedTreePath, {
      focus: true,
      offset: "center",
    });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [entryKinds, model, selectedPath, selectedPathRevealId]);

  // Tag tree drags with the composer mention payload. The row is read from
  // the composed event path (the tree's shadow root is open), so this does
  // not depend on running after the tree's own dragstart handler; the drag
  // data store is writable for every dragstart listener in the dispatch.
  // The capture phase runs before the tree's own dragstart handler selects
  // the dragged row, so the drag flag is up before that selection emits.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    treeModelRef.current = model;
  }, [model]);
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const handleDragStart = (event: DragEvent) => dragMention.handleDragStart(event);
    const handleDragEnd = () => dragMention.handleDragEnd();
    panel.addEventListener("dragstart", handleDragStart, true);
    panel.addEventListener("dragend", handleDragEnd);
    return () => {
      panel.removeEventListener("dragstart", handleDragStart, true);
      panel.removeEventListener("dragend", handleDragEnd);
    };
  }, [dragMention]);

  const showRootNewFileMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const clicked = await api.contextMenu.show(
      [{ id: "new-file", label: "New File", icon: "pencil" }],
      position,
    );
    if (clicked === "new-file") openNewFileDialog(defaultNewFileDirectory);
  };

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
      onContextMenu={(event) => {
        // Empty-area right-click creates at the project root. Row menus are
        // handled by Pierre and stop here when the composed path hits a row.
        const onTreeRow = event.nativeEvent
          .composedPath()
          .some(
            (target) => target instanceof Element && target.getAttribute("data-type") === "item",
          );
        if (onTreeRow) return;
        event.preventDefault();
        void showRootNewFileMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-1 in-data-[preview-panel-mode=inline]:h-9 in-data-[preview-panel-mode=inline]:min-h-9 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <RefreshFilesButton isPending={isPending} onRefresh={handleRefresh} />
        <FileSearchField
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={search.value}
          onValueChange={handleSearchValueChange}
          onClose={closeSearch}
        />
        {directoryPaths.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    expandAll || allDirectoriesExpanded
                      ? "Collapse all folders"
                      : "Expand all folders"
                  }
                  onClick={toggleAllDirectories}
                />
              }
            >
              {allDirectoriesExpanded ? (
                <ChevronsDownUpIcon className="size-3.5" />
              ) : (
                <ChevronsUpDownIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup>
              {expandAll || allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {error || pathSearch.error ? (
        <button
          type="button"
          onClick={handleRefresh}
          className="p-4 text-left text-xs leading-relaxed text-destructive"
        >
          {error ?? pathSearch.error} Click to retry.
        </button>
      ) : null}
      {query.trim() && pathSearch.truncated && !pathSearch.isPending ? (
        <div className="px-3 py-1 text-xs text-muted-foreground">
          More matches available. Refine your search.
        </div>
      ) : null}
      {/* Keep loading out of document flow: inserting a visible banner here
          shifts every tree row when a folder expands (isPending toggles). The
          refresh icon already spins for the same state. */}
      {(isPending || pathSearch.isPending) && (
        <div role="status" className="sr-only">
          Loading files…
        </div>
      )}
      <FileTree
        model={model}
        aria-label={`${projectName} files`}
        className="min-h-0 flex-1 overflow-hidden"
        style={pierreTreeStyle(resolvedTheme)}
      />
      <Dialog
        open={newFileDirectory !== null}
        onOpenChange={(open) => {
          if (!open) closeNewFileDialog();
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>New File</DialogTitle>
            <DialogDescription>
              {newFileDirectory
                ? `Create a file in ${newFileDirectory}/.`
                : `Create a file in the ${projectName} project root.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label htmlFor={newFileNameInputId} className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">File name</span>
              <Input
                id={newFileNameInputId}
                value={newFileName}
                onChange={(event) => setNewFileName(event.target.value)}
                placeholder="example.ts"
                spellCheck={false}
                autoFocus
                disabled={isCreatingFile}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  void createNewFile();
                }}
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={closeNewFileDialog}
              disabled={isCreatingFile}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void createNewFile()}
              disabled={isCreatingFile || newFileName.trim().length === 0}
            >
              {isCreatingFile ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
