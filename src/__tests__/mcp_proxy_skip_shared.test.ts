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

const MOCK_SERVER = fileURLToPath(new URL("./fixtures/mock-mcp-server.ts", import.meta.url));
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
  it("starts every enabled server when the multiplexer claims nothing", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha", "beta"]);

    const plugin = new McpProxyPlugin({
      configPath: cfgPath,
      tokenPath: join(tmpDir, "mcp-proxy.token"),
      claimedByMultiplexer: () => new Set(),
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

  it("skips servers actively claimed by the multiplexer", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha", "beta", "gamma"]);

    const plugin = new McpProxyPlugin({
      configPath: cfgPath,
      tokenPath: join(tmpDir, "mcp-proxy.token"),
      claimedByMultiplexer: () => new Set(["alpha", "beta"]),
    });
    await plugin.start();

    try {
      const fqns = getMcpBridge()
        .listTools()
        .map((t) => t.fqn);
      expect(fqns).not.toContain("mcp-proxy__alpha__echo");
      expect(fqns).not.toContain("mcp-proxy__beta__echo");
      // gamma was not claimed → mcp-proxy still owns it.
      expect(fqns).toContain("mcp-proxy__gamma__echo");
    } finally {
      await plugin.stop();
    }
  });

  it("Codex PR #71 P1 regression — DOES NOT skip when multiplexer is dormant despite mcp.shared being populated", async () => {
    // Scenario: operator put `mcp.shared = ["alpha"]` in settings, but the
    // multiplexer plugin went dormant for any reason (web disabled,
    // non-loopback host, zero claimed servers, missing mcp-proxy.json).
    // Before the fix, mcp-proxy still skipped "alpha" → tools became
    // unreachable from BOTH paths. After the fix, mcp-proxy spawns it
    // because the multiplexer isn't actually serving it.
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);

    // Even with settings.mcp.shared populated, the multiplexer hasn't
    // claimed anything → resolver returns empty set.
    const settings = (await loadSettings()) as unknown as {
      mcp?: { shared?: string[] };
    };
    settings.mcp = { shared: ["alpha"] };

    const plugin = new McpProxyPlugin({
      configPath: cfgPath,
      tokenPath: join(tmpDir, "mcp-proxy.token"),
      claimedByMultiplexer: () => new Set(), // dormant
    });
    await plugin.start();

    try {
      const fqns = getMcpBridge()
        .listTools()
        .map((t) => t.fqn);
      // mcp-proxy still serves alpha — legacy callsites keep working.
      expect(fqns).toContain("mcp-proxy__alpha__echo");
    } finally {
      await plugin.stop();
    }
  });

  it("defaults to the production resolver when no test seam is provided", async () => {
    // Smoke test: in the absence of an active multiplexer plugin singleton,
    // the production resolver should return an empty set and proxy spawns
    // everything.
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);

    const plugin = new McpProxyPlugin({
      configPath: cfgPath,
      tokenPath: join(tmpDir, "mcp-proxy.token"),
      // No claimedByMultiplexer override — uses default resolver.
    });
    await plugin.start();

    try {
      const fqns = getMcpBridge()
        .listTools()
        .map((t) => t.fqn);
      expect(fqns).toContain("mcp-proxy__alpha__echo");
    } finally {
      await plugin.stop();
    }
  });
});
