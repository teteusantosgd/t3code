import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ClaudeSettings } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  materializeClaudeShadowConfig,
  resolveClaudeHomeLayout,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

const decodeSettings = Schema.decodeSync(ClaudeSettings);
const shadowFixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-shadow-" });
  const shared = path.join(root, "shared");
  const shadow = path.join(root, "account");
  yield* fs.makeDirectory(shared);
  yield* fs.makeDirectory(shadow);
  const config = decodeSettings({ homePath: shared, shadowConfigPath: shadow });
  return { fs, path, shared, shadow, config, layout: yield* resolveClaudeHomeLayout(config) };
});

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  it.effect("shares continuation with the direct home while caching accounts separately", () =>
    Effect.gen(function* () {
      const shared = "/synthetic/shared";
      const direct = decodeSettings({ homePath: shared });
      const first = decodeSettings({ homePath: shared, shadowConfigPath: "~/account-one" });
      const second = decodeSettings({ homePath: shared, shadowConfigPath: "~/account-two" });
      expect(yield* makeClaudeContinuationGroupKey(first)).toBe(
        yield* makeClaudeContinuationGroupKey(direct),
      );
      expect(yield* makeClaudeContinuationGroupKey(first)).toBe(
        yield* makeClaudeContinuationGroupKey(second),
      );
      expect(yield* makeClaudeCapabilitiesCacheKey({ ...first, binaryPath: "claude" })).not.toBe(
        yield* makeClaudeCapabilitiesCacheKey({ ...second, binaryPath: "claude" }),
      );
      const environment = yield* makeClaudeEnvironment(first, { HOME: "/original", EXTRA: "kept" });
      expect(environment.HOME).toBe("/original");
      expect(environment.EXTRA).toBe("kept");
      expect(environment.CLAUDE_CONFIG_DIR).toBe(
        (yield* resolveClaudeHomeLayout(first)).effectiveConfigPath,
      );
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "resumes and writes the same transcript through either account",
    () =>
      Effect.gen(function* () {
        const { fs, path, shared, shadow, layout } = yield* shadowFixture();
        const projects = path.join(shared, "projects");
        yield* fs.makeDirectory(path.join(projects, "workspace"), { recursive: true });
        const transcript = path.join(projects, "workspace", "session.jsonl");
        yield* fs.writeFileString(transcript, "first account\n");
        yield* fs.writeFileString(path.join(shadow, ".credentials.json"), "private credentials");
        yield* fs.writeFileString(path.join(shadow, ".claude.json"), "private account");
        yield* fs.writeFileString(path.join(shared, "settings.json"), "shared settings");
        yield* materializeClaudeShadowConfig(layout);
        yield* materializeClaudeShadowConfig(layout);
        const shadowTranscript = path.join(shadow, "projects", "workspace", "session.jsonl");
        expect(yield* fs.readFileString(shadowTranscript)).toBe("first account\n");
        yield* fs.writeFileString(shadowTranscript, "second account\n", { flag: "a" });
        expect(yield* fs.readFileString(transcript)).toBe("first account\nsecond account\n");
        expect(yield* fs.readFileString(path.join(shadow, ".credentials.json"))).toBe(
          "private credentials",
        );
        expect(yield* fs.readFileString(path.join(shadow, ".claude.json"))).toBe("private account");
        expect(yield* fs.exists(path.join(shadow, "settings.json"))).toBe(false);
      }),
  );

  it.effect("refuses to replace existing account transcripts", () =>
    Effect.gen(function* () {
      const { fs, path, shadow, layout } = yield* shadowFixture();
      const projects = path.join(shadow, "projects");
      yield* fs.makeDirectory(projects);
      yield* fs.writeFileString(path.join(projects, "session.jsonl"), "old session");
      const result = yield* materializeClaudeShadowConfig(layout).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ClaudeShadowConfigEntryConflictError" },
      });
      expect(yield* fs.readFileString(path.join(projects, "session.jsonl"))).toBe("old session");
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "validates private credentials before linking transcripts",
    () =>
      Effect.gen(function* () {
        const { fs, path, shared, shadow, layout } = yield* shadowFixture();
        yield* fs.writeFileString(path.join(shared, ".credentials.json"), "shared credentials");
        yield* fs.symlink(
          path.join(shared, ".credentials.json"),
          path.join(shadow, ".credentials.json"),
        );
        const result = yield* materializeClaudeShadowConfig(layout).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ClaudeShadowConfigPrivateEntrySymlinkError" },
        });
        expect(yield* fs.exists(path.join(shadow, "projects"))).toBe(false);
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects a shadow that aliases the shared config directory",
    () =>
      Effect.gen(function* () {
        const { fs, path, shared, shadow, config } = yield* shadowFixture();
        yield* fs.remove(shadow, { recursive: true });
        yield* fs.symlink(shared, shadow);
        const layout = yield* resolveClaudeHomeLayout(config);
        const result = yield* materializeClaudeShadowConfig(layout).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ClaudeShadowConfigPathConflictError" },
        });
        expect(yield* fs.exists(path.join(shared, "projects"))).toBe(false);
      }),
  );

  describe("Claude home resolution", () => {
    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });

  it.effect(
    "drops the launching Claude session and Electron's run-as-Node flag, and labels processes t3-code unless overridden",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
        const host = {
          CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "host-session",
          CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/host-claude.sock",
          CLAUDE_EFFORT: "high",
          ELECTRON_RUN_AS_NODE: "1",
          KEEP: "1",
        };
        const instance = [
          { name: "CLAUDE_CODE_ENTRYPOINT", value: "instance", sensitive: false },
          { name: "CLAUDE_EFFORT", value: "low", sensitive: false },
        ];

        expect(yield* mergeClaudeProcessEnvironment({ homePath }, undefined, host)).toEqual({
          CLAUDE_CODE_ENTRYPOINT: "t3-code",
          KEEP: "1",
        });
        expect(yield* mergeClaudeProcessEnvironment({ homePath }, instance, host)).toEqual({
          CLAUDE_CODE_ENTRYPOINT: "instance",
          CLAUDE_EFFORT: "low",
          KEEP: "1",
        });

        yield* fileSystem.writeFileString(
          path.join(homePath, "settings.json"),
          JSON.stringify({ env: { CLAUDE_CODE_ENTRYPOINT: "custom" } }),
        );
        expect(
          (yield* mergeClaudeProcessEnvironment({ homePath }, instance, host))
            .CLAUDE_CODE_ENTRYPOINT,
        ).toBe("custom");
      }),
  );
});
