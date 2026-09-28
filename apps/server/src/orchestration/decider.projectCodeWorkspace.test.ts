import { CommandId, EventId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);

it.layer(NodeServices.layer)("decider project code workspace", (it) => {
  it.effect("persists workspaceFile and repoRoots on project.create", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const readModel = createEmptyReadModel(now);

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-project-create-workspace"),
          projectId: asProjectId("project-workspace"),
          title: "Workspace",
          workspaceRoot: "/tmp/workspace-anchor",
          workspaceFile: "/tmp/workspace-anchor/app.code-workspace",
          repoRoots: ["/tmp/repo-a", "/tmp/repo-b"],
          createdAt: now,
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.created");
      if (event.type !== "project.created") {
        throw new Error("expected project.created");
      }
      expect(event.payload.workspaceFile).toBe("/tmp/workspace-anchor/app.code-workspace");
      expect(event.payload.repoRoots).toEqual(["/tmp/repo-a", "/tmp/repo-b"]);

      const projected = yield* projectEvent(readModel, {
        ...event,
        sequence: 1,
        eventId: asEventId("evt-project-create-workspace"),
        causationEventId: null,
        correlationId: event.commandId,
        metadata: {},
      });
      const project = projected.projects.find((entry) => entry.id === "project-workspace");
      expect(project?.workspaceFile).toBe("/tmp/workspace-anchor/app.code-workspace");
      expect(project?.repoRoots).toEqual(["/tmp/repo-a", "/tmp/repo-b"]);
    }),
  );

  it.effect("updates workspaceFile and repoRoots on project.meta.update", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const initial = createEmptyReadModel(now);
      const readModel = yield* projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-workspace-meta"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-workspace-meta"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-workspace-meta"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-workspace-meta"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-workspace-meta"),
          title: "Workspace",
          workspaceRoot: "/tmp/old-root",
          defaultModelSelection: null,
          workspaceFile: null,
          repoRoots: [],
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-link-workspace"),
          projectId: asProjectId("project-workspace-meta"),
          workspaceRoot: "/tmp/workspace-anchor",
          workspaceFile: "/tmp/workspace-anchor/app.code-workspace",
          repoRoots: ["/tmp/repo-a"],
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.meta-updated");
      if (event.type !== "project.meta-updated") {
        throw new Error("expected project.meta-updated");
      }
      expect(event.payload.workspaceRoot).toBe("/tmp/workspace-anchor");
      expect(event.payload.workspaceFile).toBe("/tmp/workspace-anchor/app.code-workspace");
      expect(event.payload.repoRoots).toEqual(["/tmp/repo-a"]);

      const projected = yield* projectEvent(readModel, {
        ...event,
        sequence: 2,
        eventId: asEventId("evt-project-link-workspace"),
        causationEventId: null,
        correlationId: event.commandId,
        metadata: {},
      });
      const project = projected.projects.find((entry) => entry.id === "project-workspace-meta");
      expect(project?.workspaceRoot).toBe("/tmp/workspace-anchor");
      expect(project?.workspaceFile).toBe("/tmp/workspace-anchor/app.code-workspace");
      expect(project?.repoRoots).toEqual(["/tmp/repo-a"]);
    }),
  );

  it.effect("clears workspace linkage when workspaceFile is null", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const initial = createEmptyReadModel(now);
      const readModel = yield* projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-workspace-unlink"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-workspace-unlink"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-workspace-unlink"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-workspace-unlink"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-workspace-unlink"),
          title: "Workspace",
          workspaceRoot: "/tmp/workspace-anchor",
          defaultModelSelection: null,
          workspaceFile: "/tmp/workspace-anchor/app.code-workspace",
          repoRoots: ["/tmp/repo-a"],
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-unlink-workspace"),
          projectId: asProjectId("project-workspace-unlink"),
          workspaceFile: null,
          repoRoots: [],
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.meta-updated");
      if (event.type !== "project.meta-updated") {
        throw new Error("expected project.meta-updated");
      }
      expect(event.payload.workspaceFile).toBeNull();
      expect(event.payload.repoRoots).toEqual([]);

      const projected = yield* projectEvent(readModel, {
        ...event,
        sequence: 2,
        eventId: asEventId("evt-project-unlink-workspace"),
        causationEventId: null,
        correlationId: event.commandId,
        metadata: {},
      });
      const project = projected.projects.find((entry) => entry.id === "project-workspace-unlink");
      expect(project?.workspaceFile).toBeNull();
      expect(project?.repoRoots).toEqual([]);
    }),
  );
});
