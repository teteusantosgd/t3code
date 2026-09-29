import { useAtomValue } from "@effect/atom-react";
import type {
  AtomCommandFailure,
  AtomCommandResult,
  AtomCommandSuccess,
} from "@t3tools/client-runtime/state/runtime";
import {
  VcsActionUnavailableError,
  type VcsActionOperation,
} from "@t3tools/client-runtime/state/vcs";
import type {
  EnvironmentId,
  GitActionProgressEvent,
  GitResolvePullRequestResult,
  GitStackedAction,
  SourceControlCloneProtocol,
  SourceControlRepositoryVisibility,
  ThreadId,
  VcsStashInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { gitEnvironment } from "./git";
import { useEnvironmentQuery } from "./query";
import { sourceControlEnvironment } from "./sourceControl";
import { useAtomCommand } from "./use-atom-command";
import { vcsActionManager, vcsEnvironment } from "./vcs";

export type SourceControlActionKind =
  | "init"
  | "pull"
  | "publishRepository"
  | "runStackedAction"
  | "preparePullRequestThread";

export interface SourceControlActionScope {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

interface SourceControlActionState<
  TArgs extends ReadonlyArray<unknown>,
  R extends AtomCommandResult<unknown, unknown>,
> {
  readonly isPending: boolean;
  readonly error: unknown;
  readonly run: (
    ...args: TArgs
  ) => Promise<
    AtomCommandResult<AtomCommandSuccess<R>, AtomCommandFailure<R> | VcsActionUnavailableError>
  >;
  readonly resetError: () => void;
}

const ACTION_OPERATION = {
  init: "init",
  pull: "pull",
  publishRepository: "publish_repository",
  runStackedAction: "run_change_request",
  preparePullRequestThread: "prepare_pull_request_thread",
} as const satisfies Record<SourceControlActionKind, VcsActionOperation>;

function useAction<
  TArgs extends ReadonlyArray<unknown>,
  R extends AtomCommandResult<unknown, unknown>,
>(input: {
  readonly kind: SourceControlActionKind;
  readonly label: string;
  readonly scope: SourceControlActionScope;
  readonly action: (...args: TArgs) => Promise<R>;
  readonly onSuccess?: () => void;
  readonly managedExternally?: boolean;
}): SourceControlActionState<TArgs, R> {
  const operation = ACTION_OPERATION[input.kind];
  const state = useAtomValue(vcsActionManager.stateAtom(input.scope));
  const ownsState = state.operation === operation;

  const resetError = useCallback(() => {
    vcsActionManager.resetError(appAtomRegistry, input.scope, operation);
  }, [input.scope, operation]);

  const run = useCallback(
    async (...args: TArgs) => {
      const execute = async (): Promise<
        AtomCommandResult<AtomCommandSuccess<R>, AtomCommandFailure<R>>
      > => {
        const result = await input.action(...args);
        if (AsyncResult.isSuccess(result)) {
          input.onSuccess?.();
        }
        return result as AtomCommandResult<AtomCommandSuccess<R>, AtomCommandFailure<R>>;
      };
      return input.managedExternally === true
        ? execute()
        : vcsActionManager.track(
            appAtomRegistry,
            input.scope,
            {
              operation,
              label: input.label,
            },
            execute,
          );
    },
    [input.action, input.label, input.managedExternally, input.onSuccess, input.scope, operation],
  );

  return {
    error: ownsState ? state.error : null,
    isPending: ownsState && state.isRunning,
    resetError,
    run,
  };
}

function resolveScope(scope: SourceControlActionScope) {
  if (scope.environmentId === null || scope.cwd === null) {
    return null;
  }
  return {
    environmentId: scope.environmentId,
    cwd: scope.cwd,
  };
}

export function useSourceControlActionRunning(
  scope: SourceControlActionScope,
  kinds: ReadonlyArray<SourceControlActionKind>,
): boolean {
  const state = useAtomValue(vcsActionManager.stateAtom(scope));
  return (
    state.isRunning &&
    state.operation !== null &&
    kinds.some((kind) => ACTION_OPERATION[kind] === state.operation)
  );
}

export function useVcsInitAction(scope: SourceControlActionScope) {
  const init = useAtomCommand(vcsEnvironment.init, { reportFailure: false });
  const action = useCallback(async () => {
    const target = resolveScope(scope);
    if (target === null) {
      return AsyncResult.failure<never, VcsActionUnavailableError>(
        Cause.fail(
          new VcsActionUnavailableError({
            operation: "init",
            environmentId: scope.environmentId,
            cwd: scope.cwd,
          }),
        ),
      );
    }
    return init({
      environmentId: target.environmentId,
      input: { cwd: target.cwd },
    });
  }, [init, scope]);
  return useAction({ kind: "init", label: "Initializing repository", scope, action });
}

export function useVcsPullAction(scope: SourceControlActionScope) {
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const status = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );
  const action = useCallback(async () => {
    const target = resolveScope(scope);
    if (target === null) {
      return AsyncResult.failure<never, VcsActionUnavailableError>(
        Cause.fail(
          new VcsActionUnavailableError({
            operation: "pull",
            environmentId: scope.environmentId,
            cwd: scope.cwd,
          }),
        ),
      );
    }
    return pull({
      environmentId: target.environmentId,
      input: { cwd: target.cwd },
    });
  }, [pull, scope]);
  return useAction({
    kind: "pull",
    label: "Pulling latest changes",
    scope,
    action,
    onSuccess: status.refresh,
  });
}

export interface VcsRepositoryTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

/**
 * Source Control mutations for a surface that spans several checkouts: the
 * repository travels with each call, so one hook instance serves every
 * repository a panel renders. Each mutation asks the server to recompute the
 * status it just invalidated, because the index changed underneath the
 * subscription rather than the working tree.
 *
 * Long-running actions (commit, pull, publish) belong in the scope-based hooks
 * above: they take over the shared source-control action state that the branch
 * toolbar renders, while staging a file is not an action a user waits on.
 */
export function useVcsChangeActions() {
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const stagePaths = useAtomCommand(vcsEnvironment.stagePaths, { reportFailure: false });
  const unstagePaths = useAtomCommand(vcsEnvironment.unstagePaths, { reportFailure: false });
  const discardPaths = useAtomCommand(vcsEnvironment.discardPaths, { reportFailure: false });
  const stageHunk = useAtomCommand(vcsEnvironment.stageHunk, { reportFailure: false });
  const unstageHunk = useAtomCommand(vcsEnvironment.unstageHunk, { reportFailure: false });
  const discardHunk = useAtomCommand(vcsEnvironment.discardHunk, { reportFailure: false });
  const stash = useAtomCommand(vcsEnvironment.stash, { reportFailure: false });
  const amendCommit = useAtomCommand(vcsEnvironment.amendCommit, { reportFailure: false });
  const undoLastCommit = useAtomCommand(vcsEnvironment.undoLastCommit, { reportFailure: false });
  const push = useAtomCommand(vcsEnvironment.push, { reportFailure: false });
  const sync = useAtomCommand(vcsEnvironment.sync, { reportFailure: false });

  const settle = useCallback(
    async <R extends AtomCommandResult<unknown, unknown>>(
      target: VcsRepositoryTarget,
      run: () => Promise<R>,
    ) => {
      const result = await run();
      void refreshStatus({
        environmentId: target.environmentId,
        input: { cwd: target.cwd },
      });
      return result;
    },
    [refreshStatus],
  );

  return {
    stagePaths: useCallback(
      (target: VcsRepositoryTarget, paths: ReadonlyArray<string>) =>
        settle(target, () =>
          stagePaths({ environmentId: target.environmentId, input: { cwd: target.cwd, paths } }),
        ),
      [settle, stagePaths],
    ),
    unstagePaths: useCallback(
      (target: VcsRepositoryTarget, paths: ReadonlyArray<string>) =>
        settle(target, () =>
          unstagePaths({ environmentId: target.environmentId, input: { cwd: target.cwd, paths } }),
        ),
      [settle, unstagePaths],
    ),
    discardPaths: useCallback(
      (target: VcsRepositoryTarget, paths: ReadonlyArray<string>) =>
        settle(target, () =>
          discardPaths({ environmentId: target.environmentId, input: { cwd: target.cwd, paths } }),
        ),
      [settle, discardPaths],
    ),
    stageHunk: useCallback(
      (target: VcsRepositoryTarget, hunk: { path: string; patch: string }) =>
        settle(target, () =>
          stageHunk({ environmentId: target.environmentId, input: { cwd: target.cwd, ...hunk } }),
        ),
      [settle, stageHunk],
    ),
    unstageHunk: useCallback(
      (target: VcsRepositoryTarget, hunk: { path: string; patch: string }) =>
        settle(target, () =>
          unstageHunk({ environmentId: target.environmentId, input: { cwd: target.cwd, ...hunk } }),
        ),
      [settle, unstageHunk],
    ),
    discardHunk: useCallback(
      (target: VcsRepositoryTarget, hunk: { path: string; patch: string }) =>
        settle(target, () =>
          discardHunk({ environmentId: target.environmentId, input: { cwd: target.cwd, ...hunk } }),
        ),
      [settle, discardHunk],
    ),
    stash: useCallback(
      (target: VcsRepositoryTarget, input: Omit<VcsStashInput, "cwd">) =>
        settle(target, () =>
          stash({ environmentId: target.environmentId, input: { cwd: target.cwd, ...input } }),
        ),
      [settle, stash],
    ),
    amendCommit: useCallback(
      (target: VcsRepositoryTarget, commitMessage?: string) =>
        settle(target, () =>
          amendCommit({
            environmentId: target.environmentId,
            input: {
              cwd: target.cwd,
              ...(commitMessage?.trim() ? { commitMessage: commitMessage.trim() } : {}),
            },
          }),
        ),
      [settle, amendCommit],
    ),
    undoLastCommit: useCallback(
      (target: VcsRepositoryTarget) =>
        settle(target, () =>
          undoLastCommit({ environmentId: target.environmentId, input: { cwd: target.cwd } }),
        ),
      [settle, undoLastCommit],
    ),
    push: useCallback(
      (target: VcsRepositoryTarget) =>
        settle(target, () =>
          push({ environmentId: target.environmentId, input: { cwd: target.cwd } }),
        ),
      [settle, push],
    ),
    sync: useCallback(
      (target: VcsRepositoryTarget) =>
        settle(target, () =>
          sync({ environmentId: target.environmentId, input: { cwd: target.cwd } }),
        ),
      [settle, sync],
    ),
  };
}

export function useGitStackedAction(scope: SourceControlActionScope) {
  const runStackedAction = useAtomCommand(vcsActionManager.runStackedAction(scope), {
    reportFailure: false,
  });
  const status = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );

  const action = useCallback(
    async (input: {
      actionId: string;
      action: GitStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
      filePaths?: string[];
      threadId?: ThreadId;
      onProgress?: (event: GitActionProgressEvent) => void;
    }) => {
      if (resolveScope(scope) === null) {
        return AsyncResult.failure<never, VcsActionUnavailableError>(
          Cause.fail(
            new VcsActionUnavailableError({
              operation: "run_change_request",
              environmentId: scope.environmentId,
              cwd: scope.cwd,
            }),
          ),
        );
      }
      return runStackedAction({
        actionId: input.actionId,
        action: input.action,
        ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
        ...(input.featureBranch ? { featureBranch: true } : {}),
        ...(input.filePaths?.length ? { filePaths: input.filePaths } : {}),
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      });
    },
    [runStackedAction, scope],
  );

  return useAction({
    kind: "runStackedAction",
    label: "Running source control action",
    scope,
    action,
    onSuccess: status.refresh,
    managedExternally: true,
  });
}

export function useSourceControlPublishRepositoryAction(scope: SourceControlActionScope) {
  const publishRepository = useAtomCommand(sourceControlEnvironment.publishRepository, {
    reportFailure: false,
  });
  const status = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );
  const action = useCallback(
    async (input: {
      provider: "github" | "gitlab" | "forgejo" | "bitbucket" | "azure-devops";
      repository: string;
      visibility: SourceControlRepositoryVisibility;
      remoteName: string;
      protocol: SourceControlCloneProtocol;
    }) => {
      const target = resolveScope(scope);
      if (target === null) {
        return AsyncResult.failure<never, VcsActionUnavailableError>(
          Cause.fail(
            new VcsActionUnavailableError({
              operation: "publish_repository",
              environmentId: scope.environmentId,
              cwd: scope.cwd,
            }),
          ),
        );
      }
      return publishRepository({
        environmentId: target.environmentId,
        input: {
          cwd: target.cwd,
          ...input,
        },
      });
    },
    [publishRepository, scope],
  );
  return useAction({
    kind: "publishRepository",
    label: "Publishing repository",
    scope,
    action,
    onSuccess: status.refresh,
  });
}

export function usePreparePullRequestThreadAction(scope: SourceControlActionScope) {
  const preparePullRequestThread = useAtomCommand(gitEnvironment.preparePullRequestThread, {
    reportFailure: false,
  });
  const action = useCallback(
    async (input: { reference: string; mode: "local" | "worktree"; threadId?: ThreadId }) => {
      const target = resolveScope(scope);
      if (target === null) {
        return AsyncResult.failure<never, VcsActionUnavailableError>(
          Cause.fail(
            new VcsActionUnavailableError({
              operation: "prepare_pull_request_thread",
              environmentId: scope.environmentId,
              cwd: scope.cwd,
            }),
          ),
        );
      }
      return preparePullRequestThread({
        environmentId: target.environmentId,
        input: {
          cwd: target.cwd,
          reference: input.reference,
          mode: input.mode,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
      });
    },
    [preparePullRequestThread, scope],
  );
  return useAction({
    kind: "preparePullRequestThread",
    label: "Preparing pull request thread",
    scope,
    action,
  });
}

export interface PullRequestResolutionTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string | null;
}

export function readCachedPullRequestResolution(
  target: PullRequestResolutionTarget,
): GitResolvePullRequestResult | null {
  if (target.environmentId === null || target.cwd === null || target.reference === null) {
    return null;
  }
  return Option.getOrNull(
    AsyncResult.value(
      appAtomRegistry.get(
        gitEnvironment.pullRequestResolution({
          environmentId: target.environmentId,
          input: { cwd: target.cwd, reference: target.reference },
        }),
      ),
    ),
  );
}

export function usePullRequestResolutionState(target: PullRequestResolutionTarget) {
  const query = useEnvironmentQuery(
    target.environmentId !== null && target.cwd !== null && target.reference !== null
      ? gitEnvironment.pullRequestResolution({
          environmentId: target.environmentId,
          input: {
            cwd: target.cwd,
            reference: target.reference,
          },
        })
      : null,
  );
  const cached = readCachedPullRequestResolution(target);

  return {
    data: query.data ?? cached,
    error: query.error,
    isPending: query.isPending && cached === null,
    isFetching: query.isPending,
    refresh: query.refresh,
  };
}
