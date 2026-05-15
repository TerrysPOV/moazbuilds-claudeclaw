import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { PluginMcpBridge, _resetMcpBridge, getMcpBridge } from "../../plugins/mcp-bridge.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeBridge(): { bridge: PluginMcpBridge; auditPath: string; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "mcp-bridge-test-"));
  const auditPath = join(tmpDir, "audit.jsonl");
  const bridge = new PluginMcpBridge(auditPath);
  return { bridge, auditPath, tmpDir };
}

function readAuditLines(auditPath: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

const echoTool = {
  name: "echo",
  description: "Echo input back",
  schema: z.object({ message: z.string() }),
  handler: async (args: { message: string }) => args.message,
};

const addTool = {
  name: "add",
  description: "Add two numbers",
  schema: z.object({ a: z.number(), b: z.number() }),
  handler: async (args: { a: number; b: number }) => args.a + args.b,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PluginMcpBridge", () => {
  describe("registerPluginTool + listTools", () => {
    it("registers a tool and returns it in listTools with correct FQN", () => {
      const { bridge } = makeBridge();

      bridge.registerPluginTool("my-plugin", echoTool);
      const tools = bridge.listTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].fqn).toBe("my-plugin__echo");
      expect(tools[0].description).toBe("Echo input back");
      expect(tools[0].inputSchema).toMatchObject({ type: "object" });
    });

    it("registers multiple tools from different plugins", () => {
      const { bridge } = makeBridge();

      bridge.registerPluginTool("plugin-a", echoTool);
      bridge.registerPluginTool("plugin-b", addTool);
      const tools = bridge.listTools();

      expect(tools).toHaveLength(2);
      const fqns = tools.map((t) => t.fqn);
      expect(fqns).toContain("plugin-a__echo");
      expect(fqns).toContain("plugin-b__add");
    });
  });

  describe("duplicate registration", () => {
    it("throws on duplicate tool FQN", () => {
      const { bridge } = makeBridge();

      bridge.registerPluginTool("my-plugin", echoTool);
      expect(() => bridge.registerPluginTool("my-plugin", echoTool)).toThrow(
        /Duplicate tool registration/,
      );
    });

    it("allows same tool name for different plugins", () => {
      const { bridge } = makeBridge();

      bridge.registerPluginTool("plugin-a", echoTool);
      expect(() => bridge.registerPluginTool("plugin-b", echoTool)).not.toThrow();
    });
  });

  describe("invokeTool", () => {
    it("calls handler with valid args and returns result", async () => {
      const { bridge } = makeBridge();

      bridge.registerPluginTool("calc", addTool);
      const result = await bridge.invokeTool("calc__add", { a: 3, b: 4 });
      expect(result).toBe(7);
    });

    it("throws on invalid args (zod validation failure)", async () => {
      const { bridge } = makeBridge();

      bridge.registerPluginTool("my-plugin", echoTool);
      await expect(bridge.invokeTool("my-plugin__echo", { message: 42 })).rejects.toThrow(
        /Invalid args/,
      );
    });

    it("throws on unknown tool name", async () => {
      const { bridge } = makeBridge();

      await expect(bridge.invokeTool("nonexistent__tool", {})).rejects.toThrow(/Unknown tool/);
    });

    it("propagates handler errors", async () => {
      const { bridge } = makeBridge();

      bridge.registerPluginTool("failing", {
        name: "fail",
        description: "Always fails",
        schema: z.object({}),
        handler: async () => {
          throw new Error("handler exploded");
        },
      });
      await expect(bridge.invokeTool("failing__fail", {})).rejects.toThrow("handler exploded");
    });
  });

  describe("HMAC signing", () => {
    it("signCall + verifyCall round-trip returns true", () => {
      const { bridge } = makeBridge();

      const body = { foo: "bar", count: 42 };
      const ts = Date.now();
      const sig = bridge.signCall("test-plugin", body, ts);
      expect(bridge.verifyCall("test-plugin", body, ts, sig)).toBe(true);
    });

    it("verifyCall rejects tampered signature", () => {
      const { bridge } = makeBridge();

      const body = { foo: "bar" };
      const ts = Date.now();
      const sig = bridge.signCall("test-plugin", body, ts);
      const tampered = sig.slice(0, -2) + "00";
      expect(bridge.verifyCall("test-plugin", body, ts, tampered)).toBe(false);
    });

    it("verifyCall rejects tampered body", () => {
      const { bridge } = makeBridge();

      const ts = Date.now();
      const sig = bridge.signCall("test-plugin", { foo: "bar" }, ts);
      expect(bridge.verifyCall("test-plugin", { foo: "TAMPERED" }, ts, sig)).toBe(false);
    });

    it("verifyCall rejects tampered ts", () => {
      const { bridge } = makeBridge();

      const ts = Date.now();
      const body = { x: 1 };
      const sig = bridge.signCall("test-plugin", body, ts);
      expect(bridge.verifyCall("test-plugin", body, ts + 1, sig)).toBe(false);
    });
  });

  describe("audit log", () => {
    it("writes a register entry when a tool is registered", () => {
      const { bridge, auditPath } = makeBridge();

      bridge.registerPluginTool("audit-test", echoTool);
      const lines = readAuditLines(auditPath);

      expect(lines).toHaveLength(1);
      expect(lines[0].event).toBe("register");
      expect(lines[0].fqn).toBe("audit-test__echo");
    });

    it("writes invoke + success entries when tool is called", async () => {
      const { bridge, auditPath } = makeBridge();

      bridge.registerPluginTool("audit-test", echoTool);
      await bridge.invokeTool("audit-test__echo", { message: "hello" });
      const lines = readAuditLines(auditPath);

      const invokeEntry = lines.find((l) => l.event === "invoke");
      expect(invokeEntry).toBeDefined();
      expect(invokeEntry?.success).toBe(true);
    });

    it("writes error entry on validation failure", async () => {
      const { bridge, auditPath } = makeBridge();

      bridge.registerPluginTool("audit-test", echoTool);
      try {
        await bridge.invokeTool("audit-test__echo", { message: 999 });
      } catch {
        // expected
      }

      const lines = readAuditLines(auditPath);
      const errorEntry = lines.find((l) => l.event === "error");
      expect(errorEntry).toBeDefined();
      expect(errorEntry?.phase).toBe("validation");
    });
  });

  describe("per-plugin secret", () => {
    it("auto-creates a 32-byte secret for a plugin", () => {
      const { bridge } = makeBridge();

      const secret = bridge.loadOrCreateSecret("new-plugin");
      expect(secret).toBeInstanceOf(Buffer);
      expect(secret.length).toBe(32);
    });

    it("returns the same secret on subsequent calls (cached)", () => {
      const { bridge } = makeBridge();

      const a = bridge.loadOrCreateSecret("plugin-x");
      const b = bridge.loadOrCreateSecret("plugin-x");
      expect(a.equals(b)).toBe(true);
    });

    it("different plugins get different secrets", () => {
      const { bridge } = makeBridge();

      const a = bridge.loadOrCreateSecret("plugin-alpha");
      const b = bridge.loadOrCreateSecret("plugin-beta");
      expect(a.equals(b)).toBe(false);
    });
  });

  describe("getMcpBridge singleton", () => {
    it("returns the same instance on multiple calls", () => {
      _resetMcpBridge();
      const a = getMcpBridge();
      const b = getMcpBridge();
      expect(a).toBe(b);
      _resetMcpBridge();
    });
  });
});

describe("path traversal protection (pluginId validation)", () => {
  it("rejects pluginId with .. segments", () => {
    const bridge = new PluginMcpBridge("/tmp/test-audit-pt.jsonl");
    expect(() => bridge.loadOrCreateSecret("../../evil")).toThrow(/invalid pluginId/);
    expect(() =>
      bridge.registerPluginTool("../../evil", {
        name: "x",
        description: "",
        schema: {},
        handler: async () => ({}),
      }),
    ).toThrow(/invalid pluginId/);
    expect(() => bridge.unregisterPlugin("../../evil")).toThrow(/invalid pluginId/);
  });

  it("rejects pluginId with path separators", () => {
    const bridge = new PluginMcpBridge("/tmp/test-audit-pt.jsonl");
    expect(() => bridge.loadOrCreateSecret("a/b")).toThrow(/invalid pluginId/);
    expect(() => bridge.loadOrCreateSecret("a\\b")).toThrow(/invalid pluginId/);
  });

  it("rejects pluginId with dots or special chars", () => {
    const bridge = new PluginMcpBridge("/tmp/test-audit-pt.jsonl");
    expect(() => bridge.loadOrCreateSecret(".hidden")).toThrow(/invalid pluginId/);
    expect(() => bridge.loadOrCreateSecret("a.b")).toThrow(/invalid pluginId/);
    expect(() => bridge.loadOrCreateSecret("a b")).toThrow(/invalid pluginId/);
  });

  it("accepts valid pluginId (lowercase + digits + dashes, starts with letter)", () => {
    const bridge = new PluginMcpBridge("/tmp/test-audit-pt-valid.jsonl");
    // Should not throw
    bridge.loadOrCreateSecret("mcp-proxy");
    bridge.loadOrCreateSecret("archiviste");
    bridge.loadOrCreateSecret("plugin-a1");
  });

  it("rejects empty / too-long pluginId", () => {
    const bridge = new PluginMcpBridge("/tmp/test-audit-pt.jsonl");
    expect(() => bridge.loadOrCreateSecret("")).toThrow(/invalid pluginId/);
    expect(() => bridge.loadOrCreateSecret("a".repeat(65))).toThrow(/invalid pluginId/);
  });

  it("rejects pluginId starting with digit or dash", () => {
    const bridge = new PluginMcpBridge("/tmp/test-audit-pt.jsonl");
    expect(() => bridge.loadOrCreateSecret("1plugin")).toThrow(/invalid pluginId/);
    expect(() => bridge.loadOrCreateSecret("-plugin")).toThrow(/invalid pluginId/);
  });
});
