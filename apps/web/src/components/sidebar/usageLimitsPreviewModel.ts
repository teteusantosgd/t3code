import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { formatDuration, type LimitPool, type LimitPoolWindow } from "@t3tools/shared/usageLimits";

/** Sidebar toggle for Cursor and OpenCode Go. The Limits page always lists them. */
export const SIDEBAR_PROVIDER_LIMITS_KEY = "t3code:sidebar-provider-limits:v1";

/**
 * Windows to show in the sidebar preview: session, weekly, and the plain
 * Monthly row (OpenCode Go's billing period). Cursor shows only Overall, its
 * combined allowance; the per-pool rows stay on the full Limits page.
 */
export function windowsForSidebarPreview(
  windows: readonly LimitPoolWindow[],
): readonly LimitPoolWindow[] {
  const glance = windows.filter(
    (window) =>
      window.kind === "session" ||
      window.kind === "weekly" ||
      (window.kind === "monthly" && window.label === "Monthly") ||
      window.id === "totalPercentUsed",
  );
  return glance.length > 0 ? glance : windows;
}

/** Pools the sidebar may preview. The toggle hides Cursor and OpenCode Go only. */
export function sidebarPreviewPools(
  pools: readonly LimitPool[],
  showProviderLimits: boolean,
): readonly LimitPool[] {
  return showProviderLimits
    ? pools
    : pools.filter((pool) => pool.driver !== "cursor" && pool.driver !== "opencode");
}

/** True when any pool still has a window worth previewing. */
export function hasSidebarUsagePreview(pools: readonly LimitPool[]): boolean {
  return pools.some((pool) => windowsForSidebarPreview(pool.windows).length > 0);
}

/** Accounts that actually report this window (gaps left out of the compact bars). */
export function sidebarPreviewColumns(window: LimitPoolWindow): LimitPoolWindow["columns"] {
  return window.columns.filter((column) => column.window !== null);
}

/** Compact countdown for a window, or null when the provider omitted a reset. */
export function sidebarPreviewResetLabel(
  window: ServerProviderUsageWindow,
  now: number,
): string | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  if (!Number.isFinite(at)) return null;
  return at <= now ? "now" : formatDuration(at - now);
}
