import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hasSidebarUsagePreview, windowsForSidebarPreview } from "./usageLimitsPreviewModel";

function window(
  kind: "session" | "weekly" | "monthly" | "other",
  id: string,
  label = id,
): {
  id: string;
  kind: typeof kind;
  label: string;
  members: [];
  columns: [];
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
    columns: [],
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
