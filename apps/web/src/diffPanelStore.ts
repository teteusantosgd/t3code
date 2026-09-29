import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ReviewDiffPreviewSourceKind, ScopedThreadRef, TurnId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type DiffPanelGitScope = "uncommitted" | "staged" | "unstaged" | "branch";

export type DiffPanelGitScopeSelection = {
  kind: "uncommitted" | "staged" | "unstaged";
  filePath: string | null;
  revealRequestId: number;
};

export type DiffPanelSelection =
  | { kind: "branch"; baseRef: string | null }
  | DiffPanelGitScopeSelection
  | { kind: "turn"; turnId: TurnId; filePath: string | null; revealRequestId: number };

const DEFAULT_SELECTION: DiffPanelSelection = {
  kind: "uncommitted",
  filePath: null,
  revealRequestId: 0,
};

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  branchBaseRefByThreadKey: Record<string, string | null>;
  selectGitScope: (ref: ScopedThreadRef, scope: DiffPanelGitScope, filePath?: string) => void;
  selectBranchBaseRef: (ref: ScopedThreadRef, baseRef: string | null) => void;
  selectTurn: (ref: ScopedThreadRef, turnId: TurnId, filePath?: string) => void;
  reconcileTurnSelection: (ref: ScopedThreadRef, availableTurnIds: ReadonlyArray<TurnId>) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

function selectionForGitScope(
  scope: DiffPanelGitScope,
  previousBaseRef: string | null,
  previous: DiffPanelSelection | undefined,
  filePath: string | undefined,
): DiffPanelSelection {
  if (scope === "branch") return { kind: "branch", baseRef: previousBaseRef };
  const normalizedPath = filePath?.trim() || null;
  const previousScope = previous?.kind === scope ? previous : undefined;
  return {
    kind: scope,
    filePath: normalizedPath,
    revealRequestId:
      previousScope?.filePath === normalizedPath && normalizedPath !== null
        ? previousScope.revealRequestId + 1
        : normalizedPath !== null
          ? 1
          : 0,
  };
}

export function sourceKindForGitScope(
  scope: Exclude<DiffPanelGitScope, "branch">,
): ReviewDiffPreviewSourceKind {
  if (scope === "uncommitted") return "working-tree";
  return scope;
}

export function gitScopeLabel(scope: DiffPanelGitScope): string {
  switch (scope) {
    case "uncommitted":
      return "Uncommitted";
    case "staged":
      return "Staged";
    case "unstaged":
      return "Unstaged";
    case "branch":
      return "Branch changes";
  }
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      selectGitScope: (ref, scope, filePath) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const previousBaseRef =
            previous?.kind === "branch"
              ? previous.baseRef
              : (state.branchBaseRefByThreadKey[threadKey] ?? null);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: selectionForGitScope(scope, previousBaseRef, previous, filePath),
            },
            branchBaseRefByThreadKey:
              previous?.kind === "branch"
                ? { ...state.branchBaseRefByThreadKey, [threadKey]: previous.baseRef }
                : state.branchBaseRefByThreadKey,
          };
        }),
      selectBranchBaseRef: (ref, baseRef) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const normalizedBaseRef = normalizeBaseRef(baseRef);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { kind: "branch", baseRef: normalizedBaseRef },
            },
            branchBaseRefByThreadKey: {
              ...state.branchBaseRefByThreadKey,
              [threadKey]: normalizedBaseRef,
            },
          };
        }),
      selectTurn: (ref, turnId, filePath) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: {
                kind: "turn",
                turnId,
                filePath: filePath?.trim() || null,
                revealRequestId: previous?.kind === "turn" ? previous.revealRequestId + 1 : 1,
              },
            },
          };
        }),
      reconcileTurnSelection: (ref, availableTurnIds) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const latestTurnId = availableTurnIds[0];
          if (
            previous?.kind !== "turn" ||
            latestTurnId === undefined ||
            availableTurnIds.includes(previous.turnId)
          ) {
            return state;
          }
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { ...previous, turnId: latestTurnId },
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey) && !(threadKey in state.branchBaseRefByThreadKey)) {
            return state;
          }
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          const { [threadKey]: _removedBaseRef, ...branchBaseRefByThreadKey } =
            state.branchBaseRefByThreadKey;
          return { byThreadKey, branchBaseRefByThreadKey };
        }),
    }),
    {
      name: "t3code:diff-panel-state:v1",
      version: 3,
      migrate: (persisted) => {
        const state = persisted as {
          byThreadKey?: Record<string, DiffPanelSelection | { kind: "unstaged" }>;
          branchBaseRefByThreadKey?: Record<string, string | null>;
        };
        const byThreadKey: Record<string, DiffPanelSelection> = {};
        for (const [key, selection] of Object.entries(state.byThreadKey ?? {})) {
          // v1 used kind "unstaged" for the unified dirty worktree (Uncommitted).
          if (selection?.kind === "unstaged" && !("turnId" in selection)) {
            byThreadKey[key] = { kind: "uncommitted", filePath: null, revealRequestId: 0 };
          } else if (
            selection &&
            (selection.kind === "uncommitted" ||
              selection.kind === "staged" ||
              selection.kind === "unstaged") &&
            !("filePath" in selection)
          ) {
            byThreadKey[key] = {
              kind: selection.kind,
              filePath: null,
              revealRequestId: 0,
            };
          } else {
            byThreadKey[key] = selection as DiffPanelSelection;
          }
        }
        return {
          byThreadKey,
          branchBaseRefByThreadKey: state.branchBaseRefByThreadKey ?? {},
        };
      },
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: state.byThreadKey,
        branchBaseRefByThreadKey: state.branchBaseRefByThreadKey,
      }),
    },
  ),
);

export function selectThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
): DiffPanelSelection {
  if (!ref) return DEFAULT_SELECTION;
  return byThreadKey[scopedThreadKey(ref)] ?? DEFAULT_SELECTION;
}

/**
 * Generic Diff openings (tab toggle, "+" surface) reset to Uncommitted. Callers that
 * already chose a turn or a concrete file (timeline, Changes) must keep that target —
 * otherwise the layout-effect reset races the selection and opens the wrong scope.
 */
export function shouldResetDiffSelectionOnGenericOpen(selection: DiffPanelSelection): boolean {
  if (selection.kind === "turn") return false;
  if (selection.kind === "branch") return true;
  return selection.filePath === null;
}
