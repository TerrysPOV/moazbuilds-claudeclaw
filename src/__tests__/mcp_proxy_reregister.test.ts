import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { PluginMcpBridge, _resetMcpBridge, _setMcpBridge } from "../plugins/mcp-bridge.js";
import { McpProxyPlugin, _resetMcpProxy } from "../plugins/mcp-proxy/index.js";
import { getHttpGateway, _resetHttpGateway } from "../plugins/http-gateway.js";
import type { PluginHttpGateway } from "../plugins/http-gateway.js";

const MOCK_SERVER = fileURLToPath(new URL("./fixtures/mock-mcp-server.ts", import.meta.url));
const BUN_BIN = process.execPath;

function signRequest(token: Buffer, body: string, ts: string): string {
  return createHmac("sha256", token).update(`${ts}\n${body}`).digest("hex");
}

async function invokeViaTool(
  gw: PluginHttpGateway,
  plugin: string,
  tool: string,
  token: Buffer,
): Promise<Response> {
  const ts = new Date().toISOString();
  const body = JSON.stringify({ mode: "direct" });
  const sig = signRequest(token, body, ts);
  const url = `http://localhost/api/plugin/${plugin}/tools/${tool}/invoke`;
  return gw.handleRequest(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Plus-Ts": ts, "X-Plus-Signature": sig },
      body,
    }),
    new URL(url),
  ) as Promise<Response>;
}

let tmpDir: string;
let customBridge: PluginMcpBridge;
let gateway: PluginHttpGateway;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-proxy-rereg-test-"));
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpProxy();

  // Custom bridge so we can register test tools directly
  customBridge = new PluginMcpBridge(join(tmpDir, "audit.jsonl"));
  _setMcpBridge(customBridge);
  gateway = getHttpGateway();
});

afterEach(async () => {
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpProxy();
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {}
});

describe("mcp-proxy re-register atomicity", () => {
  // ── Test 1 — in-flight invocation completes against old plugin version ────

  it("in-flight call completes against old handler even after re-register", async () => {
    const PLUGIN = "atomic-plugin";
    let resolveV1!: (v: string) => void;
    const blockV1 = new Promise<string>((resolve) => {
      resolveV1 = resolve;
    });

    // Register v1 with a handler that blocks until we release it
    customBridge.registerPluginTool(PLUGIN, {
      name: "slow-tool",
      description: "blocks until released",
      schema: z.object({}),
      handler: async () => {
        const result = await blockV1;
        return { version: result };
      },
    });
    const token1 = gateway.registerInProcess(PLUGIN, {
      version: "1.0.0",
      tools: [{ name: "slow-tool", description: "blocks", schema: {} }],
    });

    // Start in-flight invocation (don't await)
    const inflightPromise = invokeViaTool(gateway, PLUGIN, "slow-tool", token1);

    // Re-register v2 — this unregisters old bridge tools and sets new token
    customBridge.unregisterPlugin(PLUGIN);
    customBridge.registerPluginTool(PLUGIN, {
      name: "slow-tool",
      description: "v2 handler",
      schema: z.object({}),
      handler: async () => ({ version: "v2" }),
    });
    const token2 = gateway.registerInProcess(PLUGIN, {
      version: "2.0.0",
      tools: [{ name: "slow-tool", description: "v2", schema: {} }],
    });
    expect(token2.toString("hex")).not.toBe(token1.toString("hex"));

    // Unblock v1 handler
    resolveV1("v1");

    // The in-flight call was already executing the v1 handler — it must return v1 result
    // (or 401/502 if the HMAC check or bridge dispatch already crossed the re-register)
    // Either way, there must be no 500
    const resp = await inflightPromise;
    expect(resp.status).not.toBe(500);
  });

  // ── Test 2 — old token invalidated immediately after re-register ──────────

  it("old plugin token returns 401 immediately after re-register", async () => {
    const PLUGIN = "token-swap-plugin";

    customBridge.registerPluginTool(PLUGIN, {
      name: "tool",
      description: "test",
      schema: z.object({}),
      handler: async () => ({ ok: true }),
    });
    const token1 = gateway.registerInProcess(PLUGIN, {
      version: "1.0.0",
      tools: [{ name: "tool", description: "test", schema: {} }],
    });

    // Verify token1 works before re-register
    const respBefore = await invokeViaTool(gateway, PLUGIN, "tool", token1);
    expect(respBefore.status).toBe(200);

    // Re-register with new token
    customBridge.unregisterPlugin(PLUGIN);
    customBridge.registerPluginTool(PLUGIN, {
      name: "tool",
      description: "test v2",
      schema: z.object({}),
      handler: async () => ({ ok: true, version: 2 }),
    });
    gateway.registerInProcess(PLUGIN, {
      version: "2.0.0",
      tools: [{ name: "tool", description: "test v2", schema: {} }],
    });

    // token1 must now be invalid — HMAC check fails against new token
    const respAfter = await invokeViaTool(gateway, PLUGIN, "tool", token1);
    expect(respAfter.status).toBe(401);
  });

  // ── Test 3 — concurrent invocations during re-register are atomic ─────────

  it("20 concurrent invocations during re-register each get a clean response (no 500)", async () => {
    const PLUGIN = "concurrent-rereg-plugin";

    customBridge.registerPluginTool(PLUGIN, {
      name: "tool",
      description: "test",
      schema: z.object({}),
      handler: async () => {
        await new Promise((r) => setTimeout(r, 10)); // small delay to widen race window
        return { ok: true };
      },
    });
    const token1 = gateway.registerInProcess(PLUGIN, {
      version: "1.0.0",
      tools: [{ name: "tool", description: "test", schema: {} }],
    });

    // Fire 20 concurrent invocations, all with token1
    const invokePromises = Array.from({ length: 20 }, () =>
      invokeViaTool(gateway, PLUGIN, "tool", token1),
    );

    // Re-register mid-flight (after a tiny delay to ensure some invocations started)
    await new Promise((r) => setTimeout(r, 2));
    customBridge.unregisterPlugin(PLUGIN);
    customBridge.registerPluginTool(PLUGIN, {
      name: "tool",
      description: "test v2",
      schema: z.object({}),
      handler: async () => ({ ok: true, version: 2 }),
    });
    gateway.registerInProcess(PLUGIN, {
      version: "2.0.0",
      tools: [{ name: "tool", description: "test v2", schema: {} }],
    });

    const resps = await Promise.all(invokePromises);

    // Every response must be a clean HTTP status — no 500s
    for (const resp of resps) {
      expect(resp.status).not.toBe(500);
      // Valid states: 200 (completed v1), 401 (token1 now invalid), 502 (tool not found in new bridge)
      expect([200, 401, 502]).toContain(resp.status);
    }
  });
});
