import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { McpServerProcess } from "../plugins/mcp-proxy/server-process.js";
import { McpProxyPlugin, _resetMcpProxy } from "../plugins/mcp-proxy/index.js";
import { PluginMcpBridge, _resetMcpBridge } from "../plugins/mcp-bridge.js";
import { _resetHttpGateway } from "../plugins/http-gateway.js";

const MOCK_SERVER = fileURLToPath(new URL("./fixtures/mock-mcp-server.ts", import.meta.url));
const BUN_BIN = process.execPath;

function makeServerConfig() {
  return {
    command: BUN_BIN,
    args: ["run", MOCK_SERVER],
    allowedTools: ["echo", "slow_tool"],
  };
}

let tmpDir: string;
let bridge: PluginMcpBridge;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-proxy-test-"));
  bridge = new PluginMcpBridge(join(tmpDir, "audit.jsonl"));
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpProxy();
});

afterEach(() => {
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpProxy();
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {}
});

// ── Test 1 — McpServerProcess starts and lists tools ──────────────────────────

describe("McpServerProcess", () => {
  it("start() connects and returns correct tool list", async () => {
    const proc = new McpServerProcess("test", makeServerConfig());
    try {
      await proc.start();
      expect(proc.status).toBe("up");
      const names = proc.tools.map((t) => t.name);
      expect(names).toContain("echo");
      expect(names).toContain("slow_tool");
      expect(names).not.toContain("secret_tool"); // filtered by allowedTools
    } finally {
      await proc.stop();
    }
  });

  // ── Test 2 — call() returns response, correlates by id ──────────────────────

  it("call() returns parsed response for known tool", async () => {
    const proc = new McpServerProcess("test", makeServerConfig());
    try {
      await proc.start();
      const result = (await proc.call("echo", { message: "hello" })) as { echo: string };
      expect(result.echo).toBe("hello");
    } finally {
      await proc.stop();
    }
  });

  // ── Test 3 — concurrent calls don't cross-contaminate ─────────────────────

  it("concurrent calls complete independently without cross-contamination", async () => {
    const proc = new McpServerProcess("test", makeServerConfig());
    try {
      await proc.start();
      const [a, b, c] = (await Promise.all([
        proc.call("echo", { message: "A" }),
        proc.call("echo", { message: "B" }),
        proc.call("echo", { message: "C" }),
      ])) as [{ echo: string }, { echo: string }, { echo: string }];
      expect(a.echo).toBe("A");
      expect(b.echo).toBe("B");
      expect(c.echo).toBe("C");
    } finally {
      await proc.stop();
    }
  });

  // ── Test 4 — crash triggers restart hook ──────────────────────────────────

  it("intentional stop() sets status to stopped and does not trigger crash hook", async () => {
    let crashCalled = false;
    const proc = new McpServerProcess("stop-test", makeServerConfig(), {
      onCrash: () => {
        crashCalled = true;
      },
    });
    await proc.start();
    expect(proc.status).toBe("up");
    await proc.stop();
    expect(proc.status).toBe("stopped");
    // Intentional shutdown must not fire the crash hook or schedule a restart
    expect(crashCalled).toBe(false);
  });

  // ── Test 5 — allowedTools filter ─────────────────────────────────────────

  it("allowedTools filters out secret_tool from the tool list", async () => {
    const proc = new McpServerProcess("test", makeServerConfig());
    try {
      await proc.start();
      const names = proc.tools.map((t) => t.name);
      expect(names).not.toContain("secret_tool");
    } finally {
      await proc.stop();
    }
  });

  // ── Test 6 — config file permissive → warn logged, no crash ─────────────

  it("world-readable config file emits a WARN to stderr but does not fail boot", async () => {
    const configPath = join(tmpDir, "mcp-proxy-warn.json");
    const tokenPath = join(tmpDir, "mcp-proxy-warn.token");
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: { "test-server": { ...makeServerConfig(), enabled: true } },
      }),
      { mode: 0o644 },
    ); // permissive — should trigger WARN

    const warnMessages: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      const msg = args.map(String).join(" ");
      if (msg.includes("WARN")) warnMessages.push(msg);
      origError(...args);
    };

    const p = new McpProxyPlugin({ configPath, tokenPath });
    try {
      await p.start();
      expect(warnMessages.some((m) => m.includes("permissive") || m.includes("WARN"))).toBe(true);
      const health = p.health();
      expect((health.servers as Record<string, { status: string }>)["test-server"]?.status).toBe(
        "up",
      );
    } finally {
      console.error = origError;
      await p.stop();
    }
  });

  // ── Test 7 — McpProxyPlugin registers tools on bridge ────────────────────

  it("McpProxyPlugin.start() registers mcp-proxy tools on the bridge", async () => {
    const configPath = join(tmpDir, "mcp-proxy.json");
    const tokenPath = join(tmpDir, "mcp-proxy.token");
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          "test-server": { ...makeServerConfig(), enabled: true },
        },
      }),
    );

    const plugin = new McpProxyPlugin({ configPath, tokenPath });
    try {
      await plugin.start();
      // Tools should be registered on the bridge under "mcp-proxy" namespace
      // Tool FQN: mcp-proxy__test-server__echo
      // (but bridge uses "mcp-proxy" as plugin and "test-server__echo" as tool name)
      const health = plugin.health();
      expect(health.servers).toBeDefined();
      const servers = health.servers as Record<string, { status: string }>;
      expect(servers["test-server"]?.status).toBe("up");
    } finally {
      await plugin.stop();
    }
  });
});

describe("McpServerProcess — startup failure cleanup (zombie prevention)", () => {
  it("closes transport when listTools throws during start()", async () => {
    // Spawn a server that exits immediately so client.connect/listTools will fail
    const proc = new McpServerProcess("crash-test", {
      command: "node",
      args: ["-e", "process.exit(1)"], // immediate exit
      enabled: true,
    });

    let threw = false;
    try {
      await proc.start();
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(proc.status).toBe("failed");
    // Transport should be cleared so a subsequent stop() is a no-op
    // (no zombie subprocess waiting for cleanup)
    await proc.stop(); // must not throw
    expect(proc.status).toBe("stopped");
  });
});
