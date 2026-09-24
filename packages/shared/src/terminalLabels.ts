import type { TerminalSummary } from "@t3tools/contracts";

/**
 * Id prefix for terminals an agent opened through the `terminal_*` MCP tools.
 * Clients only ever allocate `term-N`, so the prefix alone separates the
 * agent's terminals from the user's without any extra persisted state.
 */
export const AGENT_TERMINAL_ID_PREFIX = "agent";

export function isAgentTerminalId(terminalId: string): boolean {
  return /^agent-\d+$/.test(terminalId);
}

/** Human-readable label for a terminal tab; matches mobile and web sidebars. */
export function getTerminalLabel(terminalId: string): string {
  const numericSuffix = /^term(?:inal)?-(\d+)$/i.exec(terminalId)?.[1];
  if (numericSuffix) {
    return `Terminal ${numericSuffix}`;
  }
  const agentSuffix = /^agent-(\d+)$/.exec(terminalId)?.[1];
  if (agentSuffix) {
    return `Agent ${agentSuffix}`;
  }

  return terminalId;
}

/** Prefer server summary label when present; otherwise fall back to `getTerminalLabel`. */
export function resolveTerminalSessionLabel(
  terminalId: string,
  summary: Pick<TerminalSummary, "label"> | null | undefined,
): string {
  const trimmed = summary?.label?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  return getTerminalLabel(terminalId);
}

/**
 * Client-side terminal id allocator. Ids are ALWAYS chosen by the client and sent explicitly
 * on every `terminal.open` / `terminal.attach` call — the server never allocates.
 *
 * Returns the lowest unused `<prefix>-N` id (starting at `term-1`), skipping any ids already in
 * `existingTerminalIds`.
 */
export function nextTerminalId(
  existingTerminalIds: ReadonlyArray<string>,
  prefix: string = "term",
): string {
  const usedIds = new Set(existingTerminalIds.filter((id) => id.trim().length > 0));
  let nextIndex = 1;
  while (usedIds.has(`${prefix}-${nextIndex}`)) {
    nextIndex += 1;
  }

  return `${prefix}-${nextIndex}`;
}
