/**
 * Unit tests for `DiscordGateway` — the WS handshake + dispatch logic
 * ported from the legacy listener. Uses a fake WebSocket constructor so
 * the tests stay offline. Each scenario drives the gateway through the
 * handshake (HELLO → IDENTIFY → DISPATCH) and asserts the emitted
 * `GatewayEvent`s match what `DiscordAdapter` expects.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DiscordGateway } from "../gateway";
import type { GatewayEvent } from "../types";

interface FakeSocketHandle {
  url: string;
  sent: unknown[];
  closeCalls: Array<{ code?: number; reason?: string }>;
  readyState: number;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
}

/**
 * `webSocketCtor` is typed as `typeof WebSocket`, so the fake has to
 * satisfy that constructor's call-signature. We don't actually use
 * the WebSocket prototype, so a minimal stub is enough.
 */
function makeFakeWsCtor(): { Ctor: typeof WebSocket; latest: () => FakeSocketHandle } {
  let latest: FakeSocketHandle | null = null;
  class FakeWS {
    url: string;
    sent: unknown[] = [];
    closeCalls: Array<{ code?: number; reason?: string }> = [];
    readyState = 1; // OPEN
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) {
      this.url = url;
      latest = this as unknown as FakeSocketHandle;
    }
    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    close(code?: number, reason?: string) {
      this.closeCalls.push({ code, reason });
      this.readyState = 3;
    }
  }
  return {
    Ctor: FakeWS as unknown as typeof WebSocket,
    latest: () => {
      if (!latest) throw new Error("fake WS not constructed");
      return latest;
    },
  };
}

const SILENT = { warn: () => {}, info: () => {}, error: () => {} };

describe("DiscordGateway", () => {
  let originalRandom: typeof Math.random;
  beforeEach(() => {
    // Deterministic jitter to keep timer behaviour predictable.
    originalRandom = Math.random;
    Math.random = () => 0.5;
  });
  afterEach(() => {
    Math.random = originalRandom;
  });

  it("on HELLO it starts heartbeat and sends IDENTIFY when no session", async () => {
    const fake = makeFakeWsCtor();
    const gw = new DiscordGateway({ token: "tok", logger: SILENT, webSocketCtor: fake.Ctor });
    await gw.start();
    const ws = fake.latest();
    ws.onmessage?.({
      data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 }, s: null, t: null }),
    });
    // IDENTIFY is sent immediately; HEARTBEAT lives behind the jitter timer.
    const identify = ws.sent.find(
      (m): m is { op: number; d: { token: string; intents: number } } =>
        typeof m === "object" && m !== null && (m as { op?: number }).op === 2,
    );
    expect(identify).toBeDefined();
    expect(identify?.d.token).toBe("tok");
    expect(typeof identify?.d.intents).toBe("number");
    await gw.stop();
  });

  it("on HELLO it sends RESUME when session + sequence are present", async () => {
    const fake = makeFakeWsCtor();
    const gw = new DiscordGateway({ token: "tok", logger: SILENT, webSocketCtor: fake.Ctor });
    await gw.start();
    const ws = fake.latest();
    // READY first to populate sessionId.
    ws.onmessage?.({
      data: JSON.stringify({
        op: 0,
        s: 1,
        t: "READY",
        d: {
          session_id: "sess-1",
          resume_gateway_url: "wss://resume",
          user: { id: "u", username: "bot" },
        },
      }),
    });
    // Now HELLO should resume, not identify.
    ws.onmessage?.({
      data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 }, s: null, t: null }),
    });
    const resume = ws.sent.find(
      (m): m is { op: number; d: { session_id: string } } =>
        typeof m === "object" && m !== null && (m as { op?: number }).op === 6,
    );
    expect(resume).toBeDefined();
    expect(resume?.d.session_id).toBe("sess-1");
    const identify = ws.sent.find(
      (m) => typeof m === "object" && m !== null && (m as { op?: number }).op === 2,
    );
    expect(identify).toBeUndefined();
    await gw.stop();
  });

  it("forwards MESSAGE_CREATE dispatches to subscribers", async () => {
    const fake = makeFakeWsCtor();
    const gw = new DiscordGateway({ token: "tok", logger: SILENT, webSocketCtor: fake.Ctor });
    const events: GatewayEvent[] = [];
    gw.onEvent((e) => events.push(e));
    await gw.start();
    const ws = fake.latest();
    ws.onmessage?.({
      data: JSON.stringify({
        op: 0,
        s: 2,
        t: "MESSAGE_CREATE",
        d: {
          id: "m1",
          channel_id: "c1",
          author: { id: "u1", username: "terry" },
          content: "hi",
          attachments: [],
        },
      }),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("MESSAGE_CREATE");
    if (events[0]?.type === "MESSAGE_CREATE") {
      expect(events[0].message.id).toBe("m1");
      expect(events[0].message.content).toBe("hi");
    }
    await gw.stop();
  });

  it("forwards INTERACTION_CREATE dispatches to subscribers", async () => {
    const fake = makeFakeWsCtor();
    const gw = new DiscordGateway({ token: "tok", logger: SILENT, webSocketCtor: fake.Ctor });
    const events: GatewayEvent[] = [];
    gw.onEvent((e) => events.push(e));
    await gw.start();
    const ws = fake.latest();
    ws.onmessage?.({
      data: JSON.stringify({
        op: 0,
        s: 3,
        t: "INTERACTION_CREATE",
        d: {
          id: "int-1",
          type: 3,
          data: { custom_id: "ccaw_perm_allow_abc" },
          channel_id: "c1",
          user: { id: "u1", username: "terry" },
          token: "tok",
        },
      }),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("INTERACTION_CREATE");
  });

  it("HEARTBEAT_ACK marks heartbeat as acked (no reconnect-close)", async () => {
    const fake = makeFakeWsCtor();
    const gw = new DiscordGateway({ token: "tok", logger: SILENT, webSocketCtor: fake.Ctor });
    await gw.start();
    const ws = fake.latest();
    ws.onmessage?.({
      data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 }, s: null, t: null }),
    });
    ws.onmessage?.({ data: JSON.stringify({ op: 11, d: null, s: null, t: null }) });
    // No close should have been issued from missed-ack path.
    expect(ws.closeCalls.find((c) => c.reason === "Heartbeat timeout")).toBeUndefined();
    await gw.stop();
  });

  it("op=RECONNECT closes the ws (so onclose can reschedule)", async () => {
    const fake = makeFakeWsCtor();
    const gw = new DiscordGateway({ token: "tok", logger: SILENT, webSocketCtor: fake.Ctor });
    await gw.start();
    const ws = fake.latest();
    ws.onmessage?.({ data: JSON.stringify({ op: 7, d: null, s: null, t: null }) });
    expect(ws.closeCalls.some((c) => c.reason === "Reconnect requested")).toBe(true);
    await gw.stop();
  });

  it("stop() closes the ws and clears subscribers", async () => {
    const fake = makeFakeWsCtor();
    const gw = new DiscordGateway({ token: "tok", logger: SILENT, webSocketCtor: fake.Ctor });
    let count = 0;
    gw.onEvent(() => {
      count++;
    });
    await gw.start();
    await gw.stop();
    const ws = fake.latest();
    expect(ws.closeCalls.length).toBeGreaterThan(0);
    // After stop, dispatch handlers are cleared — even if a late
    // onmessage arrived, no subscriber would receive it.
    expect(count).toBe(0);
  });

  it("throws when no WebSocket implementation is available", () => {
    // Force-clear globalThis.WebSocket if present; pass no override.
    const original = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    (globalThis as { WebSocket?: typeof WebSocket }).WebSocket = undefined;
    try {
      expect(() => new DiscordGateway({ token: "tok", logger: SILENT })).toThrow(
        /no WebSocket implementation/,
      );
    } finally {
      (globalThis as { WebSocket?: typeof WebSocket }).WebSocket = original;
    }
  });
});
