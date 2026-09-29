import type { FileDiffMetadata } from "@pierre/diffs";
import { MinusIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo } from "react";

import { buildFilePatchFromFileDiff, buildHunkPatchesFromFileDiff } from "~/lib/hunkPatch";
import { resolveFileDiffPath } from "~/lib/diffRendering";
import type { VcsRepositoryTarget } from "~/lib/sourceControlActions";
import { useVcsChangeActions } from "~/lib/sourceControlActions";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function stripRepositoryPrefix(displayPath: string, repositoryPath: string): string {
  const prefix =
    repositoryPath === "" || repositoryPath === "." ? "" : `${repositoryPath.replace(/\/+$/, "")}/`;
  if (!prefix) return displayPath;
  return displayPath.startsWith(prefix) ? displayPath.slice(prefix.length) : displayPath;
}

function fileDiffRelativeToRepository(
  fileDiff: FileDiffMetadata,
  repositoryPath: string,
): FileDiffMetadata {
  const path = resolveFileDiffPath(fileDiff);
  const relativePath = stripRepositoryPrefix(path, repositoryPath);
  const previous =
    fileDiff.prevName !== undefined
      ? stripRepositoryPrefix(fileDiff.prevName, repositoryPath)
      : undefined;
  if (relativePath === path && previous === fileDiff.prevName) return fileDiff;
  return {
    ...fileDiff,
    name: relativePath,
    ...(previous !== undefined ? { prevName: previous } : {}),
  };
}

export function DiffScmFileActions(props: {
  fileDiff: FileDiffMetadata;
  scope: "staged" | "unstaged";
  target: VcsRepositoryTarget;
  repositoryPath: string;
}) {
  const vcsActions = useVcsChangeActions();
  const relativeDiff = useMemo(
    () => fileDiffRelativeToRepository(props.fileDiff, props.repositoryPath),
    [props.fileDiff, props.repositoryPath],
  );
  const relativePath = resolveFileDiffPath(relativeDiff);
  const hunks = useMemo(() => buildHunkPatchesFromFileDiff(relativeDiff), [relativeDiff]);
  const filePatch = useMemo(() => buildFilePatchFromFileDiff(relativeDiff), [relativeDiff]);

  const runFile = (kind: "stage" | "unstage" | "discard") => {
    if (kind === "stage") void vcsActions.stagePaths(props.target, [relativePath]);
    else if (kind === "unstage") void vcsActions.unstagePaths(props.target, [relativePath]);
    else void vcsActions.discardPaths(props.target, [relativePath]);
  };

  const runHunk = (kind: "stage" | "unstage" | "discard", patch: string) => {
    const hunk = { path: relativePath, patch };
    if (kind === "stage") void vcsActions.stageHunk(props.target, hunk);
    else if (kind === "unstage") void vcsActions.unstageHunk(props.target, hunk);
    else void vcsActions.discardHunk(props.target, hunk);
  };

  if (props.scope === "unstaged") {
    return (
      <div className="ms-1 flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-micro"
                aria-label={`Stage ${relativePath}`}
                onClick={(event) => {
                  event.stopPropagation();
                  runFile("stage");
                }}
              >
                <PlusIcon className="size-3" />
              </Button>
            }
          />
          <TooltipPopup>Stage file</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-micro"
                aria-label={`Discard ${relativePath}`}
                onClick={(event) => {
                  event.stopPropagation();
                  if (window.confirm(`Discard changes in ${relativePath}?`)) {
                    runFile("discard");
                  }
                }}
              >
                <Trash2Icon className="size-3" />
              </Button>
            }
          />
          <TooltipPopup>Discard file</TooltipPopup>
        </Tooltip>
        {hunks.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="micro"
                  onClick={(event) => event.stopPropagation()}
                  aria-label="Hunk actions"
                >
                  Hunks
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="max-h-72 overflow-auto">
              {filePatch ? (
                <>
                  <DropdownMenuItem onClick={() => runHunk("stage", filePatch)}>
                    Stage all hunks
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              {hunks.map((hunk) => (
                <DropdownMenuItem key={hunk.index} onClick={() => runHunk("stage", hunk.patch)}>
                  Stage {hunk.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {hunks.map((hunk) => (
                <DropdownMenuItem
                  key={`discard-${hunk.index}`}
                  onClick={() => {
                    if (window.confirm("Discard this hunk?")) {
                      runHunk("discard", hunk.patch);
                    }
                  }}
                >
                  Discard {hunk.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    );
  }

  return (
    <div className="ms-1 flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-micro"
              aria-label={`Unstage ${relativePath}`}
              onClick={(event) => {
                event.stopPropagation();
                runFile("unstage");
              }}
            >
              <MinusIcon className="size-3" />
            </Button>
          }
        />
        <TooltipPopup>Unstage file</TooltipPopup>
      </Tooltip>
      {hunks.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="micro"
                onClick={(event) => event.stopPropagation()}
                aria-label="Hunk actions"
              >
                Hunks
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="max-h-72 overflow-auto">
            {filePatch ? (
              <>
                <DropdownMenuItem onClick={() => runHunk("unstage", filePatch)}>
                  Unstage all hunks
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            {hunks.map((hunk) => (
              <DropdownMenuItem key={hunk.index} onClick={() => runHunk("unstage", hunk.patch)}>
                Unstage {hunk.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
