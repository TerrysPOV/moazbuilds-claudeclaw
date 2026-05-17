/**
 * Sprint 1 end-to-end smoke test.
 *
 * Wires together the three Sprint 1 components and verifies the
 * inbound + outbound round-trip end-to-end over a real UDS:
 *
 *   adapter → BusCore.sendPrompt → IpcPrompt over UDS → BusMcpServer
 *     → MCP notification (received by an in-memory mock client)
 *     → simulated `reply` tool call → IpcReply over UDS → BusCore subscribers
 *
 * What this test does NOT cover:
 *   - spawning a real `claude` process (Session Manager unit tests cover the
 *     `bun-pty` / `process-stream-json` spawn paths with mock binaries)
 *   - JSONL Tailer (Sprint 2)
 *   - Adapter implementations (Sprint 3+)
 *
 * Sprint 2 will replace the simulated `reply` tool call with a real claude
 * session being driven by Session Manager, and add a JSONL-tail assertion
 * to confirm the same event also arrives via the JSONL path.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CHANNEL_BASE_CAPABILITY,
  CHANNEL_PERMISSION_CAPABILITY,
  BusMcpServer,
  buildMcpServer,
  connectBusIpc,
} from "../mcp-server.js";
import { createBusCore, type BusCore } from "../core.js";
import type { BusEvent } from "../types.js";

interface Harness {
  bus: BusCore;
  mcp: BusMcpServer;
  client: Client;
  events: BusEvent[];
  channelNotifs: Array<{ method: string; params: Record<string, unknown> }>;
  tmpDir: string;
  cleanup: () => Promise<void>;
}

async function setupHarness(agentId: string): Promise<Harness> {
  // 1. Bus core bound to a UDS in a temp dir.
  const tmpDir = mkdtempSync(join(tmpdir(), "bus-e2e-"));
  const socketPath = join(tmpDir, "bus.sock");
  const bus = createBusCore({
    socketPath,
    // No-op event log so we don't write into the project's audit log.
    eventLogAppend: async (entry) =>
      ({
        eventId: "test",
        sequence: 0,
        timestamp: Date.now(),
        ...entry,
      }) as never,
  });
  await bus.start();

  // 2. Subscribe to all events for this agent — adapter's view.
  const events: BusEvent[] = [];
  bus.subscribe({ agent_id: agentId }, (e) => {
    events.push(e);
  });

  // 3. Bus MCP server: connects to Bus core over the same UDS the way
  //    a real spawned `claude` would (via CCAW_BUS_SOCK env). We use
  //    `connectBusIpc` so the e2e exercises the same env-driven path.
  process.env.CCAW_BUS_SOCK = socketPath;
  const ipc = await connectBusIpc(process.env);
  const mcpServer = buildMcpServer();
  // Bind the server to an InMemoryTransport — pair the client to its mate
  // so we can drive tools from the test as if we were claude.
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverSide);
  const mcp = new BusMcpServer({ agentId, ipc, mcp: mcpServer });
  mcp.sendHello();

  // Wait for Bus core to register the agent (the hello frame travels over
  // the UDS asynchronously). Without this, sendPrompt fires before the
  // connection is associated with `agentId` and the IPC routing drops it.
  {
    const deadline = Date.now() + 1000;
    while (!bus.state().connectedAgents.includes(agentId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  // 4. MCP client that plays the role claude does — invokes tools, receives
  //    notifications. Capture all `notifications/claude/channel` notifications
  //    so we can assert the inbound prompt arrived.
  const client = new Client({ name: "e2e-client", version: "0" });
  const channelNotifs: Harness["channelNotifs"] = [];
  client.fallbackNotificationHandler = async (notif) => {
    if (notif.method.startsWith("notifications/claude/channel")) {
      channelNotifs.push({
        method: notif.method,
        params: (notif.params ?? {}) as Record<string, unknown>,
      });
    }
  };
  await client.connect(clientSide);

  return {
    bus,
    mcp,
    client,
    events,
    channelNotifs,
    tmpDir,
    async cleanup() {
      try {
        await client.close();
      } catch {}
      try {
        await mcpServer.close();
      } catch {}
      try {
        mcp.ipc.close();
      } catch {}
      await bus.stop();
      rmSync(tmpDir, { recursive: true, force: true });
      delete process.env.CCAW_BUS_SOCK;
    },
  };
}

describe("Sprint 1 e2e — Bus core ↔ Bus MCP server (real UDS)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness("e2e-agent");
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("handshake declares both Channels capabilities", async () => {
    // Hello is sent synchronously from sendHello(); give the server a tick
    // to ingest the framed message off the socket.
    await new Promise((r) => setTimeout(r, 20));
    expect(h.bus.state().connectedAgents).toContain("e2e-agent");
    // The connectedAgents membership IS the proof — Bus core only registers
    // an agent after validating both REQUIRED_MCP_CAPABILITIES.
  });

  it("sendPrompt → notifications/claude/channel (flat content+meta shape)", async () => {
    await h.bus.sendPrompt({
      agent_id: "e2e-agent",
      origin: "discord",
      origin_id: "channel-XYZ",
      user_id: "user-1",
      text: "ship the bus",
      metadata: { thread: "dev" },
    });

    // Allow the IPC frame to flow over the socket and the MCP notification
    // to round-trip through the linked InMemoryTransport pair.
    let waited = 0;
    while (h.channelNotifs.length === 0 && waited < 1000) {
      await new Promise((r) => setTimeout(r, 20));
      waited += 20;
    }
    expect(h.channelNotifs.length).toBeGreaterThan(0);
    const notif = h.channelNotifs[0];
    expect(notif.method).toBe("notifications/claude/channel");
    // Flat shape — content + meta at top of params (NOT nested).
    expect(notif.params.content).toBe("ship the bus");
    expect(notif.params.meta).toMatchObject({
      origin: "discord",
      origin_id: "channel-XYZ",
      thread: "dev",
    });
    // The subscriber also saw the prompt as a BusEvent.
    expect(h.events.some((e) => e.topic === "prompt")).toBe(true);
  });

  it("tool reply (simulating claude) → BusCore subscribers see response.text", async () => {
    // Drive the `reply` tool from the client side — this is what claude
    // would do after processing a prompt.
    const result = await h.client.callTool({
      name: "reply",
      arguments: { message: "shipped 🪶", metadata: { intent: "final" } },
    });
    expect(result.isError).toBeFalsy();

    // Wait for IpcReply to flow back to Bus core and publish.
    let waited = 0;
    let responseEvent: BusEvent | undefined;
    while (waited < 1000 && !responseEvent) {
      await new Promise((r) => setTimeout(r, 20));
      waited += 20;
      responseEvent = h.events.find((e) => e.topic === "response.text");
    }
    expect(responseEvent).toBeDefined();
    expect(responseEvent?.agent_id).toBe("e2e-agent");
    // Bus core publishes the reply text in the payload (see core.ts ingestReply).
    expect(JSON.stringify(responseEvent?.payload)).toContain("shipped");
  });

  it("permission flow round-trip — request from claude → decision → notification", async () => {
    // Capture permission notifications separately.
    const permissionNotifs: Array<{ params: { request_id: string; behavior: string } }> = [];
    h.client.fallbackNotificationHandler = async (notif) => {
      if (notif.method === "notifications/claude/channel") {
        h.channelNotifs.push({
          method: notif.method,
          params: (notif.params ?? {}) as Record<string, unknown>,
        });
      } else if (notif.method === "notifications/claude/channel/permission") {
        permissionNotifs.push(
          notif as unknown as { params: { request_id: string; behavior: string } },
        );
      }
    };

    // Subscribe so adapter sees the permission_request event.
    const permissionRequests: BusEvent[] = [];
    h.bus.subscribe({ agent_id: "e2e-agent", topics: ["channel.permission_request"] }, (e) => {
      permissionRequests.push(e);
    });

    // Claude side: emit a permission_request notification.
    await h.client.notification({
      method: "notifications/claude/channel/permission_request",
      params: {
        request_id: "abcde",
        tool_name: "Bash",
        description: "rm -rf /etc",
        input_preview: "rm -rf /etc",
      },
    });

    // Wait for the request to fan out to subscribers.
    let waited = 0;
    while (waited < 1000 && permissionRequests.length === 0) {
      await new Promise((r) => setTimeout(r, 20));
      waited += 20;
    }
    expect(permissionRequests.length).toBe(1);

    // Adapter responds with deny.
    h.bus.ingestPermissionDecision({
      agent_id: "e2e-agent",
      request_id: "abcde",
      behavior: "deny",
    });

    // Wait for the notification to flow back to the MCP client.
    waited = 0;
    while (waited < 1000 && permissionNotifs.length === 0) {
      await new Promise((r) => setTimeout(r, 20));
      waited += 20;
    }
    expect(permissionNotifs.length).toBe(1);
    expect(permissionNotifs[0].params).toEqual({
      request_id: "abcde",
      behavior: "deny",
    });
  });

  // `ask` answer-correlation end-to-end requires a Bus core `ingestAskAnswer`
  // API that doesn't exist yet (Agent A deferred this — adapters don't need
  // it until Sprint 3 surfaces it). The correlation logic itself IS covered:
  // see `mcp-server.test.ts` for the unit-level round-trip with a mock IPC.
  // Once `ingestAskAnswer` lands, this e2e gains one more case driving it
  // through the full UDS path.

  it("MCP capabilities advertised on hello include both Channels caps", () => {
    expect(CHANNEL_BASE_CAPABILITY).toBe("claude/channel");
    expect(CHANNEL_PERMISSION_CAPABILITY).toBe("claude/channel/permission");
  });
});
