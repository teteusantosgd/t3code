import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";

import { resolveThreadWorkspaceCwd } from "./Utils.ts";

describe("resolveThreadWorkspaceCwd", () => {
  it("prefers the first repo root over the workspace anchor", () => {
    const projectId = ProjectId.make("project-code-workspace");
    const cwd = resolveThreadWorkspaceCwd({
      thread: { projectId, worktreePath: null },
      projects: [
        {
          id: projectId,
          workspaceRoot: "/tmp/workspace-anchor",
          repoRoots: ["/tmp/repo-a", "/tmp/repo-b"],
        },
      ],
    });
    assert.equal(cwd, "/tmp/repo-a");
  });

  it("keeps worktree cwd ahead of repo roots", () => {
    const projectId = ProjectId.make("project-code-workspace");
    const cwd = resolveThreadWorkspaceCwd({
      thread: { projectId, worktreePath: "/tmp/worktree" },
      projects: [
        {
          id: projectId,
          workspaceRoot: "/tmp/workspace-anchor",
          repoRoots: ["/tmp/repo-a"],
        },
      ],
    });
    assert.equal(cwd, "/tmp/worktree");
  });

  it("falls back to workspaceRoot when repoRoots is empty", () => {
    const projectId = ProjectId.make("project-single");
    const cwd = resolveThreadWorkspaceCwd({
      thread: { projectId, worktreePath: null },
      projects: [
        {
          id: projectId,
          workspaceRoot: "/tmp/single",
          repoRoots: [],
        },
      ],
    });
    assert.equal(cwd, "/tmp/single");
  });
});
