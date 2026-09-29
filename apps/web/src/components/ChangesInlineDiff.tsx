import type { DiffThemeType } from "@pierre/diffs";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { displayPathForRepository } from "~/changesPanel.logic";
import { sourceKindForGitScope } from "~/diffPanelStore";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import type { VcsRepositoryTarget } from "~/lib/sourceControlActions";
import { useVcsChangeActions } from "~/lib/sourceControlActions";
import { createWorkspaceDiff } from "~/lib/workspaceDiff";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";

import { DiffScmFileActions } from "./diffs/DiffScmFileActions";
import { StyledDiffCodeView } from "./diffs/StyledDiffCodeView";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

export function ChangesInlineDiff(props: {
  environmentId: EnvironmentId;
  cwd: string;
  repositoryPath: string;
  scope: "staged" | "unstaged";
  filePath: string;
  theme: "light" | "dark";
  onOpenInDiff: () => void;
}) {
  const sourceKind = sourceKindForGitScope(props.scope);
  const getDiffFileContents = useAtomCommand(reviewEnvironment.diffFileContents);
  const vcsActions = useVcsChangeActions();
  const target: VcsRepositoryTarget = {
    environmentId: props.environmentId,
    cwd: props.cwd,
  };
  const displayPath = displayPathForRepository(props.repositoryPath, props.filePath);

  const previewQuery = useEnvironmentQuery(
    reviewEnvironment.diffPreview({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        file: {
          path: props.filePath,
          previousPath: null,
          sourceKind,
        },
      },
    }),
  );

  const source = previewQuery.data?.sources.find((entry) => entry.kind === sourceKind) ?? null;
  const workspaceDiff = useMemo(
    () =>
      source
        ? createWorkspaceDiff(
            [
              {
                repository: {
                  path: props.repositoryPath,
                  name: props.repositoryPath,
                  cwd: props.cwd,
                  available: true,
                },
                source,
              },
            ],
            props.environmentId,
            getDiffFileContents,
            props.theme,
          )
        : null,
    [
      source,
      props.repositoryPath,
      props.cwd,
      props.environmentId,
      getDiffFileContents,
      props.theme,
    ],
  );

  const fileDiff = useMemo(() => {
    if (!workspaceDiff) return null;
    return (
      workspaceDiff.files.find((file) => resolveFileDiffPath(file) === displayPath) ??
      workspaceDiff.files[0] ??
      null
    );
  }, [workspaceDiff, displayPath]);

  const items = useMemo(() => {
    if (!fileDiff) return [];
    return [
      {
        id: buildFileDiffIdentityKey(fileDiff),
        type: "diff" as const,
        fileDiff,
        collapsed: false,
        version: buildFileDiffContentVersion(fileDiff),
      },
    ];
  }, [fileDiff]);

  return (
    <div className="mx-1 mb-1 overflow-hidden rounded-md border border-border/60 bg-background">
      <div className="flex items-center gap-1 border-b border-border/50 px-1.5 py-1">
        {props.scope === "unstaged" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void vcsActions.stagePaths(target, [props.filePath])}
          >
            Stage
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void vcsActions.unstagePaths(target, [props.filePath])}
          >
            Unstage
          </Button>
        )}
        {props.scope === "unstaged" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (window.confirm(`Discard changes in ${props.filePath}?`)) {
                void vcsActions.discardPaths(target, [props.filePath]);
              }
            }}
          >
            Discard
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="sm" onClick={props.onOpenInDiff}>
          Open in Diff
        </Button>
        {fileDiff ? (
          <div className="ms-auto">
            <DiffScmFileActions
              fileDiff={fileDiff}
              scope={props.scope}
              target={target}
              repositoryPath={props.repositoryPath}
            />
          </div>
        ) : null}
      </div>

      {previewQuery.isPending && !fileDiff ? (
        <div className="flex items-center justify-center gap-2 px-2 py-6 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          Loading diff…
        </div>
      ) : null}

      {previewQuery.error && !fileDiff ? (
        <div className="space-y-2 px-2 py-3 text-xs text-muted-foreground">
          <p className="text-error/80">{previewQuery.error}</p>
          <Button type="button" variant="ghost" size="sm" onClick={props.onOpenInDiff}>
            Open in Diff
          </Button>
        </div>
      ) : null}

      {fileDiff && workspaceDiff ? (
        <div className="max-h-60 min-h-24 overflow-hidden">
          <StyledDiffCodeView
            className="h-60 max-h-60 overflow-auto text-xs"
            items={items}
            unsafeCSSExtra="[data-diffs-header], [data-file-info] { display: none !important; }"
            options={{
              diffStyle: "unified",
              lineDiffType: "none",
              overflow: "scroll",
              theme: resolveDiffThemeName(props.theme),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              themeType: props.theme as DiffThemeType,
              stickyHeaders: false,
              loadDiffFiles: workspaceDiff.loadDiffFiles,
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
