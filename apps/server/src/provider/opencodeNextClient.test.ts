import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import { describe, expect, it } from "vite-plus/test";

import {
  buildNextProviderList,
  createOpenCodeCompatClient,
  readSettledProviderCatalog,
} from "./opencodeNextClient.ts";

function session(id: string, directory: string) {
  return {
    id,
    projectID: "proj",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    location: { directory },
  };
}

describe("buildNextProviderList", () => {
  it("lists models only for authenticated accounts, not the public catalog", () => {
    const list = buildNextProviderList(
      [
        { id: "opencode", name: "OpenCode Zen", authenticated: false },
        { id: "opencode-go", name: "OpenCode Go", authenticated: true },
      ],
      [
        {
          modelID: "big-pickle",
          providerID: "opencode",
          name: "Big Pickle",
          enabled: true,
          variants: [{ id: "high" }],
        },
        {
          modelID: "gpt-6-luna",
          providerID: "opencode-go",
          name: "GPT-6 Luna",
          enabled: true,
          variants: [],
        },
      ],
    );
    expect(list.connected).toEqual(["opencode-go"]);
    expect(list.all).toHaveLength(1);
    expect(list.all[0]?.models["gpt-6-luna"]?.name).toBe("GPT-6 Luna");
    expect(list.all[0]?.models["big-pickle"]).toBeUndefined();
  });
});

function model(providerID: string, modelID: string) {
  return {
    modelID,
    providerID,
    name: modelID,
    enabled: true,
    variants: [],
  };
}

describe("readSettledProviderCatalog", () => {
  it("does not stop on the stable public catalog before OpenCode Go authenticates", async () => {
    const zen = {
      providers: [{ id: "opencode", name: "OpenCode Zen", authenticated: false }],
      models: [model("opencode", "big-pickle")],
    };
    const accounts = {
      providers: [
        { id: "opencode", name: "Personal / OpenCode", authenticated: true },
        { id: "opencode-go", name: "OpenCode Go", authenticated: true },
      ],
      models: [model("opencode", "personal"), model("opencode-go", "go-model")],
    };
    const pages = [zen, zen, accounts, accounts];
    let calls = 0;
    const page = await readSettledProviderCatalog(
      async () => pages[Math.min(calls++, pages.length - 1)]!,
      { attempts: 6, delayMs: 0, sleep: async () => undefined },
    );
    expect(calls).toBe(4);
    expect(page.providers.map((provider) => provider.id)).toEqual(["opencode", "opencode-go"]);
    expect(buildNextProviderList(page.providers, page.models).connected).toEqual([
      "opencode",
      "opencode-go",
    ]);
  });

  it("returns the free catalog when no connected provider appears", async () => {
    let calls = 0;
    const page = await readSettledProviderCatalog(
      async () => {
        calls += 1;
        return { providers: [], models: [model("opencode", "free-model")] };
      },
      { attempts: 2, delayMs: 0, sleep: async () => undefined },
    );
    expect(calls).toBe(3);
    expect(page.models.map((entry) => entry.providerID)).toEqual(["opencode"]);
  });
});

describe("createOpenCodeCompatClient", () => {
  it("forks into a child session and moves only that child", async () => {
    const moved: Array<{ sessionID: string; directory: string }> = [];
    const forked: Array<{ sessionID: string; before?: string }> = [];
    const client = {
      session: {
        fork: async (input: { sessionID: string; before?: string }) => {
          forked.push(input);
          return session("ses_child", "/original");
        },
        move: async (input: { sessionID: string; directory: string }) => {
          moved.push(input);
        },
      },
    } as unknown as OpenCodeClient;

    const compat = createOpenCodeCompatClient({ client, directory: "/original" });
    const result = await compat.session.fork({
      sessionID: "ses_parent",
      directory: "/worktree",
    });

    expect(forked).toEqual([{ sessionID: "ses_parent" }]);
    expect(moved).toEqual([{ sessionID: "ses_child", directory: "/worktree" }]);
    expect(result.data?.id).toBe("ses_child");
    expect(result.data?.directory).toBe("/worktree");
  });

  it("passes a rewind boundary to the native fork and leaves the directory alone", async () => {
    const forked: Array<{ sessionID: string; before?: string }> = [];
    let moved = false;
    const client = {
      session: {
        fork: async (input: { sessionID: string; before?: string }) => {
          forked.push(input);
          return session("ses_child", "/work");
        },
        move: async () => {
          moved = true;
        },
      },
    } as unknown as OpenCodeClient;

    const compat = createOpenCodeCompatClient({ client, directory: "/work" });
    const result = await compat.session.fork({
      sessionID: "ses_parent",
      messageID: "msg_boundary",
      directory: "/work",
    });

    expect(forked).toEqual([{ sessionID: "ses_parent", before: "msg_boundary" }]);
    expect(moved).toBe(false);
    expect(result.data?.id).toBe("ses_child");
  });

  it("translates text, tools, and form answers in field order", async () => {
    const events = [
      {
        id: "evt_text",
        created: 10,
        type: "session.text.started",
        data: { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0 },
      },
      {
        id: "evt_delta",
        created: 11,
        type: "session.text.delta",
        data: { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, delta: "Hi" },
      },
      {
        id: "evt_tool",
        created: 12,
        type: "session.tool.input.started",
        durable: { aggregateID: "ses_1", seq: 1, version: 1 },
        data: { sessionID: "ses_1", assistantMessageID: "msg_a", id: "call_1", name: "bash" },
      },
      {
        id: "evt_form",
        created: 13,
        type: "form.created",
        data: {
          form: {
            id: "frm_1",
            sessionID: "ses_1",
            title: "Choose",
            fields: [
              { key: "first", type: "string", title: "First" },
              {
                key: "second",
                type: "multiselect",
                title: "Second",
                options: [{ label: "A", value: "a" }],
              },
            ],
          },
        },
      },
      {
        id: "evt_reply",
        created: 14,
        type: "form.replied",
        data: {
          id: "frm_1",
          sessionID: "ses_1",
          answer: { second: ["a"], first: "yes" },
        },
      },
    ] as Array<OpenCodeEvent>;
    const client = {
      event: {
        subscribe: async function* () {
          yield* events;
        },
      },
    } as unknown as OpenCodeClient;

    const compat = createOpenCodeCompatClient({ client, directory: "/work" });
    const subscription = await compat.event.subscribe();
    const translated = [];
    for await (const event of subscription.stream) {
      translated.push(event);
      if (translated.length === 6) break;
    }

    expect(translated.map((event) => event.type)).toEqual([
      "message.updated",
      "message.part.updated",
      "message.part.updated",
      "message.part.updated",
      "question.asked",
      "question.replied",
    ]);
    const text = translated[2];
    expect(text?.type).toBe("message.part.updated");
    if (text?.type === "message.part.updated" && text.properties.part.type === "text") {
      expect(text.properties.part.text).toBe("Hi");
    }
    const tool = translated[3];
    if (tool?.type === "message.part.updated" && tool.properties.part.type === "tool") {
      expect(tool.properties.part.tool).toBe("bash");
      expect(tool.properties.part.state.status).toBe("pending");
    }
    const reply = translated[5];
    if (reply?.type === "question.replied") {
      expect(reply.properties.answers).toEqual([["yes"], ["a"]]);
    }
  });
});
