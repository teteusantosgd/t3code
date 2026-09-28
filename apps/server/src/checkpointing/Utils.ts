import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, type ThreadId } from "@t3tools/contracts";

const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
    readonly repoRoots?: ReadonlyArray<string>;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  const project = input.projects.find((candidate) => candidate.id === input.thread.projectId);
  if (!project) {
    return undefined;
  }
  // Code workspaces store the `.code-workspace` anchor separately; agents should
  // launch in the first repo folder when one is configured.
  return project.repoRoots?.[0] ?? project.workspaceRoot;
}
