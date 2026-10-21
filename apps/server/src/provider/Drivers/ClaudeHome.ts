import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));
type ClaudeHomeSettings = Pick<ClaudeSettings, "homePath"> &
  Partial<Pick<ClaudeSettings, "shadowConfigPath">>;

/**
 * Resolve the Claude config directory the CLI would use: the instance's
 * `homePath` (exported as `CLAUDE_CONFIG_DIR`), then an inherited
 * `CLAUDE_CONFIG_DIR`, then Claude's default `~/.claude`. Empty must not
 * fall back to bare `$HOME` — that leftover from the old HOME override
 * produced a different continuation group than an explicit `~/.claude`.
 */
export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(home, ".claude"));
});

interface ClaudeHomeLayout {
  readonly mode: "direct" | "authOverlay";
  /** The config directory whose `projects/` holds the shared session state. */
  readonly sharedConfigPath: string;
  /** The config directory exported as `CLAUDE_CONFIG_DIR` to the CLI. */
  readonly effectiveConfigPath: string;
  /**
   * Continuation follows the shared config path, never the shadow: two
   * instances that share `homePath` but keep separate shadow paths resume
   * each other's sessions, like Codex instances sharing a home.
   */
  readonly continuationKey: string;
}

export const resolveClaudeHomeLayout = Effect.fn("resolveClaudeHomeLayout")(function* (
  config: ClaudeHomeSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ClaudeHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const sharedConfigPath = yield* resolveClaudeHomePath(config, environment);
  const shadowConfigPath = config.shadowConfigPath?.trim() ?? "";
  if (shadowConfigPath.length === 0) {
    return {
      mode: "direct",
      sharedConfigPath,
      effectiveConfigPath: sharedConfigPath,
      continuationKey: `claude:home:${sharedConfigPath}`,
    };
  }
  const effectiveConfigPath = path.resolve(expandHomePath(shadowConfigPath, home));
  return {
    mode: "authOverlay",
    sharedConfigPath,
    effectiveConfigPath,
    continuationKey: `claude:home:${sharedConfigPath}`,
  };
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: ClaudeHomeSettings,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  const shadowConfigPath = config.shadowConfigPath?.trim() ?? "";
  if (homePath.length === 0 && shadowConfigPath.length === 0) return resolvedBaseEnv;
  const layout = yield* resolveClaudeHomeLayout(config, resolvedBaseEnv);
  return {
    ...resolvedBaseEnv,
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact. In shadow mode this is the shadow path: sign-in is
    // keyed to it, while `projects/` inside links back to the shared home.
    CLAUDE_CONFIG_DIR: layout.effectiveConfigPath,
  };
});

/**
 * Whether an administrator installed Claude Code's `managed-mcp.json`. While it
 * exists Claude refuses `--strict-mcp-config` and exits before initializing,
 * but it already ignores user, project and `--mcp-config` servers on its own,
 * so callers that pass the flag for isolation can drop it. Paths match the
 * ones Claude Code checks.
 */
export const hasClaudeManagedMcpConfig = Effect.fn("hasClaudeManagedMcpConfig")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const managedMcpConfigPath =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-mcp.json"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode\\managed-mcp.json"
        : "/etc/claude-code/managed-mcp.json";
  return yield* fileSystem.exists(managedMcpConfigPath).pipe(Effect.orElseSucceed(() => false));
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: ClaudeHomeSettings,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const layout = yield* resolveClaudeHomeLayout(config, environment);
    return layout.continuationKey;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: ClaudeHomeSettings & Pick<ClaudeSettings, "binaryPath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    // Capabilities describe the account's login, so they cache on the
    // effective config path, not the shared one.
    const layout = yield* resolveClaudeHomeLayout(config, environment);
    return `${config.binaryPath}\0${layout.effectiveConfigPath}\0${cwd ?? ""}`;
  },
);

/**
 * Describe the spawned CLI's environment separately from the login command so
 * paths remain literal on every shell, including relative inherited values.
 */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};

/** Claude keeps transcripts and project memory together under `projects/`. */
const SHARED_ENTRY_NAMES = ["projects"] as const;
/** Entries that must stay real files in the shadow, never links into the shared home. */
const PRIVATE_ENTRY_NAMES = new Set([".claude.json", ".credentials.json"]);

const ClaudeShadowConfigContext = {
  sharedConfigPath: Schema.String,
  effectiveConfigPath: Schema.String,
};

class ClaudeShadowConfigFileSystemError extends Schema.TaggedError<ClaudeShadowConfigFileSystemError>()(
  "ClaudeShadowConfigFileSystemError",
  {
    ...ClaudeShadowConfigContext,
    operation: Schema.Literals(["readLink", "realPath", "makeDirectory", "remove", "symlink"]),
    path: Schema.String,
    targetPath: Schema.optional(Schema.String),
    entryName: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const targetPath = this.targetPath === undefined ? "" : ` to '${this.targetPath}'`;
    return `Claude shadow config filesystem operation '${this.operation}' failed for '${this.path}'${targetPath}.`;
  }
}

class ClaudeShadowConfigPathConflictError extends Schema.TaggedError<ClaudeShadowConfigPathConflictError>()(
  "ClaudeShadowConfigPathConflictError",
  ClaudeShadowConfigContext,
) {
  override get message(): string {
    return `Claude shadow config path '${this.effectiveConfigPath}' must be different from the shared config path '${this.sharedConfigPath}'.`;
  }
}

class ClaudeShadowConfigEntryConflictError extends Schema.TaggedError<ClaudeShadowConfigEntryConflictError>()(
  "ClaudeShadowConfigEntryConflictError",
  {
    ...ClaudeShadowConfigContext,
    entryName: Schema.String,
    linkPath: Schema.String,
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot create Claude shadow config entry '${this.entryName}' because '${this.linkPath}' already exists and is not a symlink. Move its contents into '${this.targetPath}' first.`;
  }
}

class ClaudeShadowConfigPrivateEntrySymlinkError extends Schema.TaggedError<ClaudeShadowConfigPrivateEntrySymlinkError>()(
  "ClaudeShadowConfigPrivateEntrySymlinkError",
  {
    ...ClaudeShadowConfigContext,
    entryName: Schema.String,
    path: Schema.String,
  },
) {
  override get message(): string {
    return `Claude shadow config private entry '${this.entryName}' at '${this.path}' must be a real file, not a symlink.`;
  }
}

type LinkState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "NotSymlink" }
  | { readonly _tag: "Symlink"; readonly target: string };

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

export const materializeClaudeShadowConfig = Effect.fn("materializeClaudeShadowConfig")(function* (
  layout: ClaudeHomeLayout,
) {
  if (layout.mode !== "authOverlay") return;
  const { sharedConfigPath, effectiveConfigPath } = layout;
  if (sharedConfigPath === effectiveConfigPath) {
    return yield* new ClaudeShadowConfigPathConflictError({
      sharedConfigPath,
      effectiveConfigPath,
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const fileSystemError = (
    operation: "readLink" | "realPath" | "makeDirectory" | "remove" | "symlink",
    entryPath: string,
    cause: PlatformError.PlatformError,
    entryName?: string,
    targetPath?: string,
  ) =>
    new ClaudeShadowConfigFileSystemError({
      sharedConfigPath,
      effectiveConfigPath,
      operation,
      path: entryPath,
      ...(targetPath === undefined ? {} : { targetPath }),
      ...(entryName === undefined ? {} : { entryName }),
      cause,
    });

  const readLinkState = (entryName: string, linkPath: string) =>
    fileSystem.readLink(linkPath).pipe(
      Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
      Effect.catchTags({
        PlatformError: (cause) => {
          if (cause.reason._tag === "NotFound") {
            return Effect.succeed<LinkState>({ _tag: "Missing" });
          }
          if (isNotSymlinkError(cause)) {
            return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
          }
          return fileSystemError("readLink", linkPath, cause, entryName);
        },
      }),
    );

  const makeDirectory = (directoryPath: string) =>
    fileSystem.makeDirectory(directoryPath, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) => fileSystemError("makeDirectory", directoryPath, cause),
      }),
    );

  yield* makeDirectory(sharedConfigPath);
  yield* makeDirectory(effectiveConfigPath);

  const realPaths = yield* Effect.forEach([sharedConfigPath, effectiveConfigPath], (entryPath) =>
    fileSystem.realPath(entryPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) => fileSystemError("realPath", entryPath, cause),
      }),
    ),
  );
  if (realPaths[0] === realPaths[1]) {
    return yield* new ClaudeShadowConfigPathConflictError({
      sharedConfigPath,
      effectiveConfigPath,
    });
  }

  for (const entryName of PRIVATE_ENTRY_NAMES) {
    const privatePath = path.join(effectiveConfigPath, entryName);
    const state = yield* readLinkState(entryName, privatePath);
    if (state._tag === "Symlink") {
      return yield* new ClaudeShadowConfigPrivateEntrySymlinkError({
        sharedConfigPath,
        effectiveConfigPath,
        entryName,
        path: privatePath,
      });
    }
  }

  for (const entryName of SHARED_ENTRY_NAMES) {
    const target = path.join(sharedConfigPath, entryName);
    const link = path.join(effectiveConfigPath, entryName);
    yield* makeDirectory(target);
    const state = yield* readLinkState(entryName, link);
    if (state._tag === "NotSymlink") {
      return yield* new ClaudeShadowConfigEntryConflictError({
        sharedConfigPath,
        effectiveConfigPath,
        entryName,
        linkPath: link,
        targetPath: target,
      });
    }
    if (state._tag === "Symlink" && path.resolve(path.dirname(link), state.target) === target) {
      continue;
    }
    if (state._tag === "Symlink") {
      yield* fileSystem.remove(link).pipe(
        Effect.catchTags({
          PlatformError: (cause) => fileSystemError("remove", link, cause, entryName),
        }),
      );
    }
    yield* fileSystem.symlink(target, link).pipe(
      Effect.catchTags({
        PlatformError: (cause) => fileSystemError("symlink", link, cause, entryName, target),
      }),
    );
  }
});
