import { ProviderDriverKind } from "@t3tools/contracts";
import type { LimitAccount, LimitPoolWindow } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import {
  hasSidebarUsagePreview,
  sidebarPreviewResetLabel,
  sidebarPreviewShowsAggregate,
  windowsForSidebarPreview,
} from "./usageLimitsPreviewModel";

function window(
  kind: "session" | "weekly" | "monthly" | "other",
  id: string,
  label = id,
  columns: Array<{ accountKey: string; window: LimitPoolWindow["columns"][number]["window"] }> = [],
): LimitPoolWindow {
  const account = (key: string): LimitAccount => ({
    key,
    driver: ProviderDriverKind.make("codex"),
    displayName: null,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: null,
    limits: { checkedAt: "2026-09-29T12:00:00.000Z", windows: [] },
  });
  return {
    id,
    kind,
    label,
    members: [],
    columns: columns.map(({ accountKey, window }) => ({ account: account(accountKey), window })),
    remainingPercent: 50,
    usedPercent: 50,
    pace: null,
    resets: [],
  };
}

describe("windowsForSidebarPreview", () => {
  it("keeps session, weekly, and the plain monthly row", () => {
    const windows = [
      window("session", "primary", "Session"),
      window("weekly", "weekly", "Weekly"),
      window("monthly", "monthly", "Monthly"),
      window("monthly", "api", "Monthly · API"),
    ];
    expect(windowsForSidebarPreview(windows).map((entry) => entry.label)).toEqual([
      "Session",
      "Weekly",
      "Monthly",
    ]);
  });

  it("keeps only session when weekly is absent", () => {
    expect(
      windowsForSidebarPreview([window("session", "primary", "Session")]).map(
        (entry) => entry.kind,
      ),
    ).toEqual(["session"]);
  });

  it("falls back to the plain Monthly window, not API or Auto", () => {
    const windows = [
      window("monthly", "api", "Monthly · API"),
      window("monthly", "auto", "Monthly · Auto"),
      window("monthly", "total", "Monthly"),
    ];
    expect(windowsForSidebarPreview(windows).map((entry) => entry.label)).toEqual(["Monthly"]);
  });
});

describe("hasSidebarUsagePreview", () => {
  it("is false when every pool is empty", () => {
    expect(
      hasSidebarUsagePreview([
        { driver: ProviderDriverKind.make("codex"), accounts: [], windows: [] },
      ]),
    ).toBe(false);
  });

  it("is true when a pool has a preview window", () => {
    expect(
      hasSidebarUsagePreview([
        {
          driver: ProviderDriverKind.make("codex"),
          accounts: [],
          windows: [window("session", "primary", "Session")],
        },
      ]),
    ).toBe(true);
  });
});

describe("sidebarPreviewShowsAggregate", () => {
  it("keeps the header aggregate for a single account", () => {
    expect(
      sidebarPreviewShowsAggregate(
        window("session", "primary", "Session", [
          {
            accountKey: "codex:a",
            window: { id: "primary", kind: "session", label: "Session", usedPercent: 40 },
          },
        ]),
      ),
    ).toBe(true);
  });

  it("hides the header aggregate when two accounts report the window", () => {
    expect(
      sidebarPreviewShowsAggregate(
        window("session", "primary", "Session", [
          {
            accountKey: "codex:a",
            window: { id: "primary", kind: "session", label: "Session", usedPercent: 40 },
          },
          {
            accountKey: "codex:b",
            window: { id: "primary", kind: "session", label: "Session", usedPercent: 10 },
          },
        ]),
      ),
    ).toBe(false);
  });

  it("ignores column gaps when counting accounts", () => {
    expect(
      sidebarPreviewShowsAggregate(
        window("session", "primary", "Session", [
          {
            accountKey: "codex:a",
            window: { id: "primary", kind: "session", label: "Session", usedPercent: 40 },
          },
          { accountKey: "codex:b", window: null },
        ]),
      ),
    ).toBe(true);
  });
});

describe("sidebarPreviewResetLabel", () => {
  const now = Date.parse("2026-09-29T12:00:00.000Z");

  it("formats a future reset as a compact duration", () => {
    expect(
      sidebarPreviewResetLabel(
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 40,
          resetsAt: "2026-09-29T13:42:00.000Z",
        },
        now,
      ),
    ).toBe("1h 42m");
  });

  it("returns now when the reset has elapsed", () => {
    expect(
      sidebarPreviewResetLabel(
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 40,
          resetsAt: "2026-09-29T11:59:00.000Z",
        },
        now,
      ),
    ).toBe("now");
  });

  it("returns null when the window has no reset", () => {
    expect(
      sidebarPreviewResetLabel(
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 40,
        },
        now,
      ),
    ).toBeNull();
  });
});
