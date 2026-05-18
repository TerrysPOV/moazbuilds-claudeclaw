/**
 * Discord adapter — inbound (gateway → bus) behavioural tests.
 *
 * Covers lifecycle, allow-list, channel/thread/DM routing, attachment
 * forwarding, and rate-limiting. Outbound (bus → Discord) lives in
 * `discord-outbound.test.ts`.
 *
 * Run: `bun test src/adapters/discord/__tests__/discord-inbound.test.ts`
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DiscordAdapter } from "../index";
import {
  type AdapterHarness,
  flushMicrotasks,
  makeHarness,
  makeMessage,
  startAdapter,
} from "./fixtures";

let h: AdapterHarness;
let adapter: DiscordAdapter | null = null;

beforeEach(() => {
  h = makeHarness();
});

afterEach(async () => {
  if (adapter) {
    await adapter.stop();
    adapter = null;
  }
});

describe("DiscordAdapter — lifecycle", () => {
  it("start subscribes once per unique agent and wires the gateway", async () => {
    adapter = await startAdapter(h);
    // triage (ch-1) + ops (ch-2, th-1) + global (DM) = 3 unique agents.
    expect(h.bus.state().subscriberCount).toBe(3);
    expect(h.gateway.started).toBe(true);
  });

  it("stop closes every subscription and stops the gateway", async () => {
    adapter = await startAdapter(h);
    expect(h.bus.state().subscriberCount).toBe(3);
    await adapter.stop();
    adapter = null;
    expect(h.bus.state().subscriberCount).toBe(0);
    expect(h.gateway.stopped).toBe(true);
  });

  it("auto-constructs gateway + restApi when none injected", () => {
    // Production callers only pass bus + token + routing; the adapter
    // builds its own DiscordGateway + DiscordRestApi from the token.
    // Tests inject fakes (see `startAdapter`) to bypass the network —
    // this case exercises the bare construction path doesn't throw.
    const a = new DiscordAdapter({
      bus: h.bus,
      token: "fake-token",
      allowedUserIds: [],
      routing: { channels: {} },
    });
    expect(a).toBeDefined();
  });
});

describe("DiscordAdapter — allow-list", () => {
  it("DM from unauthorised user → 'Unauthorized.' reply", async () => {
    adapter = await startAdapter(h);
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({
        channel_id: "dm-1",
        guild_id: undefined,
        author: { id: "intruder", username: "evil" },
        content: "hello",
      }),
    });
    await flushMicrotasks();
    expect(h.rest.sent).toHaveLength(1);
    expect(h.rest.sent[0]?.channelId).toBe("dm-1");
    expect(h.rest.sent[0]?.text).toBe("Unauthorized.");
    expect(h.bus.prompts).toHaveLength(0);
  });

  it("guild message from unauthorised user → silent skip", async () => {
    adapter = await startAdapter(h);
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({
        channel_id: "ch-1",
        guild_id: "g-1",
        author: { id: "intruder", username: "evil" },
        content: "hello",
      }),
    });
    await flushMicrotasks();
    expect(h.rest.sent).toHaveLength(0);
    expect(h.bus.prompts).toHaveLength(0);
  });

  // PR #113 review (agents #2 + #3): the earlier Sprint 3 adapter had
  // empty list = deny all, a silent regression for operators on the
  // default config. Legacy semantics restored: empty = allow all.
  it("empty allowedUserIds = allow all (legacy parity)", async () => {
    adapter = await startAdapter(h, { allowedUserIds: [] });
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({
        channel_id: "ch-1",
        guild_id: "g-1",
        author: { id: "anyone", username: "rando" },
        content: "hi from anyone",
      }),
    });
    await flushMicrotasks();
    expect(h.bus.prompts).toHaveLength(1);
    // No "Unauthorized." reply was sent.
    const unauth = h.rest.sent.filter((s) => s.text === "Unauthorized.");
    expect(unauth).toHaveLength(0);
  });

  it("drops bot author messages", async () => {
    adapter = await startAdapter(h);
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({
        author: { id: "user-1", username: "bot", bot: true },
      }),
    });
    await flushMicrotasks();
    expect(h.bus.prompts).toHaveLength(0);
  });
});

describe("DiscordAdapter — channel routing", () => {
  it("routes channel id to its configured agent_id", async () => {
    adapter = await startAdapter(h);
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({
        channel_id: "ch-2",
        guild_id: "g-1",
        content: "build it",
      }),
    });
    await flushMicrotasks();
    expect(h.bus.prompts).toHaveLength(1);
    const p = h.bus.prompts[0];
    if (!p) throw new Error("prompt missing");
    expect(p.agent_id).toBe("ops");
    expect(p.origin).toBe("discord");
    expect(p.origin_id).toBe("ch-2");
    expect(p.user_id).toBe("user-1");
    expect(p.text).toBe("build it");
    expect(p.metadata?.message_id).toBe("msg-1");
    expect(p.metadata?.username).toBe("terry");
  });

  it("routes explicit thread id to its configured agent_id", async () => {
    adapter = await startAdapter(h);
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({
        channel_id: "th-1",
        guild_id: "g-1",
        content: "in a thread",
      }),
    });
    await flushMicrotasks();
    expect(h.bus.prompts).toHaveLength(1);
    expect(h.bus.prompts[0]?.agent_id).toBe("ops");
    expect(h.bus.prompts[0]?.origin_id).toBe("th-1");
  });

  it("routes DM to dmAgentId", async () => {
    adapter = await startAdapter(h);
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({
        channel_id: "dm-1",
        guild_id: undefined,
        content: "dm me",
      }),
    });
    await flushMicrotasks();
    expect(h.bus.prompts).toHaveLength(1);
    expect(h.bus.prompts[0]?.agent_id).toBe("global");
  });

  it("DM defaults to 'global' when dmAgentId is unset", async () => {
    adapter = await startAdapter(h, {
      routing: { channels: { "ch-1": "triage" } },
    });
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({
        channel_id: "dm-x",
        guild_id: undefined,
        content: "hello",
      }),
    });
    await flushMicrotasks();
    expect(h.bus.prompts).toHaveLength(1);
    expect(h.bus.prompts[0]?.agent_id).toBe("global");
  });

  it("silently skips unrouted guild channels", async () => {
    adapter = await startAdapter(h);
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({
        channel_id: "ch-unknown",
        guild_id: "g-1",
        content: "where do i go",
      }),
    });
    await flushMicrotasks();
    expect(h.bus.prompts).toHaveLength(0);
    expect(h.rest.sent).toHaveLength(0);
  });
});

describe("DiscordAdapter — attachments", () => {
  it("captures image/voice/text attachments in metadata", async () => {
    adapter = await startAdapter(h);
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({
        content: "with media",
        attachments: [
          {
            id: "a1",
            filename: "pic.png",
            content_type: "image/png",
            url: "https://cdn/pic.png",
            size: 100,
          },
          {
            id: "a2",
            filename: "voice.ogg",
            content_type: "audio/ogg",
            url: "https://cdn/voice.ogg",
            size: 200,
            flags: 1 << 13,
          },
          {
            id: "a3",
            filename: "notes.md",
            content_type: "text/markdown",
            url: "https://cdn/notes.md",
            size: 50,
          },
        ],
      }),
    });
    await flushMicrotasks();
    expect(h.bus.prompts).toHaveLength(1);
    const meta = h.bus.prompts[0]?.metadata as {
      attachments?: {
        images: Array<{ id: string }>;
        voices: Array<{ id: string }>;
        texts: Array<{ id: string }>;
      };
    };
    expect(meta.attachments?.images?.[0]?.id).toBe("a1");
    expect(meta.attachments?.voices?.[0]?.id).toBe("a2");
    expect(meta.attachments?.texts?.[0]?.id).toBe("a3");
  });

  it("forwards empty-text + image-only messages", async () => {
    adapter = await startAdapter(h);
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({
        content: "",
        attachments: [
          {
            id: "a1",
            filename: "pic.png",
            content_type: "image/png",
            url: "https://cdn/pic.png",
            size: 100,
          },
        ],
      }),
    });
    await flushMicrotasks();
    expect(h.bus.prompts).toHaveLength(1);
  });

  it("drops empty messages with no attachments", async () => {
    adapter = await startAdapter(h);
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({ content: "   " }),
    });
    await flushMicrotasks();
    expect(h.bus.prompts).toHaveLength(0);
  });
});

describe("DiscordAdapter — rate limit", () => {
  it("drops messages above the limit", async () => {
    let calls = 0;
    adapter = await startAdapter(h, {
      rateLimitCheck: () => {
        calls++;
        return calls === 1;
      },
    });
    h.gateway.push({ type: "MESSAGE_CREATE", message: makeMessage({ content: "first" }) });
    h.gateway.push({ type: "MESSAGE_CREATE", message: makeMessage({ content: "second" }) });
    await flushMicrotasks();
    expect(h.bus.prompts).toHaveLength(1);
    expect(h.bus.prompts[0]?.text).toBe("first");
  });
});
