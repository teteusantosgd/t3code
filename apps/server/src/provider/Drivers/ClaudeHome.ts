import type { ClaudeSettings, ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";

import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { readClaudeSettingsEnv } from "./ClaudeSkills.ts";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));
type ClaudeHomeSettings = Pick<ClaudeSettings, "homePath"> &
  Partial<Pick<ClaudeSettings, "shadowConfigPath">>;

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
    // Changing HOME hides macOS Keychain credentials; use CLAUDE_CONFIG_DIR to keep login access.
    // In shadow mode this is the shadow path: sign-in is keyed to it, while `projects/` inside
    // links back to the shared home.
    CLAUDE_CONFIG_DIR: layout.effectiveConfigPath,
  };
});

// A Claude Code session that launched T3 exports these. A claude spawned with them acts as part of
// that session: its session id, messaging socket and token, and effort.
const CLAUDE_HOST_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
];

/**
 * Base env for the Claude processes T3 Code runs, before `makeClaudeEnvironment`.
 * Claude Code reads its entrypoint from the process env, not its settings `env`, so T3 Code applies that override itself.
 */
export const mergeClaudeProcessEnvironment = Effect.fn("mergeClaudeProcessEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
  hostEnvironment: NodeJS.ProcessEnv,
) {
  const baseEnvironment: NodeJS.ProcessEnv = {
    ...hostEnvironment,
    CLAUDE_CODE_ENTRYPOINT: "t3-code",
  };
  for (const name of CLAUDE_HOST_SESSION_VARIABLES) delete baseEnvironment[name];
  // The desktop runs the server as Node through Electron. Commands Claude runs inherit its env, so
  // an Electron app they start (T3 Code itself, VS Code) would run as Node and exit.
  delete baseEnvironment.ELECTRON_RUN_AS_NODE;
  const environment = yield* mergeProviderInstanceEnvironment(instanceEnvironment, baseEnvironment);
  const settingsEntrypoint = (yield* readClaudeSettingsEnv(config, undefined, environment))
    .CLAUDE_CODE_ENTRYPOINT;
  return settingsEntrypoint
    ? { ...environment, CLAUDE_CODE_ENTRYPOINT: settingsEntrypoint }
    : environment;
});

/** managed-mcp.json excludes other MCP config and forbids --strict-mcp-config; omit the flag when present. */
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

// A worktree's .git file points at <main>/.git/worktrees/<name>, whose commondir leads back to
// <main>/.git. A bare repository has no main checkout, so its worktree keeps its own file.
// Untraced because claudeLocalSettingsDirectory already owns the span.
const mainCheckoutRoot = Effect.fnUntraced(function* (checkout: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(checkout, ".git")).pipe(
    Effect.flatMap((pointer) => {
      const gitDir = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
      if (gitDir === undefined) return Effect.succeed(checkout);
      const worktreeGitDir = path.resolve(checkout, gitDir);
      return fileSystem.readFileString(path.join(worktreeGitDir, "commondir")).pipe(
        Effect.map((commonDir) => {
          const common = path.resolve(worktreeGitDir, commonDir.trim());
          return path.basename(common) === ".git" ? path.dirname(common) : checkout;
        }),
      );
    }),
    Effect.orElseSucceed(() => checkout),
  );
});

// Claude Code keeps .claude/settings.local.json at the repository root, or in cwd outside a
// repository, on Windows, or when the root is home. Its owner check is skipped, so callers must
// stay safe when Claude Code ignores the root file.
export const claudeLocalSettingsDirectory = Effect.fn("claudeLocalSettingsDirectory")(function* (
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if ((yield* HostProcess.Platform) === "win32") return cwd;
  for (let directory = cwd; ; directory = path.dirname(directory)) {
    const isCheckout = yield* fileSystem
      .exists(path.join(directory, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isCheckout) {
      const root = yield* mainCheckoutRoot(directory);
      return root === (yield* HostProcess.HomeDirectory) ? cwd : root;
    }
    if (path.dirname(directory) === directory) return cwd;
  }
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

/** Separate spawn env from login commands to preserve literal paths, including relative inherited values. */
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
