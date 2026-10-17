import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type ChangesPanelListLayout = "list" | "tree";

interface ThreadChangesPanelState {
  listLayout: ChangesPanelListLayout;
  commitMessageByRepositoryKey: Record<string, string>;
  /** Repository keys (cwd) the user has collapsed — missing means expanded. */
  collapsedRepositoryKeys: Record<string, true>;
  /** One open inline diff at a time (`cwd\\0scope\\0path`), or null. */
  expandedFileKey: string | null;
}

interface ChangesPanelStoreState {
  byThreadKey: Record<string, ThreadChangesPanelState>;
  setListLayout: (ref: ScopedThreadRef, layout: ChangesPanelListLayout) => void;
  setCommitMessage: (ref: ScopedThreadRef, repositoryKey: string, message: string) => void;
  setRepositoryCollapsed: (ref: ScopedThreadRef, repositoryKey: string, collapsed: boolean) => void;
  setExpandedFileKey: (ref: ScopedThreadRef, key: string | null) => void;
  toggleExpandedFileKey: (ref: ScopedThreadRef, key: string) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const DEFAULT_THREAD_STATE: ThreadChangesPanelState = {
  listLayout: "list",
  commitMessageByRepositoryKey: {},
  collapsedRepositoryKeys: {},
  expandedFileKey: null,
};

function withThread(
  state: ChangesPanelStoreState,
  ref: ScopedThreadRef,
  update: (current: ThreadChangesPanelState) => ThreadChangesPanelState,
): Pick<ChangesPanelStoreState, "byThreadKey"> {
  const threadKey = scopedThreadKey(ref);
  const current = state.byThreadKey[threadKey] ?? DEFAULT_THREAD_STATE;
  return {
    byThreadKey: {
      ...state.byThreadKey,
      [threadKey]: update(current),
    },
  };
}

export const useChangesPanelStore = create<ChangesPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      setListLayout: (ref, layout) =>
        set((state) => withThread(state, ref, (current) => ({ ...current, listLayout: layout }))),
      setCommitMessage: (ref, repositoryKey, message) =>
        set((state) =>
          withThread(state, ref, (current) => ({
            ...current,
            commitMessageByRepositoryKey: {
              ...current.commitMessageByRepositoryKey,
              [repositoryKey]: message,
            },
          })),
        ),
      setRepositoryCollapsed: (ref, repositoryKey, collapsed) =>
        set((state) =>
          withThread(state, ref, (current) => {
            const nextCollapsed = { ...current.collapsedRepositoryKeys };
            if (collapsed) nextCollapsed[repositoryKey] = true;
            else delete nextCollapsed[repositoryKey];
            return { ...current, collapsedRepositoryKeys: nextCollapsed };
          }),
        ),
      setExpandedFileKey: (ref, key) =>
        set((state) => withThread(state, ref, (current) => ({ ...current, expandedFileKey: key }))),
      toggleExpandedFileKey: (ref, key) =>
        set((state) =>
          withThread(state, ref, (current) => ({
            ...current,
            expandedFileKey: current.expandedFileKey === key ? null : key,
          })),
        ),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey)) return state;
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        }),
    }),
    {
      name: "t3code:changes-panel-state:v1",
      version: 4,
      migrate: (persisted) => {
        const state = persisted as {
          byThreadKey?: Record<string, Partial<ThreadChangesPanelState>>;
        };
        const byThreadKey: Record<string, ThreadChangesPanelState> = {};
        for (const [key, thread] of Object.entries(state.byThreadKey ?? {})) {
          byThreadKey[key] = {
            listLayout: thread.listLayout === "tree" ? "tree" : "list",
            commitMessageByRepositoryKey: thread.commitMessageByRepositoryKey ?? {},
            collapsedRepositoryKeys: thread.collapsedRepositoryKeys ?? {},
            // Inline expand is session UI — never restore a stale open file.
            expandedFileKey: null,
          };
        }
        return { byThreadKey };
      },
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: Object.fromEntries(
          Object.entries(state.byThreadKey).map(([key, thread]) => [
            key,
            {
              listLayout: thread.listLayout,
              commitMessageByRepositoryKey: thread.commitMessageByRepositoryKey,
              collapsedRepositoryKeys: thread.collapsedRepositoryKeys,
              expandedFileKey: null,
            },
          ]),
        ),
      }),
    },
  ),
);

export function selectThreadChangesPanelState(
  byThreadKey: Record<string, ThreadChangesPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadChangesPanelState {
  if (!ref) return DEFAULT_THREAD_STATE;
  const thread = byThreadKey[scopedThreadKey(ref)];
  return thread ?? DEFAULT_THREAD_STATE;
}
