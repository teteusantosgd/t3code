import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { formatDuration, type LimitPool, type LimitPoolWindow } from "@t3tools/shared/usageLimits";

/**
 * Windows to show in the sidebar preview: session + weekly when the provider
 * reports either (Codex/Claude five-hour and week). Otherwise the plain
 * Monthly row (Cursor) — not Monthly · API / Auto.
 */
export function windowsForSidebarPreview(
  windows: readonly LimitPoolWindow[],
): readonly LimitPoolWindow[] {
  const sessionAndWeekly = windows.filter(
    (window) => window.kind === "session" || window.kind === "weekly",
  );
  if (sessionAndWeekly.length > 0) return sessionAndWeekly;
  const monthlyPrimary = windows.filter(
    (window) => window.kind === "monthly" && window.label === "Monthly",
  );
  return monthlyPrimary.length > 0 ? monthlyPrimary : windows;
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
