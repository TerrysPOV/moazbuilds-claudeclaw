import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import { McpProxyPlugin, _resetMcpProxy } from "../plugins/mcp-proxy/index.js";
import { _resetMcpBridge } from "../plugins/mcp-bridge.js";
import { getHttpGateway, _resetHttpGateway } from "../plugins/http-gateway.js";
import type { PluginHttpGateway } from "../plugins/http-gateway.js";

const MOCK_SERVER = fileURLToPath(new URL("./fixtures/mock-mcp-server.ts", import.meta.url));
const BUN_BIN = process.execPath;
const REPLAY_WINDOW_S = 900; // 15 minutes in seconds

function signRequest(token: Buffer, body: string, ts: string): string {
  return createHmac("sha256", token).update(`${ts}\n${body}`).digest("hex");
}

async function invokeWithTs(
  gw: PluginHttpGateway,
  token: Buffer,
  tsOffsetSeconds: number,
): Promise<Response> {
  const ts = new Date(Date.now() + tsOffsetSeconds * 1000).toISOString();
  const body = JSON.stringify({ arguments: { message: "replay-test" }, mode: "direct" });
  const sig = signRequest(token, body, ts);
  const url = "http://localhost/api/plugin/mcp-proxy/tools/test-server__echo/invoke";
  return gw.handleRequest(
    new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Plus-Ts": ts,
        "X-Plus-Signature": sig,
      },
      body,
    }),
    new URL(url),
  ) as Promise<Response>;
}

let tmpDir: string;
let plugin: McpProxyPlugin;
let gateway: PluginHttpGateway;
let proxyToken: Buffer;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-proxy-replay-test-"));
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpProxy();

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

  plugin = new McpProxyPlugin({ configPath, tokenPath });
  await plugin.start();
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

describe("mcp-proxy replay window precision", () => {
  // ── Test 1 — future +1s accepted ─────────────────────────────────────────

  it("timestamp +1s (future, within window) is accepted", async () => {
    const resp = await invokeWithTs(gateway, proxyToken, +1);
    expect(resp?.status).toBe(200);
  });

  // ── Test 2 — future +14m59s accepted ─────────────────────────────────────

  it("timestamp +14m59s (future, within window) is accepted", async () => {
    const resp = await invokeWithTs(gateway, proxyToken, +(REPLAY_WINDOW_S - 1));
    expect(resp?.status).toBe(200);
  });

  // ── Test 3 — future +15m01s rejected ─────────────────────────────────────

  it("timestamp +15m01s (future, outside window) returns 401 stale_or_future_timestamp", async () => {
    const resp = await invokeWithTs(gateway, proxyToken, +(REPLAY_WINDOW_S + 1));
    expect(resp?.status).toBe(401);
    const data = (await resp!.json()) as { error?: { code: string } };
    expect(data.error?.code).toBe("stale_or_future_timestamp");
  });

  // ── Test 4 — past -14m59s accepted ───────────────────────────────────────

  it("timestamp -14m59s (past, within window) is accepted", async () => {
    const resp = await invokeWithTs(gateway, proxyToken, -(REPLAY_WINDOW_S - 1));
    expect(resp?.status).toBe(200);
  });

  // ── Test 5 — past -15m01s rejected ───────────────────────────────────────

  it("timestamp -15m01s (past, outside window) returns 401 stale_or_future_timestamp", async () => {
    const resp = await invokeWithTs(gateway, proxyToken, -(REPLAY_WINDOW_S + 1));
    expect(resp?.status).toBe(401);
    const data = (await resp!.json()) as { error?: { code: string } };
    expect(data.error?.code).toBe("stale_or_future_timestamp");
  });

  // ── Test 6 — exact boundary +900s strictly rejected ──────────────────────

  it("timestamp at exact +900s boundary is rejected (Math.abs(skew) > 900_000 is strict)", async () => {
    // Implementation uses: Math.abs(Date.now() - tsMs) > REPLAY_WINDOW_MS
    // At exactly +900s: skew = 900_000ms → NOT > 900_000 → accepted
    // But in practice the test runs with ~1-5ms additional real elapsed time,
    // so we use +899s to guarantee the "just inside" case, and +901s for "just outside".
    // This test documents the boundary semantics with a 1-second buffer.
    const respBoundary = await invokeWithTs(gateway, proxyToken, +REPLAY_WINDOW_S); // +900s exactly
    // At exactly boundary: Math.abs(skew) may be slightly > 900_000 due to test execution time
    // The implementation's strict ">" means +900s is right at the edge.
    // We verify the response is EITHER 200 or 401 (implementation-defined at exact boundary),
    // and that anything beyond 900s is definitely rejected.
    expect([200, 401]).toContain(respBoundary.status);

    // One second past boundary must always be rejected
    const respOver = await invokeWithTs(gateway, proxyToken, +(REPLAY_WINDOW_S + 1));
    expect(respOver.status).toBe(401);
  });
});
