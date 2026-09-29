import { ProviderDriverKind } from "@t3tools/contracts";
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
  columns: Array<{ account: { key: string }; window: object | null }> = [],
): {
  id: string;
  kind: typeof kind;
  label: string;
  members: [];
  columns: typeof columns;
  remainingPercent: number;
  usedPercent: number;
  pace: null;
  resets: [];
} {
  return {
    id,
    kind,
    label,
    members: [],
    columns,
    remainingPercent: 50,
    usedPercent: 50,
    pace: null,
    resets: [],
  };
}

describe("windowsForSidebarPreview", () => {
  it("keeps session and weekly when both are present", () => {
    const windows = [
      window("session", "primary", "Session"),
      window("weekly", "weekly", "Weekly"),
      window("monthly", "monthly", "Monthly"),
    ];
    expect(windowsForSidebarPreview(windows).map((entry) => entry.kind)).toEqual([
      "session",
      "weekly",
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
          { account: { key: "codex:a" }, window: { usedPercent: 40 } },
        ]),
      ),
    ).toBe(true);
  });

  it("hides the header aggregate when two accounts report the window", () => {
    expect(
      sidebarPreviewShowsAggregate(
        window("session", "primary", "Session", [
          { account: { key: "codex:a" }, window: { usedPercent: 40 } },
          { account: { key: "codex:b" }, window: { usedPercent: 10 } },
        ]),
      ),
    ).toBe(false);
  });

  it("ignores column gaps when counting accounts", () => {
    expect(
      sidebarPreviewShowsAggregate(
        window("session", "primary", "Session", [
          { account: { key: "codex:a" }, window: { usedPercent: 40 } },
          { account: { key: "codex:b" }, window: null },
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
