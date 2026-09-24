import { describe, expect, it } from "vite-plus/test";

import type { TerminalSummary } from "@t3tools/contracts";
import { DEFAULT_TERMINAL_ID } from "@t3tools/contracts";

import {
  getTerminalLabel,
  isAgentTerminalId,
  nextTerminalId,
  resolveTerminalSessionLabel,
} from "./terminalLabels.ts";

describe("getTerminalLabel", () => {
  it("uses the numeric suffix for term-* ids", () => {
    expect(getTerminalLabel(DEFAULT_TERMINAL_ID)).toBe("Terminal 1");
    expect(getTerminalLabel("term-2")).toBe("Terminal 2");
    expect(getTerminalLabel("term-12")).toBe("Terminal 12");
    expect(getTerminalLabel("terminal-3")).toBe("Terminal 3");
  });

  it("labels agent-* ids as agent terminals", () => {
    expect(getTerminalLabel("agent-1")).toBe("Agent 1");
    expect(getTerminalLabel("agent-7")).toBe("Agent 7");
  });

  it("falls back to the raw id for unknown shapes", () => {
    expect(getTerminalLabel("custom-session")).toBe("custom-session");
  });
});

describe("resolveTerminalSessionLabel", () => {
  it("prefers a non-empty summary label", () => {
    const summary = { label: "  bun  " } as Pick<TerminalSummary, "label">;
    expect(resolveTerminalSessionLabel("term-1", summary)).toBe("bun");
  });

  it("falls back to getTerminalLabel when summary is missing or blank", () => {
    expect(resolveTerminalSessionLabel(DEFAULT_TERMINAL_ID, { label: "   " })).toBe("Terminal 1");
    expect(resolveTerminalSessionLabel(DEFAULT_TERMINAL_ID, null)).toBe("Terminal 1");
    expect(resolveTerminalSessionLabel("term-2", undefined)).toBe("Terminal 2");
  });
});

describe("nextTerminalId", () => {
  it("allocates term-1 when no terminals are listed yet", () => {
    expect(nextTerminalId([])).toBe(DEFAULT_TERMINAL_ID);
  });

  it("allocates term-2 when only term-1 exists", () => {
    expect(nextTerminalId([DEFAULT_TERMINAL_ID])).toBe("term-2");
  });

  it("skips over taken term-N slots", () => {
    expect(nextTerminalId([DEFAULT_TERMINAL_ID, "term-2", "term-3"])).toBe("term-4");
    expect(nextTerminalId([DEFAULT_TERMINAL_ID, "term-3"])).toBe("term-2");
    expect(nextTerminalId(["term-2", "term-3"])).toBe("term-1");
  });

  it("ignores blank/whitespace-only ids", () => {
    expect(nextTerminalId(["", "  ", DEFAULT_TERMINAL_ID])).toBe("term-2");
    expect(nextTerminalId(["", "  "])).toBe("term-1");
  });
});

describe("agent terminal ids", () => {
  it("allocates agent ids independently of user terminals", () => {
    expect(nextTerminalId([DEFAULT_TERMINAL_ID, "term-2"], "agent")).toBe("agent-1");
    expect(nextTerminalId(["agent-1", DEFAULT_TERMINAL_ID], "agent")).toBe("agent-2");
  });

  it("recognizes only agent-N ids", () => {
    expect(isAgentTerminalId("agent-1")).toBe(true);
    expect(isAgentTerminalId("agent-12")).toBe(true);
    expect(isAgentTerminalId(DEFAULT_TERMINAL_ID)).toBe(false);
    expect(isAgentTerminalId("agent-")).toBe(false);
    expect(isAgentTerminalId("my-agent-1")).toBe(false);
  });
});
