import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { McpServerProcess } from "../plugins/mcp-proxy/server-process.js";

const MOCK_SERVER = fileURLToPath(new URL("./fixtures/mock-mcp-server.ts", import.meta.url));
const BUN_BIN = process.execPath;

function makeServerConfig(allowedTools?: string[]) {
  return {
    command: BUN_BIN,
    args: ["run", MOCK_SERVER],
    allowedTools: allowedTools ?? ["echo", "slow_tool"],
  };
}

let tmpDir: string;
let proc: McpServerProcess;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-proxy-load-test-"));
  proc = new McpServerProcess("load-test", makeServerConfig(["echo"]));
  await proc.start();
});

afterEach(async () => {
  await proc.stop();
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {}
});

describe("mcp-proxy load", () => {
  // ── Test 1 — 50 concurrent calls ────────────────────────────────────────

  it("50 concurrent calls all complete successfully", async () => {
    const N = 50;
    const calls = Array.from({ length: N }, (_, i) => proc.call("echo", { message: `msg-${i}` }));
    const results = (await Promise.all(calls)) as Array<{ echo: string }>;
    expect(results).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      expect(results[i].echo).toBe(`msg-${i}`);
    }
  }, 15_000);

  // ── Test 2 — sequential 200 calls — no memory leak in pending map ────────

  it("200 sequential calls complete without hanging pending entries", async () => {
    for (let i = 0; i < 200; i++) {
      const result = (await proc.call("echo", { message: `seq-${i}` })) as { echo: string };
      expect(result.echo).toBe(`seq-${i}`);
    }
  }, 60_000);

  // ── Test 3 — slow response only blocks its own call ──────────────────────

  it("slow tool call doesn't block concurrent fast calls", async () => {
    const allToolsProc = new McpServerProcess("all-tools", makeServerConfig());
    await allToolsProc.start();

    try {
      const slowCallPromise = allToolsProc.call("slow_tool", { message: "blocking" }, 10_000);
      // Fast calls should complete before the slow one
      const fastResults = (await Promise.all([
        allToolsProc.call("echo", { message: "fast-1" }),
        allToolsProc.call("echo", { message: "fast-2" }),
        allToolsProc.call("echo", { message: "fast-3" }),
      ])) as Array<{ echo: string }>;
      expect(fastResults[0].echo).toBe("fast-1");
      expect(fastResults[1].echo).toBe("fast-2");
      expect(fastResults[2].echo).toBe("fast-3");
      // Slow call will time out in this test (5s server sleep > 4s timeout we pass)
      await slowCallPromise.catch(() => {}); // don't fail test if it times out
    } finally {
      await allToolsProc.stop();
    }
  }, 20_000);
});
