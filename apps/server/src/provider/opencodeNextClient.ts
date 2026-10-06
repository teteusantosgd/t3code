import type {
  Agent,
  Command,
  Event as LegacyEvent,
  OpencodeClient,
  Part,
  PermissionRequest as LegacyPermissionRequest,
  ProviderListResponse,
  QuestionRequest as LegacyQuestionRequest,
} from "@opencode-ai/sdk/v2";
import type {
  FormField,
  FormInfo,
  ModelInfo,
  OpenCodeClient,
  OpenCodeEvent,
  PermissionRequest as NextPermissionRequest,
  ProviderInfo,
  SessionInfo,
  SessionMessageInfo,
} from "@opencode/client";

/**
 * Presents the legacy `@opencode-ai/sdk/v2` client the OpenCode adapter already
 * consumes, backed by an OpenCode 2 `@opencode/client`. The adapter stays on
 * the legacy event and method shapes. This module is the only place that
 * knows the `/api` protocol.
 *
 * Fork always creates a child session. A directory change moves that child,
 * never the session the caller asked to fork.
 */

type LegacyEventOf<T extends LegacyEvent["type"]> = Extract<LegacyEvent, { type: T }>;

interface TextPartState {
  readonly kind: "text" | "reasoning";
  readonly messageID: string;
  readonly partID: string;
  text: string;
  readonly start: number;
  end?: number;
}

interface ToolState {
  readonly messageID: string;
  readonly callID: string;
  name: string;
  input: Record<string, unknown>;
  inputText: string;
  title?: string;
  status: "pending" | "running" | "completed" | "error";
  output?: string;
  error?: string;
  start: number;
  end?: number;
}

interface CompatState {
  readonly assistantMessagesSeen: Set<string>;
  readonly textParts: Map<string, TextPartState>;
  readonly tools: Map<string, ToolState>;
  readonly lastUserMessageID: Map<string, string>;
  readonly permissionSessions: Map<string, string>;
  readonly formSessions: Map<string, FormInfo>;
  readonly switchedModel: Map<string, string>;
  readonly switchedAgent: Map<string, string>;
}

export interface NextProviderSummary {
  readonly id: string;
  readonly name: string;
  /** False for the public catalog published before an account connects. */
  readonly authenticated: boolean;
}

export interface NextModelSummary {
  readonly modelID: string;
  readonly providerID: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly variants: ReadonlyArray<{ readonly id: string }>;
}

function trimText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseProviderModelSlug(slug: string): { providerID: string; modelID: string } | undefined {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return undefined;
  return { providerID: slug.slice(0, separator), modelID: slug.slice(separator + 1) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textFromToolContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts: Array<string> = [];
  for (const entry of content) {
    if (isRecord(entry) && entry.type === "text" && typeof entry.text === "string") {
      texts.push(entry.text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function toNextPermissions(
  rules: ReadonlyArray<{
    readonly permission: string;
    readonly pattern: string;
    readonly action: string;
  }>,
): Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> {
  return rules.map((rule) => ({
    action: rule.permission,
    resource: rule.pattern,
    effect: rule.action === "allow" ? "allow" : rule.action === "deny" ? "deny" : "ask",
  }));
}

function toLegacyPermission(request: NextPermissionRequest): LegacyPermissionRequest {
  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: request.action,
    patterns: request.resources,
    ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
  } as unknown as LegacyPermissionRequest;
}

function formOptions(
  field: FormField,
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  if (!("options" in field) || !Array.isArray(field.options)) return [];
  return field.options.flatMap((option) =>
    typeof option.label === "string" && typeof option.value === "string"
      ? [{ label: option.label, value: option.value }]
      : [],
  );
}

function toLegacyQuestion(form: FormInfo): LegacyQuestionRequest {
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: form.fields.map((field) => ({
      header: field.title ?? field.key,
      question: field.title ?? field.key,
      options: formOptions(field),
      multiple: field.type === "multiselect",
    })),
  } as unknown as LegacyQuestionRequest;
}

function answerValues(value: unknown): Array<string> {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function toNextFormAnswer(
  fields: ReadonlyArray<FormField>,
  answers: ReadonlyArray<ReadonlyArray<string>>,
): Record<string, string | Array<string>> {
  const answer: Record<string, string | Array<string>> = {};
  fields.forEach((field, index) => {
    const values = answers[index] ?? [];
    if (values.length === 0) return;
    answer[field.key] = field.type === "multiselect" ? [...values] : values[0]!;
  });
  return answer;
}

/**
 * OpenCode 2 publishes a public model catalog before the signed-in accounts
 * exist. Only authenticated providers belong in the connected set.
 */
export function buildNextProviderList(
  providers: ReadonlyArray<NextProviderSummary>,
  models: ReadonlyArray<NextModelSummary>,
): { all: ProviderListResponse["all"]; connected: string[] } {
  const meta = new Map(providers.map((provider) => [provider.id, provider]));
  const connected = providers
    .filter((provider) => provider.authenticated)
    .map((provider) => provider.id);
  const authenticated = new Set(connected);
  const modelsByProvider = new Map<string, Record<string, unknown>>();
  for (const model of models) {
    if (!model.enabled || !authenticated.has(model.providerID)) continue;
    const bucket = modelsByProvider.get(model.providerID) ?? {};
    bucket[model.modelID] = {
      id: model.modelID,
      providerID: model.providerID,
      name: model.name,
      variants: Object.fromEntries(model.variants.map((variant) => [variant.id, {}])),
    };
    modelsByProvider.set(model.providerID, bucket);
  }
  const all = connected.map((id) => ({
    id,
    name: meta.get(id)?.name ?? id,
    source: "config" as const,
    env: [] as Array<string>,
    options: {} as Record<string, unknown>,
    models: (modelsByProvider.get(id) ?? {}) as ProviderListResponse["all"][number]["models"],
  }));
  return { all, connected };
}

function partKey(messageID: string, kind: string, ordinal: number): string {
  return `${messageID}:${kind}:${ordinal}`;
}

const INVENTORY_WARMUP_ATTEMPTS = 20;
const INVENTORY_WARMUP_DELAY_MS = 400;

export interface ProviderCatalogPage {
  readonly providers: ReadonlyArray<NextProviderSummary>;
  readonly models: ReadonlyArray<NextModelSummary>;
}

/**
 * The public "OpenCode Zen" catalog is stable for several seconds before
 * OpenCode Go attaches. That placeholder provider is not authenticated.
 * Keep reading until an authenticated provider list stays unchanged.
 */
export async function readSettledProviderCatalog(
  load: () => Promise<ProviderCatalogPage>,
  options?: {
    readonly attempts?: number;
    readonly delayMs?: number;
    readonly sleep?: (delayMs: number) => Promise<void>;
  },
): Promise<ProviderCatalogPage> {
  const attempts = options?.attempts ?? INVENTORY_WARMUP_ATTEMPTS;
  const delayMs = options?.delayMs ?? INVENTORY_WARMUP_DELAY_MS;
  const sleep =
    options?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let page = await load();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const signature = providerCatalogSignature(page);
    const providersReady = page.providers.some((provider) => provider.authenticated);
    await sleep(delayMs);
    page = await load();
    if (
      providersReady &&
      page.providers.length > 0 &&
      providerCatalogSignature(page) === signature
    ) {
      return page;
    }
  }
  return page;
}

function providerCatalogSignature(page: ProviderCatalogPage): string {
  const providerIds = page.providers
    .map((provider) => provider.id)
    .toSorted()
    .join(",");
  const counts = new Map<string, number>();
  for (const model of page.models) {
    if (!model.enabled) continue;
    counts.set(model.providerID, (counts.get(model.providerID) ?? 0) + 1);
  }
  const models = [...counts.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([providerID, count]) => `${providerID}:${count}`)
    .join(",");
  return `${providerIds}|${models}`;
}

function toLegacySession(session: Pick<SessionInfo, "id" | "parentID" | "location" | "revert">) {
  return {
    id: session.id,
    ...(session.parentID !== undefined ? { parentID: session.parentID } : {}),
    directory: session.location.directory,
    ...(session.revert !== undefined ? { revert: session.revert } : {}),
  };
}

export interface OpenCodeCompatClientInput {
  readonly client: OpenCodeClient;
  readonly directory: string;
}

export function createOpenCodeCompatClient(input: OpenCodeCompatClientInput): OpencodeClient {
  const { client, directory } = input;
  const location = { location: { directory } };
  const state: CompatState = {
    assistantMessagesSeen: new Set(),
    textParts: new Map(),
    tools: new Map(),
    lastUserMessageID: new Map(),
    permissionSessions: new Map(),
    formSessions: new Map(),
    switchedModel: new Map(),
    switchedAgent: new Map(),
  };

  const queue: Array<LegacyEvent> = [];
  const waiters: Array<(event: LegacyEvent | undefined) => void> = [];
  let closed = false;
  const push = (event: LegacyEvent) => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else queue.push(event);
  };
  const closeQueue = () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()?.(undefined);
  };
  const nextQueued = (): Promise<LegacyEvent | undefined> => {
    const queued = queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (closed) return Promise.resolve(undefined);
    return new Promise((resolve) => waiters.push(resolve));
  };

  const ensureAssistantMessage = (sessionID: string, messageID: string): Array<LegacyEvent> => {
    if (state.assistantMessagesSeen.has(messageID)) return [];
    state.assistantMessagesSeen.add(messageID);
    const parentID = state.lastUserMessageID.get(sessionID);
    return [
      {
        type: "message.updated",
        properties: {
          sessionID,
          info: {
            id: messageID,
            role: "assistant",
            ...(parentID !== undefined ? { parentID } : {}),
          },
        },
      } as unknown as LegacyEventOf<"message.updated">,
    ];
  };

  const emitTextPart = (
    part: TextPartState,
    messageID: string,
    sessionID: string,
  ): Array<LegacyEvent> => [
    ...ensureAssistantMessage(sessionID, messageID),
    {
      type: "message.part.updated",
      properties: {
        sessionID,
        part: {
          type: part.kind,
          id: part.partID,
          messageID: part.messageID,
          sessionID,
          text: part.text,
          time: { start: part.start, ...(part.end !== undefined ? { end: part.end } : {}) },
        },
      },
    } as unknown as LegacyEventOf<"message.part.updated">,
  ];

  const emitToolPart = (tool: ToolState, sessionID: string): Array<LegacyEvent> => [
    ...ensureAssistantMessage(sessionID, tool.messageID),
    {
      type: "message.part.updated",
      properties: {
        sessionID,
        part: {
          type: "tool",
          id: tool.callID,
          callID: tool.callID,
          messageID: tool.messageID,
          sessionID,
          tool: tool.name,
          state: {
            status: tool.status,
            input: tool.input,
            ...(tool.title !== undefined ? { title: tool.title } : {}),
            ...(tool.output !== undefined ? { output: tool.output } : {}),
            ...(tool.error !== undefined ? { error: tool.error } : {}),
            time: { start: tool.start, ...(tool.end !== undefined ? { end: tool.end } : {}) },
          },
        },
      },
    } as unknown as LegacyEventOf<"message.part.updated">,
  ];

  const translate = (event: OpenCodeEvent): Array<LegacyEvent> => {
    switch (event.type) {
      case "server.connected":
        return [
          {
            type: "server.connected",
            properties: {},
          } as unknown as LegacyEventOf<"server.connected">,
        ];

      case "session.created":
        return [
          {
            type: "session.created",
            properties: {
              info: {
                id: event.data.sessionID,
                ...(event.data.parentID !== undefined ? { parentID: event.data.parentID } : {}),
                ...(event.data.title !== undefined ? { title: event.data.title } : {}),
              },
            },
          } as unknown as LegacyEventOf<"session.created">,
        ];

      case "session.renamed":
        return [
          {
            type: "session.updated",
            properties: { info: { id: event.data.sessionID, title: event.data.title } },
          } as unknown as LegacyEventOf<"session.updated">,
        ];

      case "session.metadata.updated": {
        const title = trimText(event.data.metadata?.title);
        return title === undefined
          ? []
          : [
              {
                type: "session.updated",
                properties: { info: { id: event.data.sessionID, title } },
              } as unknown as LegacyEventOf<"session.updated">,
            ];
      }

      case "session.deleted":
        return [
          {
            type: "session.deleted",
            properties: { info: { id: event.data.sessionID } },
          } as unknown as LegacyEventOf<"session.deleted">,
        ];

      case "session.forked":
        return [
          {
            type: "session.created",
            properties: { info: { id: event.data.sessionID, parentID: event.data.parentID } },
          } as unknown as LegacyEventOf<"session.created">,
        ];

      case "session.status":
        return [
          {
            type: "session.status",
            properties: { sessionID: event.data.sessionID, status: event.data.status },
          } as unknown as LegacyEventOf<"session.status">,
        ];

      case "session.idle":
      case "session.execution.succeeded":
        return [
          {
            type: "session.status",
            properties: { sessionID: event.data.sessionID, status: { type: "idle" } },
          } as unknown as LegacyEventOf<"session.status">,
        ];

      case "session.execution.started":
        return [
          {
            type: "session.status",
            properties: { sessionID: event.data.sessionID, status: { type: "busy" } },
          } as unknown as LegacyEventOf<"session.status">,
        ];

      case "session.execution.interrupted":
        return [
          {
            type: "session.status",
            properties: { sessionID: event.data.sessionID, status: { type: "idle" } },
          } as unknown as LegacyEventOf<"session.status">,
          {
            type: "session.error",
            properties: {
              sessionID: event.data.sessionID,
              error: { name: "MessageAbortedError", data: { message: event.data.reason } },
            },
          } as unknown as LegacyEventOf<"session.error">,
        ];

      case "session.execution.failed":
        return [
          {
            type: "session.status",
            properties: { sessionID: event.data.sessionID, status: { type: "idle" } },
          } as unknown as LegacyEventOf<"session.status">,
          {
            type: "session.error",
            properties: {
              sessionID: event.data.sessionID,
              error: { name: "ProviderError", data: { message: event.data.error.message } },
            },
          } as unknown as LegacyEventOf<"session.error">,
        ];

      case "session.retry.scheduled":
        return [
          {
            type: "session.status",
            properties: {
              sessionID: event.data.sessionID,
              status: {
                type: "retry",
                attempt: event.data.attempt,
                message: event.data.error.message,
              },
            },
          } as unknown as LegacyEventOf<"session.status">,
        ];

      case "session.text.started":
      case "session.reasoning.started": {
        const kind = event.type === "session.text.started" ? "text" : "reasoning";
        const key = partKey(event.data.assistantMessageID, kind, event.data.ordinal);
        const part: TextPartState = {
          kind,
          messageID: event.data.assistantMessageID,
          partID: key,
          text: "",
          start: event.created,
        };
        state.textParts.set(key, part);
        return emitTextPart(part, event.data.assistantMessageID, event.data.sessionID);
      }

      case "session.text.delta":
      case "session.reasoning.delta": {
        const kind = event.type === "session.text.delta" ? "text" : "reasoning";
        const key = partKey(event.data.assistantMessageID, kind, event.data.ordinal);
        const part = state.textParts.get(key);
        if (part === undefined) return [];
        part.text += event.data.delta;
        return emitTextPart(part, event.data.assistantMessageID, event.data.sessionID);
      }

      case "session.text.ended":
      case "session.reasoning.ended": {
        const kind = event.type === "session.text.ended" ? "text" : "reasoning";
        const key = partKey(event.data.assistantMessageID, kind, event.data.ordinal);
        const part = state.textParts.get(key);
        if (part === undefined) return [];
        part.text = event.data.text;
        part.end = event.created;
        return emitTextPart(part, event.data.assistantMessageID, event.data.sessionID);
      }

      case "session.step.ended":
        return [
          ...ensureAssistantMessage(event.data.sessionID, event.data.assistantMessageID),
          {
            type: "message.part.updated",
            properties: {
              sessionID: event.data.sessionID,
              part: {
                type: "step-finish",
                id: `${event.data.assistantMessageID}:step:${event.id}`,
                messageID: event.data.assistantMessageID,
                sessionID: event.data.sessionID,
                tokens: event.data.tokens,
              },
            },
          } as unknown as LegacyEventOf<"message.part.updated">,
        ];

      case "session.step.failed":
        return [
          {
            type: "session.error",
            properties: {
              sessionID: event.data.sessionID,
              error: { name: "ProviderError", data: { message: event.data.error.message } },
            },
          } as unknown as LegacyEventOf<"session.error">,
        ];

      case "session.tool.input.started": {
        const tool: ToolState = {
          messageID: event.data.assistantMessageID,
          callID: event.data.id,
          name: event.data.name,
          input: {},
          inputText: "",
          status: "pending",
          start: event.created,
        };
        state.tools.set(event.data.id, tool);
        return emitToolPart(tool, event.data.sessionID);
      }

      case "session.tool.input.delta": {
        const tool = state.tools.get(event.data.id);
        if (tool === undefined) return [];
        tool.inputText += event.data.delta;
        return [];
      }

      case "session.tool.input.ended": {
        const tool = state.tools.get(event.data.id);
        if (tool === undefined) return [];
        tool.inputText = event.data.text;
        try {
          const parsed: unknown = JSON.parse(event.data.text);
          if (isRecord(parsed)) tool.input = parsed;
        } catch {
          // Partial tool input is not always valid JSON.
        }
        tool.status = "running";
        return emitToolPart(tool, event.data.sessionID);
      }

      case "session.tool.called": {
        const tool = state.tools.get(event.data.id);
        if (tool === undefined) return [];
        tool.input = event.data.input;
        tool.status = "running";
        return emitToolPart(tool, event.data.sessionID);
      }

      case "session.tool.progress": {
        const tool = state.tools.get(event.data.id);
        if (tool === undefined) return [];
        const title = trimText(event.data.metadata.title);
        if (title !== undefined) tool.title = title;
        return emitToolPart(tool, event.data.sessionID);
      }

      case "session.tool.success": {
        const tool = state.tools.get(event.data.id);
        if (tool === undefined) return [];
        tool.status = "completed";
        const output = textFromToolContent(event.data.content);
        if (output !== undefined) tool.output = output;
        tool.end = event.created;
        return emitToolPart(tool, event.data.sessionID);
      }

      case "session.tool.failed": {
        const tool = state.tools.get(event.data.id);
        if (tool === undefined) return [];
        tool.status = "error";
        tool.error = event.data.error.message;
        tool.end = event.created;
        return emitToolPart(tool, event.data.sessionID);
      }

      case "session.compaction.ended":
        return [
          {
            type: "session.compacted",
            properties: { sessionID: event.data.sessionID },
          } as unknown as LegacyEventOf<"session.compacted">,
        ];

      case "permission.asked": {
        state.permissionSessions.set(event.data.id, event.data.sessionID);
        return [
          {
            type: "permission.asked",
            properties: toLegacyPermission(event.data),
          } as unknown as LegacyEventOf<"permission.asked">,
        ];
      }

      case "permission.replied":
        return [
          {
            type: "permission.replied",
            properties: {
              sessionID: event.data.sessionID,
              requestID: event.data.requestID,
              reply: event.data.reply,
            },
          } as unknown as LegacyEventOf<"permission.replied">,
        ];

      case "form.created":
        state.formSessions.set(event.data.form.id, event.data.form);
        return [
          {
            type: "question.asked",
            properties: toLegacyQuestion(event.data.form),
          } as unknown as LegacyEventOf<"question.asked">,
        ];

      case "form.replied": {
        const form = state.formSessions.get(event.data.id);
        const fields = form?.fields ?? [];
        const answers = fields.map((field) => answerValues(event.data.answer[field.key]));
        return [
          {
            type: "question.replied",
            properties: {
              sessionID: event.data.sessionID,
              requestID: event.data.id,
              answers,
            },
          } as unknown as LegacyEventOf<"question.replied">,
        ];
      }

      case "form.cancelled":
        return [
          {
            type: "question.rejected",
            properties: { sessionID: event.data.sessionID, requestID: event.data.id },
          } as unknown as LegacyEventOf<"question.rejected">,
        ];

      default:
        return [];
    }
  };

  const applySessionState = async (
    sessionID: string,
    model: { providerID: string; modelID: string; variant?: string } | undefined,
    agent: string | undefined,
  ): Promise<void> => {
    if (model !== undefined) {
      const key = `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}`;
      if (state.switchedModel.get(sessionID) !== key) {
        await client.session.switchModel({
          sessionID,
          model: {
            id: model.modelID,
            providerID: model.providerID,
            ...(model.variant !== undefined ? { variant: model.variant } : {}),
          },
        });
        state.switchedModel.set(sessionID, key);
      }
    }
    if (agent !== undefined && state.switchedAgent.get(sessionID) !== agent) {
      await client.session.switchAgent({ sessionID, agent });
      state.switchedAgent.set(sessionID, agent);
    }
  };

  const toParts = (message: SessionMessageInfo): Array<Part> => {
    if (message.type !== "assistant") return [];
    return message.content.flatMap((entry, index): Array<Part> => {
      if (entry.type === "text") {
        return [
          {
            type: "text",
            id: `${message.id}:text:${index}`,
            messageID: message.id,
            text: entry.text,
            time: {
              start: message.time.created,
              ...(message.time.completed !== undefined ? { end: message.time.completed } : {}),
            },
          } as unknown as Part,
        ];
      }
      if (entry.type === "reasoning") {
        return [
          {
            type: "reasoning",
            id: `${message.id}:reasoning:${index}`,
            messageID: message.id,
            text: entry.text,
            time:
              entry.time?.created !== undefined
                ? {
                    start: entry.time.created,
                    ...(entry.time.completed !== undefined ? { end: entry.time.completed } : {}),
                  }
                : undefined,
          } as unknown as Part,
        ];
      }
      if (entry.type !== "tool") return [];
      const toolState = entry.state;
      return [
        {
          type: "tool",
          id: entry.id,
          callID: entry.id,
          messageID: message.id,
          tool: entry.name,
          state: {
            status:
              toolState.status === "completed"
                ? "completed"
                : toolState.status === "error"
                  ? "error"
                  : toolState.status === "streaming"
                    ? "pending"
                    : "running",
            input: "input" in toolState ? toolState.input : {},
            ...("content" in toolState ? { output: textFromToolContent(toolState.content) } : {}),
            ...(toolState.status === "error" ? { error: toolState.error.message } : {}),
            time: {
              start: entry.time.created,
              ...(entry.time.completed !== undefined ? { end: entry.time.completed } : {}),
            },
          },
        } as unknown as Part,
      ];
    });
  };

  const rememberUserMessage = (sessionID: string, messageID: string | undefined) => {
    const previous = state.lastUserMessageID.get(sessionID);
    if (messageID !== undefined) state.lastUserMessageID.set(sessionID, messageID);
    return () => {
      if (previous !== undefined) state.lastUserMessageID.set(sessionID, previous);
      else state.lastUserMessageID.delete(sessionID);
    };
  };

  const fileParts = (
    parts:
      | ReadonlyArray<{
          type: string;
          text?: string;
          filename?: string;
          url?: string;
        }>
      | undefined,
  ) =>
    (parts ?? [])
      .filter((part) => part.type === "file" && typeof part.url === "string")
      .map((part) => ({
        uri: part.url as string,
        ...(part.filename !== undefined ? { name: part.filename } : {}),
      }));

  const textParts = (parts: ReadonlyArray<{ type: string; text?: string }> | undefined): string =>
    (parts ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");

  const compat = {
    global: {
      health: async () => {
        const info = await client.server.info();
        return { data: { healthy: true as const, version: info.version } };
      },
    },
    provider: {
      list: async () => {
        const page = await readSettledProviderCatalog(async () => {
          const [providers, models] = await Promise.all([
            client.provider.list(location),
            client.model.list(location),
          ]);
          return {
            providers: (providers.data satisfies ReadonlyArray<ProviderInfo>).map((provider) => ({
              id: provider.id,
              name: provider.name,
              authenticated: provider.headers !== undefined,
            })),
            models: models.data satisfies ReadonlyArray<ModelInfo>,
          };
        });
        const { all, connected } = buildNextProviderList(page.providers, page.models);
        return { data: { all, connected, default: {} } };
      },
    },
    app: {
      agents: async () => ({
        data: (await client.agent.list(location)).data.map(
          (agent): Agent =>
            ({
              name: agent.id,
              description: agent.description,
              mode: agent.mode === "all" ? "primary" : agent.mode,
              hidden: agent.hidden,
              permission: agent.permissions,
              options: {},
            }) as unknown as Agent,
        ),
      }),
      skills: async () => ({
        data: (await client.skill.list(location)).data.map((skill) => ({
          name: skill.name,
          ...(skill.description === undefined ? {} : { description: skill.description }),
          location: skill.path,
        })),
      }),
    },
    command: {
      list: async (): Promise<{ data: Array<Command> }> => ({
        data: (await client.command.list(location)).data.map(
          (command) =>
            ({
              name: command.name,
              ...(command.description === undefined ? {} : { description: command.description }),
              hints: [],
            }) as unknown as Command,
        ),
      }),
    },
    mcp: {
      add: async (input: { name: string; config: unknown }) => {
        await client.mcp.add({
          server: input.name,
          location: location.location,
          config: input.config as never,
        });
        return { data: {} };
      },
    },
    session: {
      create: async (input: {
        title?: string;
        permission?: ReadonlyArray<{ permission: string; pattern: string; action: string }>;
      }) => {
        const session = await client.session.create({
          ...(input.title !== undefined ? { title: input.title } : {}),
          location: location.location,
          ...(input.permission !== undefined
            ? { permissions: toNextPermissions(input.permission) }
            : {}),
        });
        return { data: toLegacySession(session) };
      },
      get: async (input: { sessionID: string }) => ({
        data: toLegacySession(await client.session.get({ sessionID: input.sessionID })),
      }),
      update: async (input: {
        sessionID: string;
        permission?: ReadonlyArray<{ permission: string; pattern: string; action: string }>;
      }) => {
        await client.session.update({
          sessionID: input.sessionID,
          ...(input.permission !== undefined
            ? { permissions: toNextPermissions(input.permission) }
            : {}),
        });
        return { data: {} };
      },
      fork: async (input: { sessionID: string; messageID?: string; directory?: string }) => {
        const forked = await client.session.fork({
          sessionID: input.sessionID,
          ...(input.messageID !== undefined ? { before: input.messageID } : {}),
        });
        if (forked.id === input.sessionID) {
          throw new Error("OpenCode fork returned the original session.");
        }
        if (input.directory !== undefined && input.directory !== forked.location.directory) {
          await client.session.move({ sessionID: forked.id, directory: input.directory });
          return {
            data: toLegacySession({ ...forked, location: { directory: input.directory } }),
          };
        }
        return { data: toLegacySession(forked) };
      },
      abort: async (input: { sessionID: string }) => {
        await client.session.interrupt({ sessionID: input.sessionID });
        return { data: {} };
      },
      children: async (input: { sessionID: string }) => {
        const sessions = await client.session.list({ directory, parentID: input.sessionID });
        return { data: sessions.data.map((session) => ({ id: session.id })) };
      },
      status: async () => {
        const active = await client.session.active();
        return {
          data: Object.fromEntries(
            Object.keys(active).map((sessionID) => [sessionID, { type: "busy" as const }]),
          ),
        };
      },
      command: async (input: {
        sessionID: string;
        messageID?: string;
        command: string;
        arguments?: string;
        model?: string | { providerID: string; modelID: string };
        agent?: string;
        variant?: string;
        parts?: ReadonlyArray<{ type: string; text?: string; filename?: string; url?: string }>;
      }) => {
        const commandModel =
          typeof input.model === "string" ? parseProviderModelSlug(input.model) : input.model;
        await applySessionState(
          input.sessionID,
          commandModel !== undefined
            ? {
                providerID: commandModel.providerID,
                modelID: commandModel.modelID,
                ...(input.variant !== undefined ? { variant: input.variant } : {}),
              }
            : undefined,
          input.agent,
        );
        const files = fileParts(input.parts);
        const restoreUserMessage = rememberUserMessage(input.sessionID, input.messageID);
        try {
          await client.session.command({
            sessionID: input.sessionID,
            name: input.command,
            text: input.arguments ?? textParts(input.parts),
            ...(files.length > 0 ? { files } : {}),
          });
        } catch (error) {
          restoreUserMessage();
          throw error;
        }
        if (input.messageID !== undefined) {
          push({
            type: "message.updated",
            properties: { sessionID: input.sessionID, info: { id: input.messageID, role: "user" } },
          } as unknown as LegacyEvent);
        }
        return { data: {} };
      },
      promptAsync: async (input: {
        sessionID: string;
        messageID?: string;
        model?: { providerID: string; modelID: string };
        agent?: string;
        variant?: string;
        system?: string;
        parts?: ReadonlyArray<{ type: string; text?: string; filename?: string; url?: string }>;
      }) => {
        await applySessionState(
          input.sessionID,
          input.model !== undefined
            ? {
                providerID: input.model.providerID,
                modelID: input.model.modelID,
                ...(input.variant !== undefined ? { variant: input.variant } : {}),
              }
            : undefined,
          input.agent,
        );
        const system = input.system?.trim();
        const body = textParts(input.parts);
        const text = system && system.length > 0 ? `${system}\n\n${body}` : body;
        const files = fileParts(input.parts);
        const restoreUserMessage = rememberUserMessage(input.sessionID, input.messageID);
        try {
          await client.session.prompt({
            sessionID: input.sessionID,
            ...(input.messageID !== undefined ? { id: input.messageID } : {}),
            text,
            ...(files.length > 0 ? { files } : {}),
          });
        } catch (error) {
          restoreUserMessage();
          throw error;
        }
        if (input.messageID !== undefined) {
          push({
            type: "message.updated",
            properties: { sessionID: input.sessionID, info: { id: input.messageID, role: "user" } },
          } as unknown as LegacyEvent);
        }
        return { data: {} };
      },
      prompt: async (input: {
        sessionID: string;
        messageID?: string;
        model?: { providerID: string; modelID: string };
        agent?: string;
        variant?: string;
        system?: string;
        parts?: ReadonlyArray<{ type: string; text?: string; filename?: string; url?: string }>;
      }) => {
        await applySessionState(
          input.sessionID,
          input.model !== undefined
            ? {
                providerID: input.model.providerID,
                modelID: input.model.modelID,
                ...(input.variant !== undefined ? { variant: input.variant } : {}),
              }
            : undefined,
          input.agent,
        );
        const system = input.system?.trim();
        const body = textParts(input.parts);
        const text = system && system.length > 0 ? `${system}\n\n${body}` : body;
        const files = fileParts(input.parts);
        await client.session.prompt({
          sessionID: input.sessionID,
          ...(input.messageID !== undefined ? { id: input.messageID } : {}),
          text,
          ...(files.length > 0 ? { files } : {}),
        });
        await client.session.wait({ sessionID: input.sessionID });
        const messages = await client.session.context({ sessionID: input.sessionID });
        const assistant = messages.toReversed().find((message) => message.type === "assistant");
        return {
          data: {
            info:
              assistant !== undefined
                ? {
                    id: assistant.id,
                    role: "assistant" as const,
                    ...(assistant.error !== undefined ? { error: assistant.error } : {}),
                  }
                : {},
            parts: assistant !== undefined ? toParts(assistant) : [],
          },
        };
      },
      summarize: async (input: { sessionID: string }) => {
        await client.session.compact({ sessionID: input.sessionID });
        return { data: {} };
      },
      messages: async (input: { sessionID: string }) => ({
        data: (await client.session.context({ sessionID: input.sessionID })).map((message) => ({
          info: {
            id: message.id,
            role: message.type === "assistant" ? "assistant" : "user",
          },
          parts: toParts(message),
        })),
      }),
      message: async (input: { sessionID: string; messageID: string }) => {
        const message = await client.session.message.get({
          sessionID: input.sessionID,
          messageID: input.messageID,
        });
        return {
          data: {
            info: { id: message.id, role: message.type === "assistant" ? "assistant" : "user" },
            parts: toParts(message),
          },
        };
      },
    },
    permission: {
      list: async () => {
        const requests = await client.permission.request.list(location);
        for (const request of requests.data) {
          state.permissionSessions.set(request.id, request.sessionID);
        }
        return { data: requests.data.map(toLegacyPermission) };
      },
      reply: async (input: { requestID: string; reply: "once" | "always" | "reject" }) => {
        const sessionID = state.permissionSessions.get(input.requestID);
        if (sessionID === undefined) {
          throw new Error(`Unknown OpenCode permission request ${input.requestID}`);
        }
        await client.permission.reply({
          sessionID,
          requestID: input.requestID,
          decision: input.reply,
        });
        return { data: {} };
      },
    },
    question: {
      list: async () => {
        const forms = await client.form.list(location);
        for (const form of forms.data) state.formSessions.set(form.id, form);
        return { data: forms.data.map(toLegacyQuestion) };
      },
      reply: async (input: {
        requestID: string;
        answers: ReadonlyArray<ReadonlyArray<string>>;
      }) => {
        const form = state.formSessions.get(input.requestID);
        if (form === undefined) {
          throw new Error(`Unknown OpenCode form ${input.requestID}`);
        }
        await client.session.form.reply({
          sessionID: form.sessionID,
          formID: form.id,
          answer: toNextFormAnswer(form.fields, input.answers),
        });
        return { data: {} };
      },
    },
    event: {
      subscribe: async (
        _input: unknown,
        options?: { signal?: AbortSignal; onSseError?: (error: unknown) => void },
      ) => {
        const abort = new AbortController();
        const signal = options?.signal;
        if (signal !== undefined) {
          if (signal.aborted) abort.abort();
          else signal.addEventListener("abort", () => abort.abort(), { once: true });
        }
        void (async () => {
          try {
            for await (const event of client.event.subscribe({ signal: abort.signal })) {
              for (const translated of translate(event)) push(translated);
            }
          } catch (error) {
            if (!abort.signal.aborted) options?.onSseError?.(error);
          } finally {
            closeQueue();
          }
        })();
        return {
          stream: {
            [Symbol.asyncIterator]() {
              return {
                next: async () => {
                  const event = await nextQueued();
                  return event === undefined
                    ? { done: true as const, value: undefined }
                    : { done: false as const, value: event };
                },
              };
            },
          },
        };
      },
    },
  };

  return compat as unknown as OpencodeClient;
}
