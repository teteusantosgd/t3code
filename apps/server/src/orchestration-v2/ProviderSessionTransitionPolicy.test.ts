import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { makeClaudeContinuationGroupKey } from "../provider/Drivers/ClaudeHome.ts";
import { decideProviderSessionTransition } from "./ProviderSessionTransitionPolicy.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const base = {
  driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:account:one" },
  modelSelection: { instanceId, model: "gpt-5.1-codex" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  workspace: "/repo",
  capabilities: CodexProviderCapabilitiesV2,
};

it.effect("resumes Claude across shadow accounts and hands off across isolated homes", () =>
  Effect.gen(function* () {
    const claude = ProviderDriverKind.make("claudeAgent");
    const current = {
      ...base,
      driver: claude,
      capabilities: ClaudeProviderCapabilitiesV2,
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude_first"),
        model: "claude-sonnet-4-6",
      },
      continuationIdentity: {
        driverKind: claude,
        continuationKey: yield* makeClaudeContinuationGroupKey({ homePath: "/shared/claude" }),
      },
    };
    for (const [homePath, expected] of [
      ["/shared/claude", "restart_and_resume"],
      ["/isolated/claude", "create_with_handoff"],
    ] as const) {
      const continuationKey = yield* makeClaudeContinuationGroupKey({
        homePath,
        shadowConfigPath: "/account/two",
      });
      assert.deepEqual(
        decideProviderSessionTransition({
          current,
          target: {
            ...current,
            continuationIdentity: { driverKind: claude, continuationKey },
            modelSelection: {
              ...current.modelSelection,
              instanceId: ProviderInstanceId.make("claude_second"),
            },
            available: true,
          },
        }),
        { type: expected },
      );
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("reuses compatible sessions and treats interaction mode as turn-scoped", () => {
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target: { ...base, interactionMode: "plan", available: true },
    }),
    { type: "reuse" },
  );
});

it("uses the adapter's selection transition classification", () => {
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target: {
        ...base,
        modelSelection: { ...base.modelSelection, model: "gpt-5.2-codex" },
        available: true,
      },
      selectionTransition: { type: "apply_on_next_turn" },
    }),
    { type: "switch_model_in_session" },
  );
  assert.deepEqual(
    decideProviderSessionTransition({
      current: {
        ...base,
        capabilities: {
          ...base.capabilities,
          sessions: { ...base.capabilities.sessions, supportsModelSwitchInSession: false },
        },
      },
      target: {
        ...base,
        capabilities: {
          ...base.capabilities,
          sessions: { ...base.capabilities.sessions, supportsModelSwitchInSession: false },
        },
        modelSelection: { ...base.modelSelection, model: "gpt-5.2-codex" },
        available: true,
      },
      selectionTransition: { type: "restart_session" },
    }),
    { type: "restart_and_resume" },
  );
});

it("treats provider option changes as selection changes", () => {
  assert.deepEqual(
    decideProviderSessionTransition({
      current: {
        ...base,
        modelSelection: {
          ...base.modelSelection,
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
      },
      target: {
        ...base,
        modelSelection: {
          ...base.modelSelection,
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        available: true,
      },
      selectionTransition: { type: "apply_on_next_turn" },
    }),
    { type: "switch_model_in_session" },
  );
});

it("restarts compatible instances for workspace or runtime changes", () => {
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target: { ...base, workspace: "/other", available: true },
    }),
    { type: "restart_and_resume" },
  );
});

it("preserves a rejected selection when the workspace also changes", () => {
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target: {
        ...base,
        modelSelection: { ...base.modelSelection, model: "gpt-5.2-codex" },
        workspace: "/other",
        available: true,
      },
      selectionTransition: {
        type: "reject",
        reason: "The active session cannot apply that model.",
      },
    }),
    { type: "reject", reason: "The active session cannot apply that model." },
  );
});

it("preserves handoff and missing-classification outcomes across workspace changes", () => {
  const target = {
    ...base,
    modelSelection: { ...base.modelSelection, model: "gpt-5.2-codex" },
    workspace: "/other",
    available: true,
  };
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target,
      selectionTransition: { type: "create_with_handoff" },
    }),
    { type: "create_with_handoff" },
  );
  assert.deepEqual(decideProviderSessionTransition({ current: base, target }), {
    type: "reject",
    reason: "The provider adapter did not classify the selection change.",
  });
});

it("uses portable handoff for incompatible continuation identities", () => {
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target: {
        ...base,
        modelSelection: {
          ...base.modelSelection,
          instanceId: ProviderInstanceId.make("codex_other"),
        },
        continuationIdentity: { driverKind: driver, continuationKey: "codex:account:other" },
        available: true,
      },
    }),
    { type: "create_with_handoff" },
  );
});

it("uses portable handoff for cross-driver transitions", () => {
  const claudeDriver = ProviderDriverKind.make("claude");
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target: {
        ...base,
        driver: claudeDriver,
        continuationIdentity: { driverKind: claudeDriver, continuationKey: "claude:account:one" },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "claude-opus-4-1",
        },
        available: true,
      },
    }),
    { type: "create_with_handoff" },
  );
});
