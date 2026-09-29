import type { LimitPool, LimitPoolWindow } from "@t3tools/shared/usageLimits";

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
