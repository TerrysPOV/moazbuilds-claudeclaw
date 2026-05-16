import { describe, it, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { McpServerProcess } from "../plugins/mcp-proxy/server-process.js";

const MOCK_SERVER = fileURLToPath(new URL("./fixtures/mock-mcp-server.ts", import.meta.url));
const BUN_BIN = process.execPath;

// Expose private state for grey-box crash supervision tests
type ProcPrivate = {
  stopping: boolean;
  status: string;
  crashTimestamps: number[];
  crashCount: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  _handleCrash(reason: string): void;
};

function privateOf(proc: McpServerProcess): ProcPrivate {
  return proc as unknown as ProcPrivate;
}

function makeConfig(allowedTools?: string[]) {
  return {
    command: BUN_BIN,
    args: ["run", MOCK_SERVER],
    allowedTools: allowedTools ?? ["echo"],
  };
}

const activeTmpDirs: string[] = [];

afterEach(() => {
  for (const d of activeTmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true });
    } catch {}
  }
});

describe("mcp-proxy crash supervision edges", () => {
  // ── Test 1 — crash window resets after 6 minutes ─────────────────────────

  it("4 crashes in window + 1 crash 6min later: counter resets, server not permanently failed", () => {
    const proc = new McpServerProcess("crash-window-test", makeConfig());
    const p = privateOf(proc);

    // Pre-populate 4 old crashes that are 6+ minutes outside the 5-min window
    const SIX_MINUTES_AGO = Date.now() - 6 * 60 * 1000;
    p.crashTimestamps = [
      SIX_MINUTES_AGO,
      SIX_MINUTES_AGO + 1,
      SIX_MINUTES_AGO + 2,
      SIX_MINUTES_AGO + 3,
    ];
    p.crashCount = 4;
    p.stopping = false;

    // Trigger one fresh crash
    p.status = "up";
    p._handleCrash("fresh crash after window expired");

    // Old timestamps should be filtered out — crash count in window = 1
    expect(p.crashTimestamps.length).toBe(1);
    expect(p.status).not.toBe("failed");
    expect(p.status).toBe("restarting");

    // Clean up the restart timer so no actual spawn happens
    if (p.restartTimer !== null) {
      clearTimeout(p.restartTimer);
      p.restartTimer = null;
    }
    p.stopping = true;
  });

  // ── Test 2 — backoff sequence timing ─────────────────────────────────────

  it("5 successive crashes produce backoff delays matching [1s, 5s, 30s, 60s, 60s]", () => {
    const capturedDelays: number[] = [];
    const origSetTimeout = global.setTimeout;

    // Intercept setTimeout to capture delay values without actually scheduling
    (global as unknown as Record<string, unknown>).setTimeout = (fn: () => void, delay: number) => {
      capturedDelays.push(delay);
      return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    };

    try {
      const proc = new McpServerProcess("backoff-test", makeConfig());
      const p = privateOf(proc);
      p.stopping = false;

      const EXPECTED = [1_000, 5_000, 30_000, 60_000, 60_000];
      for (let i = 0; i < 5; i++) {
        p.status = "up";
        p.crashTimestamps = []; // reset window for clean test
        p.crashCount = i; // crashCount before this crash (backoff index = crashCount)
        p._handleCrash(`crash ${i + 1}`);
      }

      expect(capturedDelays.length).toBe(5);
      for (let i = 0; i < 5; i++) {
        expect(capturedDelays[i]).toBe(EXPECTED[i]);
      }
    } finally {
      (global as unknown as Record<string, unknown>).setTimeout = origSetTimeout;
    }
  });

  // ── Test 3 — invocation during backoff returns clean error ────────────────

  it("call() during backoff (status=restarting) throws a clear error, daemon does not crash", async () => {
    const proc = new McpServerProcess("backoff-call-test", makeConfig());
    const p = privateOf(proc);

    // Simulate crashed state (server never actually started — no real subprocess)
    p.status = "restarting";
    p.stopping = false;

    // call() should throw a clean "not ready" error, not an unhandled rejection
    let error: Error | null = null;
    try {
      await proc.call("echo", { message: "test" });
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }

    expect(error).not.toBeNull();
    expect(error!.message).toContain("restarting");
    // Status must still be "restarting" — the call attempt didn't corrupt state
    expect(p.status).toBe("restarting");
  });

  // ── Test 4 — stop() during restart timer cancels cleanly ─────────────────

  it("stop() during backoff clears restartTimer and sets status=stopped without spawning", async () => {
    const proc = new McpServerProcess("stop-during-backoff-test", makeConfig());
    const p = privateOf(proc);

    // Simulate a crash (no real subprocess — restartTimer is set)
    p.status = "up";
    p.stopping = false;
    p.crashTimestamps = [];
    p.crashCount = 0;
    p._handleCrash("test crash");

    // Should now be in restarting state with a timer pending
    expect(p.status).toBe("restarting");
    expect(p.restartTimer).not.toBeNull();

    // Stop during backoff
    await proc.stop();

    // Timer must be cleared and status must be stopped
    expect(p.restartTimer).toBeNull();
    expect(p.status).toBe("stopped");
    expect(p.stopping).toBe(true);

    // A subsequent _handleCrash call must be a no-op (stopping guard)
    p._handleCrash("spurious crash after stop");
    expect(p.status).toBe("stopped");
  });
});
