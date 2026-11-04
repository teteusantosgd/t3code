// @effect-diagnostics nodeBuiltinImport:off - FileSystem cannot create a FIFO.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const hostPlatform = HostProcess.Platform.defaultValue();

const layerProject = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(layerProject),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(layerTest, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("getMetadata", () => {
    it.effect("expands home-relative paths on the server", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const home = yield* makeTempDir;
        yield* writeTextFile(home, "file", "hello");
        expect(
          (yield* service
            .getMetadata({ paths: ["~/file"] })
            .pipe(Effect.provideService(HostProcess.HomeDirectory, home))).entries,
        ).toEqual([{ kind: "file", byteLength: 5 }]);
      }),
    );

    it.effect(
      "reports actual kinds for extensionless files, dotfiles, and dotted directories",
      () =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "custom-name", "hello");
          yield* writeTextFile(cwd, ".npmrc", "registry=test");
          yield* fs.makeDirectory(path.join(cwd, "folder.ts"));
          const file = path.join(cwd, "custom-name");
          const result = yield* service.getMetadata({
            paths: [
              file,
              path.join(cwd, ".npmrc"),
              path.join(cwd, "folder.ts"),
              file,
              path.join(cwd, "missing"),
              "relative-path",
            ],
          });
          expect(result.entries).toEqual([
            { kind: "file", byteLength: 5 },
            { kind: "file", byteLength: 13 },
            { kind: "directory" },
            { kind: "file", byteLength: 5 },
            null,
            null,
          ]);
        }),
    );

    it.effect("detects an extensionless script and image without returning their contents", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const script = "#!/usr/bin/env python3\nprint('hello')\n";
        yield* writeTextFile(cwd, "run", script);
        const image = path.join(cwd, "image");
        yield* fs.writeFile(
          image,
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );
        expect(
          (yield* service.getMetadata({ paths: [path.join(cwd, "run"), image] })).entries,
        ).toEqual([
          { kind: "file", byteLength: script.length, mimeType: "text/x-python" },
          { kind: "file", byteLength: 8, mimeType: "image/png" },
        ]);
      }),
    );

    it.effect.skipIf(!symlinksSupported)("follows file and directory symlinks", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "target", "text");
        yield* fs.makeDirectory(path.join(cwd, "directory"));
        const fileLink = path.join(cwd, "file-link");
        const directoryLink = path.join(cwd, "directory-link");
        yield* fs.symlink(path.join(cwd, "target"), fileLink);
        yield* fs.symlink(path.join(cwd, "directory"), directoryLink);
        expect((yield* service.getMetadata({ paths: [fileLink, directoryLink] })).entries).toEqual([
          { kind: "file", byteLength: 4 },
          { kind: "directory" },
        ]);
      }),
    );
  });

  describe("readFile", () => {
    it.effect.skipIf(!symlinksSupported)(
      "ignores symlinked dependency folders without making the source search incomplete",
      () =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const cwd = yield* makeTempDir;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* writeTextFile(cwd, "repo/src/file.ts", "source");
          yield* fs.symlink(path.join(cwd, "repo"), path.join(cwd, "node_modules"));
          expect(
            yield* service
              .readFile({
                cwd,
                relativePath: "src/file.ts",
                suggestAlternatives: true,
              })
              .pipe(Effect.result),
          ).toMatchObject({
            failure: {
              candidates: ["repo/src/file.ts"],
              candidatesTruncated: false,
            },
          });
        }),
    );

    it.effect("does not recover when the workspace itself is missing", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        expect(
          yield* service
            .readFile({
              cwd: path.join(cwd, "missing-root"),
              relativePath: "file.ts",
              suggestAlternatives: true,
            })
            .pipe(Effect.result),
        ).toMatchObject({
          failure: {
            _tag: "WorkspaceFileSystemOperationError",
            operation: "realpath-workspace-root",
          },
        });
      }),
    );

    it.effect.skipIf(hostPlatform === "win32" || process.getuid?.() === 0)(
      "keeps permission failures and marks unreadable subtrees as incomplete",
      () =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const cwd = yield* makeTempDir;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* writeTextFile(cwd, "denied/src/file.ts", "hidden duplicate");
          yield* writeTextFile(cwd, "repo/src/file.ts", "visible");
          const denied = path.join(cwd, "denied");
          yield* fs.chmod(denied, 0o000);
          const results = yield* Effect.gen(function* () {
            const unreadable = yield* service
              .readFile({
                cwd,
                relativePath: "denied/src/file.ts",
                suggestAlternatives: true,
              })
              .pipe(Effect.result);
            const incomplete = yield* service
              .readFile({
                cwd,
                relativePath: "src/file.ts",
                suggestAlternatives: true,
              })
              .pipe(Effect.result);
            return { unreadable, incomplete };
          }).pipe(Effect.ensuring(fs.chmod(denied, 0o755).pipe(Effect.orDie)));
          expect(results.unreadable).toMatchObject({
            failure: { _tag: "WorkspaceFileSystemOperationError" },
          });
          expect(results.incomplete).toMatchObject({
            failure: {
              candidates: ["repo/src/file.ts"],
              candidatesTruncated: true,
            },
          });
        }),
    );

    it.effect("keeps ordinary reads strict when suggestions were not requested", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "repo/src/file.ts", "other");
        const result = yield* service
          .readFile({ cwd, relativePath: "src/file.ts" })
          .pipe(Effect.result);
        expect(result).toMatchObject({ failure: { _tag: "WorkspaceFileSystemOperationError" } });
      }),
    );

    it.effect("matches the complete path suffix, including ignored repository files", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".gitignore", "ignored-repo/\n");
        yield* writeTextFile(cwd, "ignored-repo/src/file.ts", "wanted");
        yield* writeTextFile(cwd, "repo/other/file.ts", "same name");
        yield* writeTextFile(cwd, "repo/notsrc/file.ts", "partial segment");
        yield* writeTextFile(cwd, "repo/src/file.ts.bak", "different extension");
        const result = yield* service
          .readFile({
            cwd,
            relativePath: "./src/file.ts",
            suggestAlternatives: true,
          })
          .pipe(Effect.result);
        expect(result).toMatchObject({
          failure: {
            candidates: ["ignored-repo/src/file.ts"],
            candidatesTruncated: false,
          },
        });
      }),
    );

    it.effect.each(["源 código/ação #100%.cs", ".env", "README", "src/MixedCase.ts"])(
      "recovers the literal filename %s",
      (relativePath) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, `repo/${relativePath}`, "file");
          const result = yield* service
            .readFile({ cwd, relativePath, suggestAlternatives: true })
            .pipe(Effect.result);
          expect(result).toMatchObject({
            failure: {
              candidates: [`repo/${relativePath}`],
              candidatesTruncated: false,
            },
          });
        }),
    );

    it.effect("offers no unrelated file or directory when no suffix matches", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "repo/src/FILE.ts", "case differs");
        yield* fs.makeDirectory(path.join(cwd, "directory/src/file.ts"), { recursive: true });
        const result = yield* service
          .readFile({
            cwd,
            relativePath: "src/file.ts",
            suggestAlternatives: true,
          })
          .pipe(Effect.result);
        expect(result).toMatchObject({ failure: { candidates: [], candidatesTruncated: false } });
      }),
    );

    it.effect("excludes dependency and Git internals from suggestions", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        for (const prefix of [".git", "node_modules", "repo/.git", "repo/node_modules"]) {
          yield* writeTextFile(cwd, `${prefix}/src/file.ts`, "internal");
        }
        yield* writeTextFile(cwd, "repo/src/file.ts", "source");
        const result = yield* service
          .readFile({
            cwd,
            relativePath: "src/file.ts",
            suggestAlternatives: true,
          })
          .pipe(Effect.result);
        expect(result).toMatchObject({
          failure: {
            candidates: ["repo/src/file.ts"],
            candidatesTruncated: false,
          },
        });
      }),
    );

    it.effect("never redirects an absolute missing host path or a parent-relative path", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "repo/src/file.ts", "file");
        const absolute = yield* service
          .readFile({
            cwd,
            relativePath: path.join(cwd, "src/file.ts"),
            suggestAlternatives: true,
          })
          .pipe(Effect.result);
        expect(absolute).toMatchObject({ failure: { _tag: "WorkspaceFileSystemOperationError" } });
        const traversal = yield* service
          .readFile({
            cwd,
            relativePath: "../src/file.ts",
            suggestAlternatives: true,
          })
          .pipe(Effect.result);
        expect(traversal).toMatchObject({ failure: { _tag: "WorkspacePathOutsideRootError" } });
        const explicitParent = yield* service
          .readFile({
            cwd,
            relativePath: "repo/../src/file.ts",
            suggestAlternatives: true,
          })
          .pipe(Effect.result);
        expect(explicitParent).toMatchObject({
          failure: { _tag: "WorkspaceFileSystemOperationError" },
        });
      }),
    );

    it.effect("keeps directory and binary failures instead of recovering another copy", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(cwd, "src/file.ts"), { recursive: true });
        yield* writeTextFile(cwd, "repo/src/file.ts", "other");
        expect(
          yield* service
            .readFile({
              cwd,
              relativePath: "src/file.ts",
              suggestAlternatives: true,
            })
            .pipe(Effect.result),
        ).toMatchObject({ failure: { _tag: "WorkspacePathNotFileError" } });
        yield* writeTextFile(cwd, "binary.dat", "\0binary");
        yield* writeTextFile(cwd, "repo/binary.dat", "text copy");
        expect(
          yield* service
            .readFile({
              cwd,
              relativePath: "binary.dat",
              suggestAlternatives: true,
            })
            .pipe(Effect.result),
        ).toMatchObject({ failure: { _tag: "WorkspaceBinaryFileError" } });
      }),
    );

    it.effect("bounds the number of candidates without claiming the search was complete", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        for (let index = 0; index < 21; index++) {
          yield* writeTextFile(cwd, `repo-${index}/src/file.ts`, "copy");
        }
        const result = yield* service
          .readFile({
            cwd,
            relativePath: "src/file.ts",
            suggestAlternatives: true,
          })
          .pipe(Effect.result);
        expect(result).toMatchObject({
          failure: {
            _tag: "WorkspaceFileNotFoundError",
            candidates: expect.any(Array),
            candidatesTruncated: true,
          },
        });
        if ("failure" in result && result.failure._tag === "WorkspaceFileNotFoundError") {
          expect(result.failure.candidates).toHaveLength(20);
        }
      }),
    );

    it.effect("marks a directory-limited search as incomplete", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* Effect.forEach(
          Array.from({ length: 513 }, (_, index) => index),
          (index) => fs.makeDirectory(path.join(cwd, `directory-${index}`)),
          { concurrency: 16 },
        );
        expect(
          yield* service
            .readFile({
              cwd,
              relativePath: "src/file.ts",
              suggestAlternatives: true,
            })
            .pipe(Effect.result),
        ).toMatchObject({ failure: { candidatesTruncated: true } });
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "does not follow directory symlinks or suggest files outside the workspace",
      () =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const cwd = yield* makeTempDir;
          const outside = yield* makeTempDir;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* writeTextFile(outside, "file.ts", "outside");
          yield* fs.makeDirectory(path.join(cwd, "repo/src"), { recursive: true });
          yield* fs.symlink(path.join(outside, "file.ts"), path.join(cwd, "repo/src/file.ts"));
          const escaped = yield* service
            .readFile({
              cwd,
              relativePath: "src/file.ts",
              suggestAlternatives: true,
            })
            .pipe(Effect.result);
          expect(escaped).toMatchObject({
            failure: { candidates: [], candidatesTruncated: false },
          });
          yield* writeTextFile(cwd, "inside/src/file.ts", "inside");
          yield* fs.symlink(cwd, path.join(cwd, "loop"));
          expect(
            yield* service
              .readFile({
                cwd,
                relativePath: "src/file.ts",
                suggestAlternatives: true,
              })
              .pipe(Effect.result),
          ).toMatchObject({
            failure: {
              candidates: ["inside/src/file.ts"],
              candidatesTruncated: true,
            },
          });
        }),
    );

    it.effect("suggests a nested repository file without silently reading it", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "wssanvipark/WSSanviPark/ControleVersao.asmx.cs", "master");
        const result = yield* service
          .readFile({
            cwd,
            relativePath: "WSSanviPark/ControleVersao.asmx.cs",
            suggestAlternatives: true,
          })
          .pipe(Effect.result);
        expect(result).toMatchObject({
          failure: {
            _tag: "WorkspaceFileNotFoundError",
            candidates: ["wssanvipark/WSSanviPark/ControleVersao.asmx.cs"],
            candidatesTruncated: false,
          },
        });
      }),
    );

    it.effect("keeps copies in different repositories ambiguous", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "repo/src/file.ts", "main");
        yield* writeTextFile(cwd, "worktree/src/file.ts", "branch");
        const result = yield* service
          .readFile({
            cwd,
            relativePath: "src/file.ts",
            suggestAlternatives: true,
          })
          .pipe(Effect.result);
        expect(result).toMatchObject({
          failure: {
            _tag: "WorkspaceFileNotFoundError",
            candidates: ["repo/src/file.ts", "worktree/src/file.ts"],
            candidatesTruncated: false,
          },
        });
      }),
    );

    it.effect("prioritizes the requested file over nested copies", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/file.ts", "requested");
        yield* writeTextFile(cwd, "repo/src/file.ts", "other");
        expect(
          yield* service.readFile({
            cwd,
            relativePath: "src/file.ts",
            suggestAlternatives: true,
          }),
        ).toMatchObject({ relativePath: "src/file.ts", contents: "requested" });
      }),
    );

    it.effect("reads UTF-8 files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/index.ts",
        });

        expect(result).toEqual({
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
        });
      }),
    );

    it.effect("reads host files outside the workspace root by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "cleanup-report.md", "# Report\n");
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: absolutePath,
        });

        expect(result).toEqual({
          relativePath: absolutePath,
          contents: "# Report\n",
          byteLength: 9,
          truncated: false,
        });
      }),
    );

    // Needs mkfifo; Windows has no FIFOs to reject.
    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "rejects a FIFO without blocking on open",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          const fifoPath = path.join(outsideDir, "pipe");
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) =>
                NodeChildProcess.execFile("mkfifo", [fifoPath], (error) =>
                  error ? reject(error) : resolve(),
                ),
              ),
          );

          const error = yield* workspaceFileSystem
            .readFile({ cwd, relativePath: fifoPath })
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
          expect((yield* workspaceFileSystem.getMetadata({ paths: [fifoPath] })).entries).toEqual([
            { kind: "other" },
          ]);
        }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "../escape.md" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects symlinks that resolve outside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
          yield* fileSystem.symlink(
            path.join(outsideDir, "secret.txt"),
            path.join(cwd, "linked-secret.txt"),
          );

          const error = yield* workspaceFileSystem
            .readFile({ cwd, relativePath: "linked-secret.txt" })
            .pipe(Effect.flip);
          const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
          const resolvedPath = yield* fileSystem.realPath(path.join(outsideDir, "secret.txt"));

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(error).toMatchObject({
            workspaceRoot: cwd,
            relativePath: "linked-secret.txt",
            resolvedWorkspaceRoot,
            resolvedPath,
          });
          expect("cause" in error).toBe(false);
        }),
    );

    it.effect("rejects directories without manufacturing an I/O cause", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "src" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(path.join(cwd, "src"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "src",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects binary files without leaking their contents into the error", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "asset.bin");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0x61, 0, 0x62]));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "asset.bin" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(absolutePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "asset.bin",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
        expect("contents" in error).toBe(false);
      }),
    );

    it.effect("preserves the real cause and path for I/O failures", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const resolvedPath = path.join(cwd, "missing.txt");

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "missing.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "missing.txt",
          resolvedPath,
          operationPath: resolvedPath,
          operation: "realpath-target",
        });
        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("rejects writes by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: absolutePath, contents: "# Edited\n" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "plans/effect-rpc.md")).toBe(
          false,
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.list({ cwd });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );
  });
});
