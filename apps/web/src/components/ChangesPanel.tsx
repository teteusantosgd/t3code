import { useParams } from "@tanstack/react-router";
import type { EnvironmentId, VcsChangedFile, VcsStatusResult } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderTreeIcon,
  GitCommitIcon,
  ListIcon,
  MinusIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useCallback, useMemo, type ReactNode } from "react";

import {
  changesExpandedFileKey,
  changesFilePathParts,
  changesPanelIsLoading,
  displayPathForRepository,
  resolveChangesFileGroups,
  vcsFileStatusToTreeStatus,
} from "~/changesPanel.logic";
import { selectThreadChangesPanelState, useChangesPanelStore } from "~/changesPanelStore";
import { useDiffPanelStore, type DiffPanelGitScope } from "~/diffPanelStore";
import { useConfiguredWorkspaceRepositories } from "~/hooks/useConfiguredWorkspaceRepositories";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import {
  useGitStackedAction,
  useVcsChangeActions,
  type VcsRepositoryTarget,
} from "~/lib/sourceControlActions";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentQuery } from "~/state/query";
import { useProject, useThread } from "~/state/entities";
import { vcsEnvironment } from "~/state/vcs";
import { resolveThreadRouteRef } from "~/threadRoutes";
import { randomUUID } from "~/lib/utils";

import { ChangesInlineDiff } from "./ChangesInlineDiff";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { DiffFileTree, type DiffFileTreeEntry } from "./diffs/DiffFileTree";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/menu";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";
import { Toggle, ToggleGroup } from "./ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Spinner } from "./ui/spinner";

interface ChangesPanelProps {
  mode?: DiffPanelMode;
  workspaceMutationId: string | null;
}

interface RepositoryCardModel {
  readonly path: string;
  readonly name: string;
  readonly cwd: string;
  readonly status: VcsStatusResult | null;
  readonly isPending: boolean;
  readonly isRepo: boolean;
}

function changedFileTreeEntries(files: ReadonlyArray<VcsChangedFile>): DiffFileTreeEntry[] {
  return files.map((file) => ({
    path: file.path,
    status: vcsFileStatusToTreeStatus(file.status),
  }));
}

function ChangesFileRow(props: {
  file: VcsChangedFile;
  theme: "light" | "dark";
  expanded: boolean;
  onToggleExpand: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
  inlineDiff?: ReactNode;
}) {
  const { name, directory } = changesFilePathParts(props.file.path);
  return (
    <div className="flex flex-col">
      <div
        className={cn(
          "group flex min-h-8 items-center gap-1.5 rounded-(--control-radius) px-1.5 hover:bg-muted/50",
          props.expanded && "bg-muted/40",
        )}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs"
          aria-expanded={props.expanded}
          onClick={props.onToggleExpand}
        >
          {props.expanded ? (
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <PierreEntryIcon
            pathValue={props.file.path}
            kind="file"
            theme={props.theme}
            className="size-3.5 shrink-0"
          />
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span
              className={cn("min-w-0 truncate font-medium", directory && "max-w-[70%] shrink-0")}
            >
              {name}
            </span>
            {directory ? (
              <span className="min-w-0 truncate text-muted-foreground">{directory}</span>
            ) : null}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {props.file.status}
          </span>
          <DiffStatLabel
            additions={props.file.insertions}
            deletions={props.file.deletions}
            layout="inline"
            className="text-xs"
          />
        </button>
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {props.onStage ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon-xs" onClick={props.onStage} aria-label="Stage">
                    <PlusIcon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup>Stage</TooltipPopup>
            </Tooltip>
          ) : null}
          {props.onUnstage ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={props.onUnstage}
                    aria-label="Unstage"
                  >
                    <MinusIcon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup>Unstage</TooltipPopup>
            </Tooltip>
          ) : null}
          {props.onDiscard ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={props.onDiscard}
                    aria-label="Discard"
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup>Discard changes</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      </div>
      {props.expanded ? props.inlineDiff : null}
    </div>
  );
}

function ChangesFileList(props: {
  files: ReadonlyArray<VcsChangedFile>;
  repositoryPath: string;
  repositoryCwd: string;
  environmentId: EnvironmentId;
  layout: "list" | "tree";
  section: "staged" | "unstaged";
  theme: "light" | "dark";
  expandedFileKey: string | null;
  onToggleExpand: (key: string) => void;
  onOpenInDiff: (displayPath: string, scope: DiffPanelGitScope) => void;
  onStage?: (paths: ReadonlyArray<string>) => void;
  onUnstage?: (paths: ReadonlyArray<string>) => void;
  onDiscard?: (paths: ReadonlyArray<string>) => void;
}) {
  if (props.files.length === 0) return null;

  const scope = props.section === "staged" ? ("staged" as const) : ("unstaged" as const);

  if (props.layout === "tree") {
    const entries = changedFileTreeEntries(props.files);
    return (
      <DiffFileTree
        entries={entries}
        ariaLabel={props.section === "staged" ? "Staged files" : "Changed files"}
        onSelectFile={(path) =>
          props.onOpenInDiff(displayPathForRepository(props.repositoryPath, path), scope)
        }
        className="border-0 bg-transparent p-0"
      />
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {props.files.map((file) => {
        const displayPath = displayPathForRepository(props.repositoryPath, file.path);
        const repoPath = file.path;
        const expandKey = changesExpandedFileKey({
          cwd: props.repositoryCwd,
          scope,
          path: repoPath,
        });
        const expanded = props.expandedFileKey === expandKey;
        return (
          <ChangesFileRow
            key={`${props.section}:${displayPath}`}
            file={file}
            theme={props.theme}
            expanded={expanded}
            onToggleExpand={() => props.onToggleExpand(expandKey)}
            inlineDiff={
              expanded ? (
                <ChangesInlineDiff
                  environmentId={props.environmentId}
                  cwd={props.repositoryCwd}
                  repositoryPath={props.repositoryPath}
                  scope={scope}
                  filePath={repoPath}
                  theme={props.theme}
                  onOpenInDiff={() => props.onOpenInDiff(displayPath, scope)}
                />
              ) : null
            }
            {...(props.onStage ? { onStage: () => props.onStage?.([repoPath]) } : {})}
            {...(props.onUnstage ? { onUnstage: () => props.onUnstage?.([repoPath]) } : {})}
            {...(props.onDiscard
              ? {
                  onDiscard: () => {
                    if (window.confirm(`Discard changes in ${file.path}?`)) {
                      props.onDiscard?.([repoPath]);
                    }
                  },
                }
              : {})}
          />
        );
      })}
    </div>
  );
}

function RepositoryChangesCard(props: {
  model: RepositoryCardModel;
  environmentId: EnvironmentId;
  listLayout: "list" | "tree";
  theme: "light" | "dark";
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  commitMessage: string;
  onCommitMessageChange: (message: string) => void;
  expandedFileKey: string | null;
  onToggleExpand: (key: string) => void;
  onOpenInDiff: (displayPath: string, scope: DiffPanelGitScope, cwd: string) => void;
  vcsActions: ReturnType<typeof useVcsChangeActions>;
  runCommit: ReturnType<typeof useGitStackedAction>;
}) {
  const { model, environmentId } = props;
  const target: VcsRepositoryTarget = { environmentId, cwd: model.cwd };
  const groups = model.status
    ? resolveChangesFileGroups(model.status)
    : { staged: [], unstaged: [] };
  const stagedCount = groups.staged.length;
  const unstagedCount = groups.unstaged.length;
  const canCommit =
    model.isRepo && (stagedCount > 0 || (model.status?.hasWorkingTreeChanges ?? false));
  const changeCount = stagedCount + unstagedCount;

  const runPathsAction = useCallback(
    (kind: "stage" | "unstage" | "discard", paths: ReadonlyArray<string>) => {
      if (paths.length === 0) return;
      const action =
        kind === "stage"
          ? props.vcsActions.stagePaths
          : kind === "unstage"
            ? props.vcsActions.unstagePaths
            : props.vcsActions.discardPaths;
      void action(target, paths);
    },
    [props.vcsActions, target],
  );

  const handleCommit = useCallback(
    (mode: "staged" | "all" | "amend") => {
      if (mode === "amend") {
        void props.vcsActions.amendCommit(target, props.commitMessage);
        return;
      }
      const message = props.commitMessage.trim();
      void props.runCommit.run({
        actionId: randomUUID(),
        action: "commit",
        ...(message ? { commitMessage: message } : {}),
        ...(mode === "all"
          ? {}
          : stagedCount > 0
            ? {
                filePaths: groups.staged.map((file) => file.path),
              }
            : {}),
      });
    },
    [groups.staged, props.commitMessage, props.runCommit, props.vcsActions, stagedCount, target],
  );

  return (
    <section className="rounded-lg border border-border/60 bg-card/40">
      <div
        className={cn(
          "flex items-center gap-1.5 px-2 py-2",
          !props.collapsed && "border-b border-border/50",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={props.collapsed ? "Expand repository" : "Collapse repository"}
          aria-expanded={!props.collapsed}
          onClick={() => props.onCollapsedChange(!props.collapsed)}
        >
          {props.collapsed ? (
            <ChevronRightIcon className="size-3.5" />
          ) : (
            <ChevronDownIcon className="size-3.5" />
          )}
        </Button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => props.onCollapsedChange(!props.collapsed)}
        >
          <GitCommitIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{model.name}</div>
            {model.status?.refName ? (
              <div className="truncate text-2xs text-muted-foreground">{model.status.refName}</div>
            ) : null}
          </div>
          {props.collapsed && model.isRepo ? (
            <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
              {changeCount === 0 ? "Clean" : `${changeCount}`}
            </span>
          ) : null}
        </button>
        {model.isPending && !model.status ? <Spinner className="size-3.5" /> : null}
        {!props.collapsed &&
        ((model.status?.aheadCount ?? 0) > 0 || (model.status?.behindCount ?? 0) > 0) ? (
          <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
            {model.status?.aheadCount ? `↑${model.status.aheadCount}` : null}
            {model.status?.behindCount ? ` ↓${model.status.behindCount}` : null}
          </span>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-xs" aria-label="Repository actions">
                <MoreHorizontalIcon className="size-3.5" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void props.vcsActions.sync(target)}>
              Sync
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void props.vcsActions.push(target)}>
              Push
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                void props.vcsActions.stash(target, { action: "push", includeUntracked: true })
              }
            >
              Stash changes
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => handleCommit("amend")}>
              Amend last commit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void props.vcsActions.undoLastCommit(target)}>
              Undo last commit
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {props.collapsed ? null : (
        <div className="space-y-3 px-2 py-2">
          {model.isPending && !model.status ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
              <Spinner className="size-4" />
              Loading status…
            </div>
          ) : null}
          {!model.isPending && !model.isRepo ? (
            <p className="px-1 py-4 text-center text-xs text-muted-foreground">
              Not a Git repository.
            </p>
          ) : null}
          {model.isRepo && stagedCount > 0 ? (
            <div>
              <div className="mb-1 flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
                <span>Staged changes</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    runPathsAction(
                      "unstage",
                      groups.staged.map((file) => file.path),
                    )
                  }
                >
                  Unstage all
                </Button>
              </div>
              <ChangesFileList
                files={groups.staged}
                repositoryPath={model.path}
                repositoryCwd={model.cwd}
                environmentId={environmentId}
                layout={props.listLayout}
                section="staged"
                theme={props.theme}
                expandedFileKey={props.expandedFileKey}
                onToggleExpand={props.onToggleExpand}
                onOpenInDiff={(displayPath, scope) =>
                  props.onOpenInDiff(displayPath, scope, model.cwd)
                }
                onUnstage={(paths) => runPathsAction("unstage", paths)}
              />
            </div>
          ) : null}

          {model.isRepo && unstagedCount > 0 ? (
            <div>
              <div className="mb-1 flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
                <span>Changes</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    runPathsAction(
                      "stage",
                      groups.unstaged.map((file) => file.path),
                    )
                  }
                >
                  Stage all
                </Button>
              </div>
              <ChangesFileList
                files={groups.unstaged}
                repositoryPath={model.path}
                repositoryCwd={model.cwd}
                environmentId={environmentId}
                layout={props.listLayout}
                section="unstaged"
                theme={props.theme}
                expandedFileKey={props.expandedFileKey}
                onToggleExpand={props.onToggleExpand}
                onOpenInDiff={(displayPath, scope) =>
                  props.onOpenInDiff(displayPath, scope, model.cwd)
                }
                onStage={(paths) => runPathsAction("stage", paths)}
                onDiscard={(paths) => runPathsAction("discard", paths)}
              />
            </div>
          ) : null}

          {model.isRepo && !model.isPending && stagedCount === 0 && unstagedCount === 0 ? (
            <p className="px-1 py-4 text-center text-xs text-muted-foreground">No local changes</p>
          ) : null}

          {model.isRepo ? (
            <div className="space-y-2 border-t border-border/40 pt-2">
              <div className="relative">
                <Textarea
                  value={props.commitMessage}
                  onChange={(event) => props.onCommitMessageChange(event.target.value)}
                  placeholder="Message (leave empty to auto-generate)"
                  rows={3}
                  className="min-h-[4.5rem] resize-none pe-9 text-xs"
                />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="absolute end-1.5 top-1.5"
                        aria-label="Generate commit message"
                        disabled={!canCommit || props.runCommit.isPending}
                        onClick={() => {
                          props.onCommitMessageChange("");
                          handleCommit(stagedCount > 0 ? "staged" : "all");
                        }}
                      >
                        <SparklesIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup>Generate message and commit</TooltipPopup>
                </Tooltip>
              </div>
              <div className="flex gap-1">
                <Button
                  className="min-w-0 flex-1"
                  disabled={!canCommit || props.runCommit.isPending}
                  onClick={() => handleCommit(stagedCount > 0 ? "staged" : "all")}
                >
                  {props.runCommit.isPending
                    ? "Committing…"
                    : stagedCount > 0
                      ? "Commit"
                      : "Commit all"}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="default"
                        size="icon"
                        disabled={!canCommit || props.runCommit.isPending}
                        aria-label="More commit options"
                      >
                        <ChevronDownIcon className="size-4" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={stagedCount === 0}
                      onClick={() => handleCommit("staged")}
                    >
                      Commit staged
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleCommit("all")}>
                      Commit all
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => handleCommit("amend")}>
                      Amend last commit
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function RepositoryChangesCardContainer(props: {
  model: RepositoryCardModel;
  environmentId: EnvironmentId;
  listLayout: "list" | "tree";
  theme: "light" | "dark";
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  commitMessage: string;
  onCommitMessageChange: (message: string) => void;
  expandedFileKey: string | null;
  onToggleExpand: (key: string) => void;
  onOpenInDiff: (displayPath: string, scope: DiffPanelGitScope, cwd: string) => void;
  vcsActions: ReturnType<typeof useVcsChangeActions>;
}) {
  const runCommit = useGitStackedAction({
    environmentId: props.environmentId,
    cwd: props.model.cwd,
  });
  return (
    <RepositoryChangesCard
      model={props.model}
      environmentId={props.environmentId}
      listLayout={props.listLayout}
      theme={props.theme}
      collapsed={props.collapsed}
      onCollapsedChange={props.onCollapsedChange}
      commitMessage={props.commitMessage}
      onCommitMessageChange={props.onCommitMessageChange}
      expandedFileKey={props.expandedFileKey}
      onToggleExpand={props.onToggleExpand}
      onOpenInDiff={props.onOpenInDiff}
      vcsActions={props.vcsActions}
      runCommit={runCommit}
    />
  );
}

export default function ChangesPanel({
  mode = "embedded",
  workspaceMutationId,
}: ChangesPanelProps) {
  const { resolvedTheme } = useTheme();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThread = useThread(routeThreadRef);
  const activeProject = useProject(
    activeThread && activeThread.projectId
      ? { environmentId: activeThread.environmentId, projectId: activeThread.projectId }
      : null,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.workspaceRoot ?? null;
  const environmentId = activeThread?.environmentId ?? null;

  const panelState = useChangesPanelStore((state) =>
    selectThreadChangesPanelState(state.byThreadKey, routeThreadRef),
  );
  const setListLayout = useChangesPanelStore((state) => state.setListLayout);
  const setCommitMessage = useChangesPanelStore((state) => state.setCommitMessage);
  const setRepositoryCollapsed = useChangesPanelStore((state) => state.setRepositoryCollapsed);
  const toggleExpandedFileKey = useChangesPanelStore((state) => state.toggleExpandedFileKey);

  const {
    repositories,
    statuses,
    hasConfiguredRepositories,
    refresh: refreshRepositories,
    isConfigPending,
  } = useConfiguredWorkspaceRepositories({
    environmentId,
    cwd: activeCwd,
    mutationId: workspaceMutationId,
    repoRoots: activeProject?.repoRoots ?? null,
    enabled: activeThread?.worktreePath == null,
  });

  const primaryStatusQuery = useEnvironmentQuery(
    environmentId !== null && activeCwd !== null && !hasConfiguredRepositories
      ? vcsEnvironment.status({ environmentId, input: { cwd: activeCwd } })
      : null,
  );

  useWorkspaceMutationRefresh({
    enabled: activeCwd !== null,
    mutationId: workspaceMutationId,
    refresh: () => {
      refreshRepositories();
      primaryStatusQuery.refresh();
    },
    resourceKey: `changes-panel:${environmentId ?? ""}:${activeCwd ?? ""}`,
  });

  const repositoryCards = useMemo((): RepositoryCardModel[] => {
    if (hasConfiguredRepositories) {
      // Show every configured checkout immediately; per-card pending covers status.
      // Filtering to available-only hid all cards while VCS probes were in flight.
      return repositories.map((repository) => {
        const state = statuses.find((entry) => entry.repository.cwd === repository.cwd);
        return {
          path: repository.path,
          name: repository.name,
          cwd: repository.cwd,
          status: state?.status ?? null,
          isPending: state?.isPending ?? false,
          isRepo: state?.status?.isRepo === true,
        };
      });
    }
    if (!activeCwd) return [];
    return [
      {
        path: ".",
        name: activeProject?.title ?? "Repository",
        cwd: activeCwd,
        status: primaryStatusQuery.data ?? null,
        isPending: primaryStatusQuery.isPending,
        isRepo: primaryStatusQuery.data?.isRepo === true,
      },
    ];
  }, [
    activeCwd,
    activeProject?.title,
    hasConfiguredRepositories,
    primaryStatusQuery.data,
    primaryStatusQuery.isPending,
    repositories,
    statuses,
  ]);

  const vcsActions = useVcsChangeActions();

  const openInDiffPanel = useCallback(
    (displayPath: string, scope: DiffPanelGitScope, _cwd: string) => {
      if (!routeThreadRef) return;
      useDiffPanelStore.getState().selectGitScope(routeThreadRef, scope, displayPath);
      useRightPanelStore.getState().open(routeThreadRef, "diff");
    },
    [routeThreadRef],
  );

  const onToggleExpand = useCallback(
    (key: string) => {
      if (!routeThreadRef) return;
      toggleExpandedFileKey(routeThreadRef, key);
    },
    [routeThreadRef, toggleExpandedFileKey],
  );

  const header = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="truncate text-xs font-medium">Changes</span>
      <div className="ml-auto flex items-center gap-1">
        <ToggleGroup
          value={[panelState.listLayout]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "list" || next === "tree") {
              if (routeThreadRef) setListLayout(routeThreadRef, next);
            }
          }}
        >
          <Toggle value="list" aria-label="List view">
            <ListIcon className="size-3.5" />
          </Toggle>
          <Toggle value="tree" aria-label="Tree view">
            <FolderTreeIcon className="size-3.5" />
          </Toggle>
        </ToggleGroup>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh status"
          onClick={() => {
            refreshRepositories();
            primaryStatusQuery.refresh();
          }}
        >
          <RefreshIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );

  const isLoading = changesPanelIsLoading({
    hasConfiguredRepositories,
    repositoryCardCount: repositoryCards.length,
    configPending: isConfigPending,
    primaryStatusPending: primaryStatusQuery.isPending,
  });

  return (
    <DiffPanelShell mode={mode} header={header}>
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn("flex flex-col gap-3 p-2", mode === "embedded" ? "pb-4" : "p-4")}>
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <Spinner className="size-4" />
              Loading changes…
            </div>
          ) : repositoryCards.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No Git repositories in this workspace.
            </p>
          ) : (
            repositoryCards.map((model) => {
              const repositoryKey = model.cwd;
              const commitMessage = panelState.commitMessageByRepositoryKey[repositoryKey] ?? "";
              if (environmentId === null) return null;
              return (
                <RepositoryChangesCardContainer
                  key={model.cwd}
                  model={model}
                  environmentId={environmentId}
                  listLayout={panelState.listLayout}
                  theme={resolvedTheme}
                  collapsed={panelState.collapsedRepositoryKeys[repositoryKey] === true}
                  onCollapsedChange={(collapsed) => {
                    if (routeThreadRef) {
                      setRepositoryCollapsed(routeThreadRef, repositoryKey, collapsed);
                    }
                  }}
                  commitMessage={commitMessage}
                  onCommitMessageChange={(message) => {
                    if (routeThreadRef) setCommitMessage(routeThreadRef, repositoryKey, message);
                  }}
                  expandedFileKey={panelState.expandedFileKey}
                  onToggleExpand={onToggleExpand}
                  onOpenInDiff={openInDiffPanel}
                  vcsActions={vcsActions}
                />
              );
            })
          )}
        </div>
      </ScrollArea>
    </DiffPanelShell>
  );
}
