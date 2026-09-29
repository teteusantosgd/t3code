import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadChangesPanelState, useChangesPanelStore } from "./changesPanelStore";

const THREAD_REF = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));

beforeEach(() => {
  useChangesPanelStore.setState({ byThreadKey: {} });
});

describe("changesPanelStore", () => {
  it("defaults to list layout and empty commit messages", () => {
    expect(
      selectThreadChangesPanelState(useChangesPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      listLayout: "list",
      commitMessageByRepositoryKey: {},
      collapsedRepositoryKeys: {},
      expandedFileKey: null,
    });
  });

  it("persists layout, commit messages, and collapsed repositories per thread", () => {
    useChangesPanelStore.getState().setListLayout(THREAD_REF, "tree");
    useChangesPanelStore.getState().setCommitMessage(THREAD_REF, "/repo/a", "feat: ship it");
    useChangesPanelStore.getState().setRepositoryCollapsed(THREAD_REF, "/repo/a", true);

    expect(
      selectThreadChangesPanelState(useChangesPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      listLayout: "tree",
      commitMessageByRepositoryKey: { "/repo/a": "feat: ship it" },
      collapsedRepositoryKeys: { "/repo/a": true },
      expandedFileKey: null,
    });

    useChangesPanelStore.getState().setRepositoryCollapsed(THREAD_REF, "/repo/a", false);
    expect(
      selectThreadChangesPanelState(useChangesPanelStore.getState().byThreadKey, THREAD_REF)
        .collapsedRepositoryKeys,
    ).toEqual({});
  });

  it("toggles a single expanded inline file key", () => {
    useChangesPanelStore.getState().toggleExpandedFileKey(THREAD_REF, "a");
    expect(
      selectThreadChangesPanelState(useChangesPanelStore.getState().byThreadKey, THREAD_REF)
        .expandedFileKey,
    ).toBe("a");

    useChangesPanelStore.getState().toggleExpandedFileKey(THREAD_REF, "b");
    expect(
      selectThreadChangesPanelState(useChangesPanelStore.getState().byThreadKey, THREAD_REF)
        .expandedFileKey,
    ).toBe("b");

    useChangesPanelStore.getState().toggleExpandedFileKey(THREAD_REF, "b");
    expect(
      selectThreadChangesPanelState(useChangesPanelStore.getState().byThreadKey, THREAD_REF)
        .expandedFileKey,
    ).toBeNull();
  });
});
