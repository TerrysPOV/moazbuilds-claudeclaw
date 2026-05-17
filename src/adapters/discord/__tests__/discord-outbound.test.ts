/**
 * Discord adapter — outbound (bus → Discord) behavioural tests.
 *
 * Covers `response.text` delivery, `channel.permission_request` button
 * flow, and `system.request_human` round-trip. Inbound (gateway → bus)
 * lives in `discord-inbound.test.ts`.
 *
 * Run: `bun test src/adapters/discord/__tests__/discord-outbound.test.ts`
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DiscordAdapter } from "../index";
import type { PermissionRequest } from "../../../bus/types";
import {
  type AdapterHarness,
  flushMicrotasks,
  makeHarness,
  makeInteraction,
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

describe("DiscordAdapter — outbound response.text", () => {
  it("posts bus response.text to all channels for the agent", async () => {
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "s",
      topic: "response.text",
      payload: { text: "done" },
    });
    expect(h.rest.sent.map((m) => m.channelId).sort()).toEqual(["ch-2", "th-1"]);
    expect(h.rest.sent[0]?.text).toBe("done");
  });

  it("skips empty response.text payloads", async () => {
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s",
      topic: "response.text",
      payload: { text: "" },
    });
    expect(h.rest.sent).toHaveLength(0);
  });
});

describe("DiscordAdapter — permission flow", () => {
  it("posts a button-row prompt on channel.permission_request and routes the click back", async () => {
    adapter = await startAdapter(h);
    const req: PermissionRequest = {
      request_id: "abcde",
      tool_name: "Write",
      description: "write a file",
      input_preview: "{path: ...}",
    };
    h.bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s",
      topic: "channel.permission_request",
      payload: req,
    });
    expect(h.rest.sent).toHaveLength(1);
    const sent = h.rest.sent[0];
    if (!sent) throw new Error("expected sent message");
    expect(sent.channelId).toBe("ch-1");
    expect(sent.components).toBeDefined();
    const row = sent.components?.[0] as { components: Array<{ custom_id: string; label: string }> };
    expect(row.components).toHaveLength(2);
    expect(row.components[0]?.custom_id).toBe("ccaw_perm_allow_abcde");
    expect(row.components[1]?.custom_id).toBe("ccaw_perm_deny_abcde");

    // Click "Allow".
    h.gateway.push({
      type: "INTERACTION_CREATE",
      interaction: makeInteraction({ data: { custom_id: "ccaw_perm_allow_abcde" } }),
    });
    await flushMicrotasks();

    expect(h.bus.permissionDecisions).toHaveLength(1);
    expect(h.bus.permissionDecisions[0]).toEqual({
      agent_id: "triage",
      request_id: "abcde",
      behavior: "allow",
    });
    expect(h.rest.acks).toHaveLength(1);
    expect(h.rest.acks[0]?.body.content).toBe("Allowed.");
  });

  it("ignores unknown permission button click (stale prompt)", async () => {
    adapter = await startAdapter(h);
    h.gateway.push({
      type: "INTERACTION_CREATE",
      interaction: makeInteraction({ data: { custom_id: "ccaw_perm_deny_zzzzz" } }),
    });
    await flushMicrotasks();
    expect(h.bus.permissionDecisions).toHaveLength(0);
    expect(h.rest.acks).toHaveLength(1);
    expect(h.rest.acks[0]?.body.content).toContain("no longer active");
  });

  it("rejects permission click from non-allowlisted user", async () => {
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s",
      topic: "channel.permission_request",
      payload: {
        request_id: "abcde",
        tool_name: "Write",
        description: "",
        input_preview: "",
      },
    });
    h.gateway.push({
      type: "INTERACTION_CREATE",
      interaction: makeInteraction({
        user: { id: "intruder", username: "evil" },
        data: { custom_id: "ccaw_perm_allow_abcde" },
      }),
    });
    await flushMicrotasks();
    expect(h.bus.permissionDecisions).toHaveLength(0);
    expect(h.rest.acks).toHaveLength(1);
    expect(h.rest.acks[0]?.body.content).toBe("Unauthorized.");
  });
});

describe("DiscordAdapter — request_human flow", () => {
  it("posts a question on system.request_human and routes the first reply via ingestAskAnswer", async () => {
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s",
      topic: "system.request_human",
      payload: { ask_id: "ask-1", question: "what next?" },
    });
    expect(h.rest.sent).toHaveLength(1);
    expect(h.rest.sent[0]?.channelId).toBe("ch-1");
    expect(h.rest.sent[0]?.text).toContain("what next?");

    // Operator replies in the same channel.
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({
        channel_id: "ch-1",
        guild_id: "g-1",
        content: "ship it",
      }),
    });
    await flushMicrotasks();
    expect(h.bus.askAnswers).toHaveLength(1);
    expect(h.bus.askAnswers[0]).toEqual({
      agent_id: "triage",
      ask_id: "ask-1",
      answer: "ship it",
    });
    // And the reply must NOT also be forwarded as a prompt.
    expect(h.bus.prompts).toHaveLength(0);
  });

  it("only the first reply is consumed; the second reply is a fresh prompt", async () => {
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s",
      topic: "system.request_human",
      payload: { ask_id: "ask-1", question: "?" },
    });
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({ channel_id: "ch-1", guild_id: "g-1", content: "answer" }),
    });
    await flushMicrotasks();
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({
        id: "msg-2",
        channel_id: "ch-1",
        guild_id: "g-1",
        content: "another",
      }),
    });
    await flushMicrotasks();
    expect(h.bus.askAnswers).toHaveLength(1);
    expect(h.bus.prompts).toHaveLength(1);
    expect(h.bus.prompts[0]?.text).toBe("another");
  });
});

describe("DiscordAdapter — multi-agent fan-out", () => {
  it("each agent gets independent response delivery", async () => {
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s",
      topic: "response.text",
      payload: { text: "for triage" },
    });
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "s",
      topic: "response.text",
      payload: { text: "for ops" },
    });
    const byCh = new Map(h.rest.sent.map((m) => [m.channelId, m.text]));
    expect(byCh.get("ch-1")).toBe("for triage");
    expect(byCh.get("ch-2")).toBe("for ops");
    expect(byCh.get("th-1")).toBe("for ops");
  });
});
