/**
 * CodeWorkspaceFile - parse VS Code `.code-workspace` files into project roots.
 *
 * Resolves `folders[]` against the file's directory, expands `~`, and classifies
 * each entry as present/missing and git/non-git. Missing folders are surfaced
 * rather than failing the whole read so the UI can warn before create/link.
 *
 * @module CodeWorkspaceFile
 */
import type { ProjectResolveCodeWorkspaceResult } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePathWith } from "../pathExpansion.ts";

const FOLDER_RESOLVE_CONCURRENCY = 16;

const CodeWorkspaceFolderEntry = Schema.Struct({
  path: Schema.String,
  name: Schema.optional(Schema.String),
});

const decodeDocument = Schema.decodeUnknownEffect(fromLenientJson(Schema.Unknown));
const decodeFolders = Schema.decodeUnknownEffect(Schema.Array(CodeWorkspaceFolderEntry));

export class CodeWorkspaceFileError extends Schema.TaggedError<CodeWorkspaceFileError>()(
  "CodeWorkspaceFileError",
  {
    workspaceFilePath: Schema.String,
    failure: Schema.Literals(["read_failed", "parse_failed", "invalid_folders"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve code workspace '${this.workspaceFilePath}' (${this.failure}).`;
  }
}

export type ResolvedCodeWorkspace = ProjectResolveCodeWorkspaceResult;

export class CodeWorkspaceFile extends Context.Service<
  CodeWorkspaceFile,
  {
    readonly read: (
      workspaceFilePath: string,
    ) => Effect.Effect<ResolvedCodeWorkspace, CodeWorkspaceFileError>;
  }
>()("t3/workspace/CodeWorkspaceFile") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const hasGitMarker = (absolutePath: string) =>
    fileSystem.stat(path.join(absolutePath, ".git")).pipe(
      Effect.map(() => true),
      Effect.orElseSucceed(() => false),
    );

  const directoryExists = (absolutePath: string) =>
    fileSystem.stat(absolutePath).pipe(
      Effect.map((stat) => stat.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const read: CodeWorkspaceFile["Service"]["read"] = Effect.fn("CodeWorkspaceFile.read")(
    function* (workspaceFilePath) {
      const absoluteFilePath = path.resolve(expandHomePathWith(workspaceFilePath.trim(), path));
      const anchorDir = path.dirname(absoluteFilePath);

      const raw = yield* fileSystem.readFileString(absoluteFilePath).pipe(
        Effect.mapError(
          (cause) =>
            new CodeWorkspaceFileError({
              workspaceFilePath,
              failure: "read_failed",
              cause,
            }),
        ),
      );

      const document = yield* decodeDocument(raw).pipe(
        Effect.mapError(
          (cause) =>
            new CodeWorkspaceFileError({
              workspaceFilePath,
              failure: "parse_failed",
              cause,
            }),
        ),
      );

      const foldersInput =
        typeof document === "object" && document !== null && "folders" in document
          ? ((document as { folders: unknown }).folders ?? [])
          : [];

      const folderEntries = yield* decodeFolders(foldersInput).pipe(
        Effect.mapError(
          (cause) =>
            new CodeWorkspaceFileError({
              workspaceFilePath,
              failure: "invalid_folders",
              cause,
            }),
        ),
      );

      const folders = yield* Effect.forEach(
        folderEntries,
        (entry) =>
          Effect.gen(function* () {
            const trimmed = entry.path.trim();
            const expanded = expandHomePathWith(trimmed, path);
            const absolutePath = path.isAbsolute(expanded)
              ? path.resolve(expanded)
              : path.resolve(anchorDir, expanded);
            const exists = yield* directoryExists(absolutePath);
            const isGit = exists ? yield* hasGitMarker(absolutePath) : false;
            return {
              rawPath: entry.path,
              name: entry.name?.trim() || path.basename(absolutePath) || absolutePath,
              absolutePath,
              exists,
              isGit,
            };
          }),
        { concurrency: FOLDER_RESOLVE_CONCURRENCY },
      );

      const repoRoots = folders
        .filter((folder) => folder.exists && folder.isGit)
        .map((folder) => folder.absolutePath);

      return {
        workspaceFilePath: absoluteFilePath,
        anchorDir,
        folders,
        repoRoots,
      };
    },
  );

  return CodeWorkspaceFile.of({ read });
});

export const layer = Layer.effect(CodeWorkspaceFile, make);
