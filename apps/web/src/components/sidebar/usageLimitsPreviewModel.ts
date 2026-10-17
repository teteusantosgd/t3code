import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { formatDuration, type LimitPool, type LimitPoolWindow } from "@t3tools/shared/usageLimits";

/**
 * Windows to show in the sidebar preview: session, weekly, and the plain
 * Monthly row (OpenCode Go's billing period, or Cursor's combined month).
 * Cursor's Monthly · API / Auto stay on the full Limits page.
 */
export function windowsForSidebarPreview(
  windows: readonly LimitPoolWindow[],
): readonly LimitPoolWindow[] {
  const glance = windows.filter(
    (window) =>
      window.kind === "session" ||
      window.kind === "weekly" ||
      (window.kind === "monthly" && window.label === "Monthly"),
  );
  return glance.length > 0 ? glance : windows;
}

/** True when any pool still has a window worth previewing. */
export function hasSidebarUsagePreview(pools: readonly LimitPool[]): boolean {
  return pools.some((pool) => windowsForSidebarPreview(pool.windows).length > 0);
}

/** Accounts that actually report this window (gaps left out of the compact bars). */
export function sidebarPreviewColumns(window: LimitPoolWindow): LimitPoolWindow["columns"] {
  return window.columns.filter((column) => column.window !== null);
}

/**
 * Aggregate % / single reset belong in the row header only when there is one
 * account. With two or more, each bar carries its own percent and reset.
 */
export function sidebarPreviewShowsAggregate(window: LimitPoolWindow): boolean {
  return sidebarPreviewColumns(window).length <= 1;
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
