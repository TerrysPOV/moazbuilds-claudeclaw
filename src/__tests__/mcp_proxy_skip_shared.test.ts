/**
 * Tests for the multiplexer-induced skip rule in `McpProxyPlugin.start()`:
 * any server name present in `settings.mcp.shared` is dropped from the
 * mcp-proxy startup list so the multiplexer can claim that upstream
 * child exclusively. SPEC §4.1 step 4 + §6.2.
 *
 * These tests rely on the `cached` settings shim — they load real
 * settings, override the `mcp.shared` field, then invoke the proxy. To
 * keep them isolated from `~/.config/claudeclaw/...`, every test points
 * the proxy at a tmpdir-scoped fake `mcp-proxy.json`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { McpProxyPlugin, _resetMcpProxy } from "../plugins/mcp-proxy/index.js";
import { _resetMcpBridge, getMcpBridge } from "../plugins/mcp-bridge.js";
import { _resetHttpGateway } from "../plugins/http-gateway.js";
import { initConfig, loadSettings } from "../config.js";

const MOCK_SERVER = fileURLToPath(
  new URL("./fixtures/mock-mcp-server.ts", import.meta.url),
);
const BUN_BIN = process.execPath;

function writeProxyConfig(dir: string, servers: string[]): string {
  const cfg = {
    servers: Object.fromEntries(
      servers.map((name) => [
        name,
        {
          command: BUN_BIN,
          args: ["run", MOCK_SERVER],
          enabled: true,
          allowedTools: ["echo"],
        },
      ]),
    ),
  };
  const path = join(dir, "mcp-proxy.json");
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-proxy-skip-test-"));
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpProxy();
  // Ensure settings.json exists, then load — the skip-shared helper
  // mutates the cached settings object in-place. `initConfig` writes
  // defaults if no file is present.
  await initConfig();
  await loadSettings();
});

afterEach(async () => {
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpProxy();
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {}
});

describe("McpProxyPlugin — skip rule for shared servers", () => {
  it("starts every enabled server when mcp.shared is empty", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha", "beta"]);

    // Patch live settings cache to ensure mcp.shared is empty.
    const settings = (await loadSettings()) as unknown as {
      mcp?: { shared?: string[] };
    };
    settings.mcp = { shared: [] };

    const plugin = new McpProxyPlugin({
      configPath: cfgPath,
      tokenPath: join(tmpDir, "mcp-proxy.token"),
    });
    await plugin.start();

    try {
      const bridge = getMcpBridge();
      const fqns = bridge.listTools().map((t) => t.fqn);
      // mcp-proxy registers under pluginId "mcp-proxy" → fqn prefixed.
      expect(fqns).toContain("mcp-proxy__alpha__echo");
      expect(fqns).toContain("mcp-proxy__beta__echo");
    } finally {
      await plugin.stop();
    }
  });

  it("skips servers listed in mcp.shared", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha", "beta", "gamma"]);

    const settings = (await loadSettings()) as unknown as {
      mcp?: { shared?: string[] };
    };
    settings.mcp = { shared: ["alpha", "beta"] };

    const plugin = new McpProxyPlugin({
      configPath: cfgPath,
      tokenPath: join(tmpDir, "mcp-proxy.token"),
    });
    await plugin.start();

    try {
      const fqns = getMcpBridge().listTools().map((t) => t.fqn);
      expect(fqns).not.toContain("mcp-proxy__alpha__echo");
      expect(fqns).not.toContain("mcp-proxy__beta__echo");
      // gamma was not in shared → mcp-proxy still owns it.
      expect(fqns).toContain("mcp-proxy__gamma__echo");
    } finally {
      await plugin.stop();
    }
  });

  it("missing mcp settings (W2 not yet wired) is treated as empty shared", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);

    const settings = (await loadSettings()) as unknown as {
      mcp?: { shared?: string[] };
    };
    delete settings.mcp;

    const plugin = new McpProxyPlugin({
      configPath: cfgPath,
      tokenPath: join(tmpDir, "mcp-proxy.token"),
    });
    await plugin.start();

    try {
      const fqns = getMcpBridge().listTools().map((t) => t.fqn);
      expect(fqns).toContain("mcp-proxy__alpha__echo");
    } finally {
      await plugin.stop();
    }
  });

  it("non-array mcp.shared is treated as empty", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);

    const settings = (await loadSettings()) as unknown as {
      mcp?: unknown;
    };
    settings.mcp = { shared: "not-an-array" };

    const plugin = new McpProxyPlugin({
      configPath: cfgPath,
      tokenPath: join(tmpDir, "mcp-proxy.token"),
    });
    await plugin.start();

    try {
      const fqns = getMcpBridge().listTools().map((t) => t.fqn);
      expect(fqns).toContain("mcp-proxy__alpha__echo");
    } finally {
      await plugin.stop();
    }
  });
});
