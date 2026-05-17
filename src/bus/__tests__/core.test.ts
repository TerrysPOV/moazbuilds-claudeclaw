/**
 * Tests for `src/bus/core.ts` (Bus Core, Sprint 1 Agent A).
 *
 * Run with: `bun test src/bus/__tests__/core.test.ts`
 *
 * Strategy:
 *   - Pure pub/sub + ingest tests use the in-process API with a mock
 *     `eventLogAppend` so they never touch disk.
 *   - IPC tests bind a real UDS in `os.tmpdir()` and connect with a Bun
 *     `Bun.connect({unix})` client. This catches framing / handshake bugs
 *     that a mock would miss. Sockets are torn down in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createBusCore, encodeFrame, type BusCore } from "../core";
import { FrameDecoder, validateUdsPath } from "../core-ipc";
import type { BusEvent, IpcHello, IpcMessage, IpcPermissionRequest, IpcReply } from "../types";
import type { EventEntryInput, EventRecord } from "../../event-log";

/** In-memory event-log mock — captures every append call. */
function createMockEventLog() {
  const writes: EventEntryInput[] = [];
  let seq = 0;
  const append = async (entry: EventEntryInput): Promise<EventRecord> => {
    writes.push(entry);
    seq += 1;
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      seq,
      type: entry.type,
      source: entry.source,
      timestamp: now,
      createdAt: now,
      updatedAt: now,
      status: "done",
      channelId: entry.channelId,
      threadId: entry.threadId,
      payload: entry.payload,
      dedupeKey: entry.dedupeKey,
      retryCount: 0,
      nextRetryAt: null,
      correlationId: entry.correlationId ?? null,
      causationId: entry.causationId ?? null,
      replayedFromEventId: entry.replayedFromEventId ?? null,
      lastError: null,
    };
  };
  return { append, writes };
}

let tempDir: string;
let bus: BusCore | null = null;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bus-core-test-"));
});

afterEach(async () => {
  if (bus) {
    await bus.stop();
    bus = null;
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

/* ───────────────────────────────────────────────────────────────────── */
/* In-process pub/sub                                                    */
/* ───────────────────────────────────────────────────────────────────── */

describe("BusCore pub/sub", () => {
  it("subscribe + dispatch round-trip", () => {
    const log = createMockEventLog();
    bus = createBusCore({ eventLogAppend: log.append });

    const received: BusEvent[] = [];
    const sub = bus.subscribe({ agent_id: "alpha" }, (e) => received.push(e));

    const evt: BusEvent = {
      ts: 1,
      agent_id: "alpha",
      session_id: "sess-1",
      topic: "session.init",
      payload: { hello: "world" },
    };
    bus.ingestSessionEvent(evt);

    expect(received).toHaveLength(1);
    expect(received[0].topic).toBe("session.init");
    sub.close();
  });

  it("filters by agent_id and topics", () => {
    const log = createMockEventLog();
    bus = createBusCore({ eventLogAppend: log.append });
    const received: BusEvent[] = [];
    bus.subscribe({ agent_id: "alpha", topics: ["response.text"] }, (e) => received.push(e));

    // Wrong agent_id — drop.
    bus.ingestSessionEvent({
      ts: 1,
      agent_id: "beta",
      session_id: "s",
      topic: "response.text",
      payload: {},
    });
    // Right agent, wrong topic — drop.
    bus.ingestSessionEvent({
      ts: 2,
      agent_id: "alpha",
      session_id: "s",
      topic: "session.init",
      payload: {},
    });
    // Right agent, right topic — keep.
    bus.ingestSessionEvent({
      ts: 3,
      agent_id: "alpha",
      session_id: "s",
      topic: "response.text",
      payload: { text: "hi" },
    });

    expect(received).toHaveLength(1);
    expect(received[0].ts).toBe(3);
  });

  it("ring buffer drops oldest when full and counts overflow", async () => {
    // Test the helpers directly — the bus's synchronous drain means a
    // real overflow only happens when drain is decoupled from enqueue
    // (which is the contract `enqueueForSubscriber` / `drainSubscriber`
    // expose, regardless of the current dispatch policy).
    const { enqueueForSubscriber, drainSubscriber } = await import("../core-subscription");
    const sub = {
      id: "test",
      filter: {},
      ringbuffer: [] as BusEvent[],
      overflowCount: 0,
      capacity: 4,
      closed: false,
      handler: () => {},
    };
    for (let n = 1; n <= 7; n++) {
      enqueueForSubscriber(sub, {
        ts: n,
        agent_id: "alpha",
        session_id: "s",
        topic: "session.init",
        payload: { n },
      });
    }
    // Capacity 4, pushed 7 → 3 drops, oldest first.
    expect(sub.overflowCount).toBe(3);
    expect(sub.ringbuffer).toHaveLength(4);
    const ns = sub.ringbuffer.map((e) => (e.payload as { n: number }).n);
    expect(ns).toEqual([4, 5, 6, 7]);

    // Drain doesn't reset the overflow counter (it's a metric).
    const saw: number[] = [];
    sub.handler = (e: BusEvent) => saw.push((e.payload as { n: number }).n);
    drainSubscriber(sub, () => {});
    expect(saw).toEqual([4, 5, 6, 7]);
    expect(sub.overflowCount).toBe(3);
  });

  it("ingestSessionEvent writes to audit log", async () => {
    const log = createMockEventLog();
    bus = createBusCore({ eventLogAppend: log.append });
    bus.ingestSessionEvent({
      ts: 42,
      agent_id: "alpha",
      session_id: "sess-1",
      topic: "session.init",
      payload: { foo: "bar" },
    });
    // The audit write is queued via `void`; wait one tick for the promise
    // microtask to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(log.writes.length).toBeGreaterThanOrEqual(1);
    const w = log.writes[0];
    expect(w.type).toBe("bus:session.init");
    expect(w.source).toBe("bus");
    expect(w.channelId).toBe("alpha");
    expect(w.threadId).toBe("sess-1");
  });

  it("state() reports subscriber count and connected agents", () => {
    bus = createBusCore({ eventLogAppend: createMockEventLog().append });
    const s1 = bus.subscribe({}, () => {});
    const s2 = bus.subscribe({}, () => {});
    expect(bus.state().subscriberCount).toBe(2);
    s1.close();
    expect(bus.state().subscriberCount).toBe(1);
    s2.close();
  });

  it("invokeSlashCommand delegates to the handler", async () => {
    const calls: Array<[string, string]> = [];
    bus = createBusCore({
      eventLogAppend: createMockEventLog().append,
      slashCommandHandler: async (agent_id, cmd) => {
        calls.push([agent_id, cmd]);
      },
    });
    await bus.invokeSlashCommand("alpha", "/compact");
    expect(calls).toEqual([["alpha", "/compact"]]);
  });

  it("invokeSlashCommand throws if no handler is wired", async () => {
    bus = createBusCore({ eventLogAppend: createMockEventLog().append });
    await expect(bus.invokeSlashCommand("alpha", "/compact")).rejects.toThrow(
      /slashCommandHandler/,
    );
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* UDS path validation                                                   */
/* ───────────────────────────────────────────────────────────────────── */

describe("UDS path validation", () => {
  it("refuses to bind a UDS path > 96 bytes", async () => {
    // 97-byte path
    const longPath = `/tmp/${"a".repeat(92)}`;
    expect(Buffer.byteLength(longPath)).toBe(97);
    expect(() => validateUdsPath(longPath)).toThrow(/96-byte/);
  });

  it("accepts an under-cap path", () => {
    expect(() => validateUdsPath("/tmp/short.sock")).not.toThrow();
  });

  it("createBusCore + start() fails fast on oversize path", async () => {
    const longPath = `${tempDir}/${"x".repeat(120)}.sock`;
    bus = createBusCore({
      eventLogAppend: createMockEventLog().append,
      socketPath: longPath,
    });
    await expect(bus.start()).rejects.toThrow(/96-byte/);
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* Frame decoder                                                         */
/* ───────────────────────────────────────────────────────────────────── */

describe("FrameDecoder", () => {
  it("decodes a single frame", () => {
    const got: IpcMessage[] = [];
    const dec = new FrameDecoder(
      (m) => got.push(m),
      (err) => {
        throw err;
      },
    );
    const frame = encodeFrame({
      type: "hello",
      agent_id: "a",
      capabilities: ["claude/channel", "claude/channel/permission"],
    });
    dec.push(frame);
    expect(got).toHaveLength(1);
    expect(got[0].type).toBe("hello");
  });

  it("handles frames split across chunks", () => {
    const got: IpcMessage[] = [];
    const dec = new FrameDecoder(
      (m) => got.push(m),
      (err) => {
        throw err;
      },
    );
    const frame = encodeFrame({
      type: "hello",
      agent_id: "a",
      capabilities: ["claude/channel", "claude/channel/permission"],
    });
    dec.push(frame.subarray(0, 3));
    dec.push(frame.subarray(3, 7));
    expect(got).toHaveLength(0);
    dec.push(frame.subarray(7));
    expect(got).toHaveLength(1);
  });

  it("decodes two frames concatenated", () => {
    const got: IpcMessage[] = [];
    const dec = new FrameDecoder(
      (m) => got.push(m),
      (err) => {
        throw err;
      },
    );
    const f1 = encodeFrame({
      type: "hello",
      agent_id: "a",
      capabilities: ["claude/channel", "claude/channel/permission"],
    });
    const f2 = encodeFrame({
      type: "reply",
      agent_id: "a",
      text: "hi",
      intent: "final",
    });
    dec.push(Buffer.concat([f1, f2]));
    expect(got).toHaveLength(2);
    expect(got[1].type).toBe("reply");
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* IPC integration (real UDS)                                            */
/* ───────────────────────────────────────────────────────────────────── */

/** Connect to a UDS as a Bun client and return helpers for the test. */
async function connectIpcClient(socketPath: string) {
  const inbound: IpcMessage[] = [];
  const errors: Error[] = [];
  let resolveOpen!: () => void;
  const opened = new Promise<void>((r) => {
    resolveOpen = r;
  });
  const decoder = new FrameDecoder(
    (m) => inbound.push(m),
    (e) => errors.push(e),
  );
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      open() {
        resolveOpen();
      },
      data(_s, data) {
        decoder.push(data);
      },
      error(_s, err) {
        errors.push(err);
      },
      close() {},
    },
  });
  await opened;
  return {
    socket,
    inbound,
    errors,
    send: (msg: IpcMessage) => {
      socket.write(encodeFrame(msg));
    },
    close: () => {
      socket.end();
    },
    /** Wait up to `ms` for the inbound queue to reach `n` items. */
    async waitForMessages(n: number, ms = 1000): Promise<void> {
      const start = Date.now();
      while (inbound.length < n) {
        if (Date.now() - start > ms) {
          throw new Error(
            `Timed out waiting for ${n} messages; got ${inbound.length}: ${JSON.stringify(inbound)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

describe("BusCore IPC", () => {
  it("hello handshake validates both required capabilities", async () => {
    const sockPath = join(tempDir, "bus.sock");
    bus = createBusCore({
      eventLogAppend: createMockEventLog().append,
      socketPath: sockPath,
      // Silence the expected "missing capability" log — this test is the
      // negative path and the error is the assertion target.
      onError: () => {},
    });
    await bus.start();

    const client = await connectIpcClient(sockPath);
    // Missing the permission capability — should be rejected with an error
    // frame and the socket should close.
    const badHello: IpcHello = {
      type: "hello",
      agent_id: "alpha",
      capabilities: ["claude/channel"], // missing claude/channel/permission
    };
    client.send(badHello);
    // Server should emit an error frame, then close.
    await client.waitForMessages(1, 500);
    expect(client.inbound[0].type).toBe("error");
    expect((client.inbound[0] as { message: string }).message).toContain(
      "claude/channel/permission",
    );
  });

  it("accepts hello with both capabilities and tracks the connection", async () => {
    const sockPath = join(tempDir, "bus.sock");
    bus = createBusCore({
      eventLogAppend: createMockEventLog().append,
      socketPath: sockPath,
    });
    await bus.start();

    const client = await connectIpcClient(sockPath);
    client.send({
      type: "hello",
      agent_id: "alpha",
      capabilities: ["claude/channel", "claude/channel/permission"],
    });
    // No response is sent for a successful hello; wait a tick then check
    // the bus state.
    await new Promise((r) => setTimeout(r, 50));
    expect(bus.state().connectedAgents).toContain("alpha");
    client.close();
  });

  it("sendPrompt forwards an IpcPrompt to the right MCP connection", async () => {
    const sockPath = join(tempDir, "bus.sock");
    bus = createBusCore({
      eventLogAppend: createMockEventLog().append,
      socketPath: sockPath,
    });
    await bus.start();

    const client = await connectIpcClient(sockPath);
    client.send({
      type: "hello",
      agent_id: "alpha",
      capabilities: ["claude/channel", "claude/channel/permission"],
    });
    await new Promise((r) => setTimeout(r, 50));

    const { promise_id } = await bus.sendPrompt({
      agent_id: "alpha",
      origin: "discord",
      origin_id: "chan-123",
      user_id: "user-1",
      text: "ping",
    });
    expect(promise_id).toBeTruthy();

    await client.waitForMessages(1, 1000);
    const m = client.inbound[0];
    expect(m.type).toBe("prompt");
    expect((m as { agent_id: string }).agent_id).toBe("alpha");
    expect((m as { text: string }).text).toBe("ping");
    expect((m as { origin: string }).origin).toBe("discord");
    client.close();
  });

  it("MCP reply round-trip lands on subscribers via ingestReply", async () => {
    const sockPath = join(tempDir, "bus.sock");
    bus = createBusCore({
      eventLogAppend: createMockEventLog().append,
      socketPath: sockPath,
    });
    await bus.start();

    const received: BusEvent[] = [];
    bus.subscribe({ agent_id: "alpha", topics: ["response.text"] }, (e) => received.push(e));

    const client = await connectIpcClient(sockPath);
    client.send({
      type: "hello",
      agent_id: "alpha",
      capabilities: ["claude/channel", "claude/channel/permission"],
    });
    await new Promise((r) => setTimeout(r, 50));

    const reply: IpcReply = {
      type: "reply",
      agent_id: "alpha",
      text: "hello back",
      intent: "final",
    };
    client.send(reply);

    // Allow the server to receive and dispatch.
    const start = Date.now();
    while (received.length === 0 && Date.now() - start < 1000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(received).toHaveLength(1);
    expect((received[0].payload as { text: string }).text).toBe("hello back");
    client.close();
  });

  it("permission_request from MCP fans out as channel.permission_request event", async () => {
    const sockPath = join(tempDir, "bus.sock");
    bus = createBusCore({
      eventLogAppend: createMockEventLog().append,
      socketPath: sockPath,
    });
    await bus.start();

    const received: BusEvent[] = [];
    bus.subscribe({ agent_id: "alpha", topics: ["channel.permission_request"] }, (e) =>
      received.push(e),
    );

    const client = await connectIpcClient(sockPath);
    client.send({
      type: "hello",
      agent_id: "alpha",
      capabilities: ["claude/channel", "claude/channel/permission"],
    });
    await new Promise((r) => setTimeout(r, 50));

    const req: IpcPermissionRequest = {
      type: "permission_request",
      agent_id: "alpha",
      request: {
        request_id: "abcde",
        tool_name: "Bash",
        description: "Run ls",
        input_preview: "ls /tmp",
      },
    };
    client.send(req);

    const start = Date.now();
    while (received.length === 0 && Date.now() - start < 1000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(received).toHaveLength(1);
    expect((received[0].payload as { request_id: string }).request_id).toBe("abcde");
    client.close();
  });

  it("ingestPermissionDecision forwards a permission_response over IPC", async () => {
    const sockPath = join(tempDir, "bus.sock");
    bus = createBusCore({
      eventLogAppend: createMockEventLog().append,
      socketPath: sockPath,
    });
    await bus.start();

    const client = await connectIpcClient(sockPath);
    client.send({
      type: "hello",
      agent_id: "alpha",
      capabilities: ["claude/channel", "claude/channel/permission"],
    });
    await new Promise((r) => setTimeout(r, 50));

    bus.ingestPermissionDecision({
      agent_id: "alpha",
      request_id: "abcde",
      behavior: "allow",
    });

    await client.waitForMessages(1, 1000);
    const m = client.inbound[0];
    expect(m.type).toBe("permission_response");
    expect((m as { response: { behavior: string } }).response.behavior).toBe("allow");
    client.close();
  });
});
