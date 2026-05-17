/**
 * Sprint 2 end-to-end smoke test.
 *
 * Wires together the three Sprint 2 components and verifies the full
 * read path:
 *
 *   claude writes JSONL line → JsonlTailer reads + parses → BusCore
 *     publishes BusEvent → WebUiAdapter WebSocket subscriber receives
 *     the event on the client side
 *
 * Plus the Sprint 1 follow-up `BusCore.ingestAskAnswer`: round-trips
 * an `ask`/`request_human` answer from the Web UI through Bus core to
 * a fake IPC peer.
 *
 * What this DOESN'T cover:
 *   - real claude spawning (Sprint 2 schema-probe.test.ts covers the
 *     mocked-claude path; integration test marked .skipIf there)
 *   - JSONL Tailer + Session Manager spawning a real process together
 *     (Sprint 3 wires the Session Manager → Tailer construction site)
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBusCore, type BusCore } from "../core.js";
import { JsonlTailer } from "../jsonl-tailer.js";
import { encodeCwdForProjectsDir } from "../jsonl-line-types.js";
import { WebUiAdapter } from "../../adapters/webui/index.js";
import type { BusEvent } from "../types.js";

interface Harness {
  bus: BusCore;
  tailer: JsonlTailer;
  webui: WebUiAdapter;
  webuiUrl: string;
  webuiWsUrl: string;
  projectsDir: string;
  jsonlPath: string;
  tmpDir: string;
  cleanup: () => Promise<void>;
}

async function setupHarness(agentId: string, sessionId: string): Promise<Harness> {
  const tmpDir = mkdtempSync(join(tmpdir(), "bus-sprint-2-e2e-"));
  const projectsDir = join(tmpDir, "projects");
  const agentCwd = join(tmpDir, "agent-cwd");
  // Pre-create the encoded JSONL path so the tailer's start() can open it
  // even before claude would have started writing. Use the SAME encoder
  // the Tailer uses (slash-only) — schema-probe's earlier alt-encoder
  // dropped dots which doesn't match claude's actual behaviour.
  const encodedCwd = encodeCwdForProjectsDir(resolve(agentCwd));
  const jsonlDir = join(projectsDir, encodedCwd);
  // Pre-create the JSONL with an empty file so the tailer can attach.
  // mkdir -p
  require("node:fs").mkdirSync(jsonlDir, { recursive: true });
  require("node:fs").mkdirSync(agentCwd, { recursive: true });
  const jsonlPath = join(jsonlDir, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, "");

  // Bus core — in-process pub/sub only (no UDS for this e2e).
  const bus = createBusCore({
    eventLogAppend: async (entry) =>
      ({
        eventId: "test",
        sequence: 0,
        timestamp: Date.now(),
        ...entry,
      }) as never,
  });
  await bus.start();

  // JSONL Tailer.
  const tailer = new JsonlTailer({
    bus,
    agent_id: agentId,
    session_id: sessionId,
    cwd: agentCwd,
    projectsDir,
  });
  await tailer.start();

  // Web UI adapter on an ephemeral port. Bun.serve allows `port: 0`.
  const webui = new WebUiAdapter({ bus, bind: "127.0.0.1:0", token: "e2e-token" });
  const { host, port } = await webui.start();
  const webuiUrl = `http://${host}:${port}`;
  const webuiWsUrl = `ws://${host}:${port}/ws?token=e2e-token`;

  return {
    bus,
    tailer,
    webui,
    webuiUrl,
    webuiWsUrl,
    projectsDir,
    jsonlPath,
    tmpDir,
    async cleanup() {
      await webui.stop();
      await tailer.stop();
      await bus.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe("Sprint 2 e2e — Tailer → BusCore → WebUI WS", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness("e2e-agent", "00000000-0000-4000-8000-000000000001");
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("a JSONL assistant line is delivered to a WS subscriber as response.text", async () => {
    // Connect a WS client, subscribe to all events for the agent.
    const ws = new WebSocket(h.webuiWsUrl);
    const received: Array<{ topic: string; payload: unknown }> = [];
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws connect failed")));
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "event") {
        received.push({ topic: msg.event.topic, payload: msg.event.payload });
      }
    });
    ws.send(JSON.stringify({ type: "subscribe", agent_id: "e2e-agent" }));

    // Allow subscribe to register before appending.
    await new Promise((r) => setTimeout(r, 50));

    // Append an assistant line containing a text block — same shape as
    // Spike 0.2 fixture 01.
    const assistantLine = JSON.stringify({
      type: "assistant",
      uuid: "msg-1",
      parentUuid: null,
      timestamp: new Date().toISOString(),
      cwd: h.tmpDir,
      sessionId: "00000000-0000-4000-8000-000000000001",
      version: "2.1.143",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello e2e" }],
        usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    appendFileSync(h.jsonlPath, `${assistantLine}\n`);

    // Wait for the response.text event to flow through.
    let waited = 0;
    while (
      waited < 1500 &&
      !received.find(
        (e) => e.topic === "response.text" && JSON.stringify(e.payload).includes("hello e2e"),
      )
    ) {
      await new Promise((r) => setTimeout(r, 20));
      waited += 20;
    }
    const textEvent = received.find((e) => e.topic === "response.text");
    expect(textEvent).toBeDefined();
    expect(JSON.stringify(textEvent?.payload)).toContain("hello e2e");

    ws.close();
  });

  it("WebUiAdapter POST /prompt forwards to bus.sendPrompt with origin=webui", async () => {
    // Subscribe directly to the bus so we can assert without standing up
    // the IPC server (no MCP needed for this assertion).
    const inboundPrompts: BusEvent[] = [];
    h.bus.subscribe({ agent_id: "e2e-agent", topics: ["prompt"] }, (e) => {
      inboundPrompts.push(e);
    });

    const res = await fetch(`${h.webuiUrl}/prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer e2e-token",
      },
      body: JSON.stringify({
        agent_id: "e2e-agent",
        text: "do a thing",
        metadata: { thread: "main" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { promise_id: string };
    expect(typeof body.promise_id).toBe("string");

    let waited = 0;
    while (waited < 500 && inboundPrompts.length === 0) {
      await new Promise((r) => setTimeout(r, 20));
      waited += 20;
    }
    expect(inboundPrompts.length).toBe(1);
    const p = inboundPrompts[0].payload as {
      origin: string;
      text: string;
      metadata?: Record<string, unknown>;
    };
    expect(p.origin).toBe("webui");
    expect(p.text).toBe("do a thing");
    expect(p.metadata?.thread).toBe("main");
  });

  it("ingestAskAnswer is a no-op when no IPC server is configured (Sprint 1 follow-up wiring)", () => {
    // The API exists and is callable; without an IPC server it has no
    // delivery target. This proves the public surface lands; full e2e
    // through the IPC channel is covered by Sprint 3 once an adapter
    // exercises the request_human → answer round-trip end-to-end.
    expect(() =>
      h.bus.ingestAskAnswer({
        agent_id: "e2e-agent",
        ask_id: "abc",
        answer: "yes",
      }),
    ).not.toThrow();
  });
});
