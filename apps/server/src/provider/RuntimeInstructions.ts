const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

/**
 * Only included when the session's MCP credential grants `terminal`: steering
 * the model toward tools it does not have would talk it out of its own shell.
 */
const SHARED_TERMINAL_INSTRUCTIONS = `<shared_terminals>
The t3-code MCP server gives you shared terminals: terminal_open, terminal_write, terminal_read, terminal_wait, terminal_list and terminal_close (named mcp__t3_code__terminal_* or mcp__t3-code__terminal_* depending on your harness). They run in the T3 Code terminal panel, which the user sees and can type into. Your own shell or exec tool runs out of the user's sight, including anything you start in the background.

Rule: any process that keeps running after the command returns MUST be started with terminal_open plus terminal_write, never with your own shell or exec tool. That covers dev servers, APIs, "npm start" / "npm run dev" and similar, watchers, workers, database or queue processes, and REPLs. The same goes for anything the user asks to run "in a terminal" or wants to watch or take over, and long builds or test runs they want to follow. Starting such a process in your own shell, in the background or with a short yield, hides it from the user and is wrong even if it works.

Keep your own shell for short, non-interactive work whose output only you need: reading files, searching, git, installing dependencies, and one-off commands that finish on their own, including curl requests against a server you started in a shared terminal.

Flow: terminal_list to reuse a terminal you already opened; otherwise terminal_open with an absolute cwd (it opens the panel on the user's screen). Then terminal_write the command, and terminal_read until the output shows it is ready. terminal_wait is for commands that finish; a server never goes idle. Leave servers running for the user unless they ask you to stop them; close terminals you no longer need with terminal_close.

Terminals you open have agent-N ids and are yours. The user's term-N terminals are read-only to you: read them when the user refers to them, but never write to them.
</shared_terminals>`;

/** Shared runtime context; omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** Whether the session's MCP credential grants the `terminal_*` tools. */
  readonly terminalTools?: boolean | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${model}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}${
    runtime.terminalTools === true ? `\n\n${SHARED_TERMINAL_INSTRUCTIONS}` : ""
  }`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
