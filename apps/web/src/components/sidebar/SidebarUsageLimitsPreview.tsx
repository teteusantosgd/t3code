import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import {
  collectLimitAccounts,
  collectLimitPools,
  type LimitPoolWindow,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import * as Schema from "effect/Schema";
import { ChevronDownIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";
import { barColor } from "../usage/UsageLimits";
import { readUsagePagePreferences, saveUsagePagePreferences } from "../usage/usagePagePreferences";
import {
  hasSidebarUsagePreview,
  sidebarPreviewColumns,
  sidebarPreviewResetLabel,
  sidebarPreviewShowsAggregate,
  windowsForSidebarPreview,
} from "./usageLimitsPreviewModel";

const LIMITS_SHELF_EXPANDED_KEY = "t3code:sidebar-limits-shelf-expanded:v1";

function accountLabel(member: LimitPoolWindow["columns"][number]): string {
  const { account } = member;
  if (account.displayName) return account.displayName;
  if (account.email) {
    const local = account.email.split("@")[0] ?? account.email;
    return local;
  }
  return getDriverOption(account.driver)?.label ?? String(account.driver);
}

function CompactWindowRow({
  window,
  color,
  now,
}: {
  readonly window: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
}) {
  const columns = sidebarPreviewColumns(window);
  const showAggregate = sidebarPreviewShowsAggregate(window);
  const nextRefill = showAggregate
    ? window.resets.find((reset) => reset.restoresPercent > 0)
    : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="min-w-0 truncate text-2xs text-sidebar-muted-foreground">
          {window.label}
        </span>
        {showAggregate ? (
          <>
            <span className="ms-auto shrink-0 text-xs font-semibold text-sidebar-foreground tabular-nums">
              {window.remainingPercent}%
            </span>
            {nextRefill ? (
              <span className="shrink-0 text-2xs text-sidebar-muted-foreground tabular-nums">
                {sidebarPreviewResetLabel(nextRefill.member.window, now)}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      <div
        className="grid min-w-0 gap-0.5"
        style={{ gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, minmax(0, 1fr))` }}
      >
        {columns.map((column) => {
          const accountWindow = column.window;
          const left = accountWindow ? remainingPercent(accountWindow) : 0;
          const resetLabel =
            !showAggregate && accountWindow ? sidebarPreviewResetLabel(accountWindow, now) : null;
          const title = resetLabel
            ? `${accountLabel(column)} ${left}% · ${resetLabel}`
            : `${accountLabel(column)} ${left}%`;
          return (
            <div
              key={column.account.key}
              className={cn(
                "relative min-w-0 overflow-hidden rounded-sm bg-muted",
                showAggregate ? "h-4" : "min-h-4",
              )}
              title={title}
            >
              {/* Match Usage → Limits: translucent fill so Codex/Cursor read as soft gray. */}
              <div
                aria-hidden
                className="absolute inset-y-0 left-0 rounded-sm opacity-35"
                style={{ width: `${left}%`, backgroundColor: color }}
              />
              <span
                className={cn(
                  "relative flex px-1 text-3xs font-medium text-sidebar-foreground/90 tabular-nums",
                  showAggregate
                    ? "h-full items-center"
                    : "min-h-4 flex-col justify-center gap-px py-0.5",
                )}
              >
                <span className="flex min-w-0 items-center gap-1">
                  <span className="min-w-0 truncate">{accountLabel(column)}</span>
                  <span className="ms-auto shrink-0">{left}%</span>
                </span>
                {resetLabel ? (
                  <span className="shrink-0 self-end text-sidebar-muted-foreground font-normal">
                    {resetLabel}
                  </span>
                ) : null}
              </span>
            </div>
          );
        })}
        {columns.length === 0 ? (
          <div className="relative h-4 overflow-hidden rounded-sm bg-muted">
            <div
              aria-hidden
              className="absolute inset-y-0 left-0 rounded-sm opacity-35"
              style={{ width: `${window.remainingPercent}%`, backgroundColor: color }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Compact Limits glance above Settled. Header matches Settled's shelf chrome;
 * the body is a sibling list row so `createSidebarListMotion` can FLIP-animate
 * expand/collapse the same way Settled rows do.
 */
export function SidebarUsageLimitsPreview({ className }: { readonly className?: string }) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const navigate = useNavigate();
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useLocalStorage(LIMITS_SHELF_EXPANDED_KEY, true, Schema.Boolean);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), [setExpanded]);
  const pools = useMemo(
    () => collectLimitPools(collectLimitAccounts(presentations), now),
    [now, presentations],
  );
  const visible = hasSidebarUsagePreview(pools);

  const openUsageLimits = useCallback(() => {
    const preferences = readUsagePagePreferences();
    saveUsagePagePreferences({ ...preferences, metric: "limits" });
    void navigate({ to: "/usage" });
  }, [navigate]);

  const refreshLimits = useEffectEvent(async (automatic: boolean) => {
    await Promise.all(
      Array.from(presentations, ([environmentId, presentation]) => {
        if (presentation.connection.phase !== "connected" || presentation.serverConfig === null) {
          return;
        }
        return refreshUsageLimits(
          environmentId,
          () => refreshProviders({ environmentId, input: {} }),
          automatic,
        );
      }),
    );
    setNow(Date.now());
  });

  const connectedKey = [...presentations]
    .filter(
      ([, presentation]) =>
        presentation.connection.phase === "connected" && presentation.serverConfig !== null,
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join(",");

  useEffect(() => {
    if (!connectedKey) return;
    void refreshLimits(true);
  }, [connectedKey]);

  // Empty mt-auto slot keeps Settled/Snoozed pinned when there is no limits data.
  if (!visible) {
    return <li className={cn("list-none", className)} />;
  }

  return (
    <Fragment>
      <li className={cn("list-none mx-0.5 h-8", className)}>
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          className="flex h-full w-full cursor-pointer items-center gap-2 px-2 text-left text-xs font-medium text-sidebar-muted-foreground/60"
        >
          <span className="shrink-0">Limits</span>
          <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")}
          />
        </button>
      </li>
      {expanded ? (
        <li className="list-none">
          <button
            type="button"
            onClick={openUsageLimits}
            className="flex w-full cursor-pointer flex-col gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-sidebar-row-hover"
            aria-label="Open usage limits"
          >
            {pools.map((pool) => {
              const windows = windowsForSidebarPreview(pool.windows);
              if (windows.length === 0) return null;
              const label = getDriverOption(pool.driver)?.label ?? String(pool.driver);
              const color = barColor(pool.driver);
              return (
                <section key={pool.driver} className="flex min-w-0 flex-col gap-1.5">
                  <h3 className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-sidebar-foreground">
                    <ProviderInstanceIcon
                      driverKind={pool.driver}
                      displayName={label}
                      indicatorBackground="var(--sidebar)"
                      className="size-4"
                      iconClassName="size-3 text-sidebar-foreground/80"
                    />
                    <span className="truncate">{label}</span>
                  </h3>
                  {windows.map((window) => (
                    <CompactWindowRow
                      key={`${window.kind}:${window.id}`}
                      window={window}
                      color={color}
                      now={now}
                    />
                  ))}
                </section>
              );
            })}
          </button>
        </li>
      ) : null}
    </Fragment>
  );
}
