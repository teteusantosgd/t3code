import type { TerminalSummary } from "@t3tools/contracts";

/** Id prefix reserved for terminals opened through the terminal MCP tools. */
export const AGENT_TERMINAL_ID_PREFIX = "agent";

export function isAgentTerminalId(terminalId: string): boolean {
  return /^agent-\d+$/.test(terminalId);
}

function terminalNumber(terminalId: string): string | undefined {
  return /^term(?:inal)?-(\d+)(?:-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})?$/i.exec(
    terminalId,
  )?.[1];
}

/** Human-readable label for a terminal tab; matches mobile and web sidebars. */
export function getTerminalLabel(terminalId: string): string {
  const numericSuffix = terminalNumber(terminalId);
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
 * Returns the lowest unused `term-N` number. When metadata is unavailable,
 * callers append a UUID so an unseen host session cannot be reused accidentally.
 */
export function nextTerminalId(
  existingTerminalIds: ReadonlyArray<string>,
  uniqueSuffix?: string,
): string {
  const usedNumbers = new Set(existingTerminalIds.map(terminalNumber));
  let nextIndex = 1;
  while (usedNumbers.has(String(nextIndex))) {
    nextIndex += 1;
  }

  return `term-${nextIndex}${uniqueSuffix === undefined ? "" : `-${uniqueSuffix}`}`;
}

/** Returns the lowest unused agent-N id. */
export function nextAgentTerminalId(existingTerminalIds: ReadonlyArray<string>): string {
  const usedIds = new Set(existingTerminalIds);
  let nextIndex = 1;
  while (usedIds.has(`${AGENT_TERMINAL_ID_PREFIX}-${nextIndex}`)) {
    nextIndex += 1;
  }
  return `${AGENT_TERMINAL_ID_PREFIX}-${nextIndex}`;
}
