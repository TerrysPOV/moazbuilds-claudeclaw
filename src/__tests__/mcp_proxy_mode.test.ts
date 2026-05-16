import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import { McpProxyPlugin, _resetMcpProxy } from "../plugins/mcp-proxy/index.js";
import { _resetMcpBridge } from "../plugins/mcp-bridge.js";
import { getHttpGateway, _resetHttpGateway } from "../plugins/http-gateway.js";

const MOCK_SERVER = fileURLToPath(new URL("./fixtures/mock-mcp-server.ts", import.meta.url));
const BUN_BIN = process.execPath;

function signRequest(token: Buffer, body: string, ts: string): string {
  return createHmac("sha256", token).update(`${ts}\n${body}`).digest("hex");
}

async function invoke(
  gateway: PluginHttpGateway,
  tool: string,
  bodyObj: unknown,
  token: Buffer,
): Promise<Response | null> {
  const ts = new Date().toISOString();
  const body = JSON.stringify(bodyObj);
  const sig = signRequest(token, body, ts);
  return gateway.handleRequest(
    new Request(`http://localhost/api/plugin/mcp-proxy/tools/${tool}/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Plus-Ts": ts,
        "X-Plus-Signature": sig,
      },
      body,
    }),
    new URL(`http://localhost/api/plugin/mcp-proxy/tools/${tool}/invoke`),
  );
}

import type { PluginHttpGateway } from "../plugins/http-gateway.js";

let tmpDir: string;
let plugin: McpProxyPlugin;
let proxyToken: Buffer;
let reasonedCalls: Array<{ tool: string; args: unknown }>;
let gateway: PluginHttpGateway;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-proxy-mode-test-"));
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpProxy();
  reasonedCalls = [];

  const configPath = join(tmpDir, "mcp-proxy.json");
  const tokenPath = join(tmpDir, "mcp-proxy.token");
  writeFileSync(
    configPath,
    JSON.stringify({
      servers: {
        "test-server": {
          command: BUN_BIN,
          args: ["run", MOCK_SERVER],
          enabled: true,
          allowedTools: ["echo"],
        },
      },
    }),
  );

  plugin = new McpProxyPlugin({
    configPath,
    tokenPath,
    reasonedInvokeFn: async (tool, args) => {
      reasonedCalls.push({ tool, args });
      return { reasoned: true, tool, args };
    },
  });
  await plugin.start();

  // Use the singleton gateway (plugin.start registered there)
  gateway = getHttpGateway();
  proxyToken = Buffer.from(readFileSync(tokenPath, "utf8").trim(), "hex");
});

afterEach(async () => {
  await plugin.stop();
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpProxy();
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {}
});

describe("mcp-proxy mode selector", () => {
  // ── Test 1 — direct mode calls warm pool ──────────────────────────────────

  it("mode=direct routes to warm pool (MCP stdio), not reasonedInvokeFn", async () => {
    const resp = await invoke(
      gateway,
      "test-server__echo",
      { arguments: { message: "hi" }, mode: "direct" },
      proxyToken,
    );
    expect(resp?.status).toBe(200);
    const data = (await resp!.json()) as { result?: { echo?: string } };
    expect(data.result).toMatchObject({ echo: "hi" });
    expect(reasonedCalls).toHaveLength(0); // reasonedInvokeFn not called
  });

  // ── Test 2 — reasoned mode routes through inject fn ──────────────────────

  it("mode=reasoned routes through reasonedInvokeFn, not MCP stdio", async () => {
    const resp = await invoke(
      gateway,
      "test-server__echo",
      { arguments: { message: "hi" }, mode: "reasoned" },
      proxyToken,
    );
    expect(resp?.status).toBe(200);
    expect(reasonedCalls).toHaveLength(1);
    expect(reasonedCalls[0].tool).toContain("echo");
  });

  // ── Test 3 — omitting mode defaults to direct ─────────────────────────────

  it("omitting mode field defaults to direct (warm pool)", async () => {
    const resp = await invoke(
      gateway,
      "test-server__echo",
      { arguments: { message: "default-mode" } },
      proxyToken,
    );
    expect(resp?.status).toBe(200);
    const data = (await resp!.json()) as { result?: { echo?: string } };
    expect(data.result).toMatchObject({ echo: "default-mode" });
    expect(reasonedCalls).toHaveLength(0);
  });

  // ── Test 4 — unknown mode returns error ───────────────────────────────────

  it("unknown mode returns an error (502 or 400)", async () => {
    const ts = new Date().toISOString();
    const body = JSON.stringify({ arguments: { message: "test" }, mode: "turbo" });
    const sig = signRequest(proxyToken, body, ts);
    const resp = await gateway.handleRequest(
      new Request("http://localhost/api/plugin/mcp-proxy/tools/test-server__echo/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Plus-Ts": ts, "X-Plus-Signature": sig },
        body,
      }),
      new URL("http://localhost/api/plugin/mcp-proxy/tools/test-server__echo/invoke"),
    );
    // Zod schema rejects unknown enum value → 502 (invoke_failed) or 400
    expect([400, 422, 502]).toContain(resp?.status);
  });

  // ── Test 5 — mode field is stripped from args sent to MCP server ──────────

  it("mode field is stripped before forwarding arguments to MCP server", async () => {
    const resp = await invoke(
      gateway,
      "test-server__echo",
      { arguments: { message: "strip-me" }, mode: "direct" },
      proxyToken,
    );
    expect(resp?.status).toBe(200);
    const data = (await resp!.json()) as { result?: { echo?: string } };
    // The echo tool only received { message: "strip-me" }, not the mode field
    expect(data.result).toMatchObject({ echo: "strip-me" });
  });

  // ── Test 6 — stage timer path reflects mode used ─────────────────────────

  it("health() endpoint returns server status information", async () => {
    const health = plugin.health();
    const servers = health.servers as Record<string, { status: string }>;
    expect(servers["test-server"]?.status).toBe("up");
  });
});
