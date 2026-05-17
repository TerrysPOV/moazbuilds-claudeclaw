/**
 * Tests for src/bus/session-manager.ts
 *
 * Run with: bun test src/bus/__tests__/session-manager.test.ts
 *
 * Notes on test strategy:
 * - We never spawn the real `claude` binary in unit tests. Instead we use
 *   `/bin/cat` (echoes stdin to stdout — useful for assertions about what
 *   we wrote to slash/stream channels) and `/bin/sh -c "exit 0"` patterns
 *   for lifecycle exercises.
 * - For PTY mode we still go through `bun-pty` — it's the same code path
 *   that ships, just with a different binary. Skipped on non-Unix.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultSupervisionFor,
  resolveAgentCwd,
  SessionManager,
  type AgentProcess,
} from "../session-manager";
import type { AgentConfig, BusOrigin } from "../types";

const IS_DARWIN = process.platform === "darwin";
const IS_UNIX = process.platform !== "win32";

/* ───────────────────────────────────────────────────────────────────── */
/* defaultSupervisionFor matrix (spec §5.3, Probe 0.6)                   */
/* ───────────────────────────────────────────────────────────────────── */

describe("defaultSupervisionFor", () => {
  it("returns pty-stdin for channel-driven origins", () => {
    const channelOrigins: BusOrigin[] = ["discord", "telegram", "slack", "webui"];
    for (const origin of channelOrigins) {
      expect(defaultSupervisionFor(origin)).toBe("pty-stdin");
    }
  });

  it("returns process-stream-json for non-channel origins", () => {
    const nonChannel: BusOrigin[] = ["cron", "heartbeat", "cli", "rest"];
    for (const origin of nonChannel) {
      expect(defaultSupervisionFor(origin)).toBe("process-stream-json");
    }
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* cwd realpath (Spike 0.5 macOS /tmp → /private/tmp gotcha)             */
/* ───────────────────────────────────────────────────────────────────── */

describe("resolveAgentCwd", () => {
  it("dereferences symlinks via realpath", () => {
    if (!IS_DARWIN) {
      // Spike 0.5 was macOS-specific (/tmp is a symlink there). On Linux
      // /tmp is a real directory, so realpath is a no-op. Still useful to
      // assert the function returns *something* rather than throwing.
      const out = resolveAgentCwd(tmpdir());
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
      return;
    }
    // On macOS, mkdtemp under `/tmp/...` should resolve to `/private/tmp/...`.
    const dir = mkdtempSync(join("/tmp", "session-mgr-realpath-"));
    try {
      const resolved = resolveAgentCwd(dir);
      // The naive path will start with /tmp; the resolved one with /private/tmp.
      expect(dir.startsWith("/tmp/")).toBe(true);
      expect(resolved.startsWith("/private/tmp/") || resolved === realpathSync(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the input if the path does not exist", () => {
    const bogus = "/nonexistent/no/way/this/exists/xyzzy";
    expect(resolveAgentCwd(bogus)).toBe(bogus);
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* Helpers + scaffolding                                                 */
/* ───────────────────────────────────────────────────────────────────── */

function mkAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const dir = mkdtempSync(join(tmpdir(), "ccaw-agent-"));
  return {
    id: overrides.id ?? "test-agent",
    cwd: dir,
    session_id: overrides.session_id ?? "11111111-2222-3333-4444-555555555555",
    permission_mode: "plan",
    ...overrides,
  };
}

async function waitForExit(proc: AgentProcess, timeoutMs = 3000): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for exit")), timeoutMs);
    proc.onExit((code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for predicate after ${timeoutMs}ms`);
}

/* ───────────────────────────────────────────────────────────────────── */
/* pty-stdin mode (uses bun-pty; requires Unix)                          */
/* ───────────────────────────────────────────────────────────────────── */

describe("pty-stdin supervision", () => {
  if (!IS_UNIX) {
    it.skip("skipped on non-Unix (no bun-pty)", () => {});
    return;
  }

  let mgr: SessionManager;
  const spawned: AgentProcess[] = [];

  beforeEach(() => {
    // Use a path well under the 96B UDS cap. `/bin/cat` doesn't accept the
    // claude flag set, so we strip args entirely via the test seam.
    mgr = new SessionManager({
      commandOverride: "/bin/cat",
      argsOverride: [],
      busSocketPath: "/tmp/test-bus.sock",
    });
  });

  afterEach(async () => {
    for (const p of spawned) {
      try {
        await mgr.stop(p.agent_id);
      } catch {
        /* ignore */
      }
    }
    spawned.length = 0;
  });

  it("spawns under bun-pty with /bin/cat as a stand-in", async () => {
    const agent = mkAgent({ id: "pty-spawn" });
    const proc = await mgr.spawnAgent(agent, "discord");
    spawned.push(proc);
    expect(proc.supervision).toBe("pty-stdin");
    expect(proc.pid).toBeGreaterThan(0);
  });

  it("propagates CCAW_AGENT_ID and CCAW_BUS_SOCK via the env", async () => {
    // We can't introspect a foreign process's env directly, but we can
    // capture stdout from /bin/cat after writing a sentinel — that proves
    // the PTY is wired up. Env propagation is exercised separately via
    // the `process-stream-json` test, which can read the env back through
    // `/usr/bin/env`.
    const agent = mkAgent({ id: "pty-env" });
    const proc = await mgr.spawnAgent(agent, "discord");
    spawned.push(proc);
    // Write a sentinel and read it back through the data channel.
    let received = "";
    proc.onData((chunk) => {
      received += chunk;
    });
    await proc.send_slash("compact");
    await waitFor(() => received.includes("/compact"));
    expect(received).toContain("/compact");
  });

  it("send_prompt_stream is rejected in pty-stdin mode", async () => {
    const agent = mkAgent({ id: "pty-noprompt" });
    const proc = await mgr.spawnAgent(agent, "discord");
    spawned.push(proc);
    await expect(proc.send_prompt_stream('{"type":"user","content":"hi"}')).rejects.toThrow(
      /invalid for supervision=pty-stdin/,
    );
  });

  it("emits onExit after the pty exits and clears registry", async () => {
    const agent = mkAgent({ id: "pty-exit" });
    const proc = await mgr.spawnAgent(agent, "discord");
    spawned.push(proc);
    expect(mgr._list()).toContain("pty-exit");

    const stopPromise = mgr.stop("pty-exit");
    // /bin/cat doesn't honour /quit, but the kill() path inside stop()
    // (after the 2s grace window) gets it. Use a generous timeout.
    await stopPromise;
    await waitFor(() => !mgr._list().includes("pty-exit"), 5000);
    expect(mgr._list()).not.toContain("pty-exit");
  }, 10000);
});

/* ───────────────────────────────────────────────────────────────────── */
/* process-stream-json mode (Probe 0.6)                                  */
/* ───────────────────────────────────────────────────────────────────── */

describe("process-stream-json supervision", () => {
  let mgr: SessionManager;
  const spawned: AgentProcess[] = [];

  beforeEach(() => {
    mgr = new SessionManager({
      commandOverride: "/bin/cat",
      argsOverride: [],
      busSocketPath: "/tmp/test-bus.sock",
    });
  });

  afterEach(async () => {
    for (const p of spawned) {
      try {
        await mgr.stop(p.agent_id);
      } catch {
        /* ignore */
      }
    }
    spawned.length = 0;
  });

  it("defaults to process-stream-json for cron origin", async () => {
    const agent = mkAgent({ id: "psj-default" });
    const proc = await mgr.spawnAgent(agent, "cron");
    spawned.push(proc);
    expect(proc.supervision).toBe("process-stream-json");
  });

  it("accepts JSON-line stdin and crash-data observer sees it via /bin/cat echo", async () => {
    const agent = mkAgent({ id: "psj-stream" });
    const proc = await mgr.spawnAgent(agent, "cron");
    spawned.push(proc);
    let captured = "";
    proc.onData((chunk) => {
      captured += chunk;
    });
    const turn = JSON.stringify({ type: "user", content: "hi" });
    await proc.send_prompt_stream(turn);
    await waitFor(() => captured.includes('"content":"hi"'));
    expect(captured).toContain(turn);
  });

  it("slash commands are written to stdin (Probe 0.6 Q5)", async () => {
    const agent = mkAgent({ id: "psj-slash" });
    const proc = await mgr.spawnAgent(agent, "cron");
    spawned.push(proc);
    let captured = "";
    proc.onData((chunk) => {
      captured += chunk;
    });
    await proc.send_slash("compact");
    await waitFor(() => captured.includes("/compact"));
    expect(captured).toContain("/compact\n");
  });

  it("propagates CCAW_AGENT_ID and CCAW_BUS_SOCK to child env", async () => {
    // Use `/usr/bin/env` (no args) to introspect the child env.
    const localMgr = new SessionManager({
      commandOverride: "/usr/bin/env",
      argsOverride: [],
      busSocketPath: "/tmp/test-bus-env.sock",
    });
    const agent = mkAgent({ id: "psj-env-prop" });
    const proc = await localMgr.spawnAgent(agent, "cron");
    let captured = "";
    proc.onData((chunk) => {
      captured += chunk;
    });
    // `env` exits immediately after dumping the environment.
    await waitForExit(proc, 5000);
    expect(captured).toContain("CCAW_AGENT_ID=psj-env-prop");
    expect(captured).toContain("CCAW_BUS_SOCK=/tmp/test-bus-env.sock");
  });

  it("stop() emits onExit AFTER process exit, not before (Spike 0.5)", async () => {
    const agent = mkAgent({ id: "psj-stop-order" });
    const proc = await mgr.spawnAgent(agent, "cron");
    spawned.push(proc);

    const events: string[] = [];
    proc.onExit(() => events.push("exit"));

    // Track the order: stop() must observe process exit before resolving.
    const stopPromise = mgr.stop("psj-stop-order").then(() => {
      events.push("stop-resolved");
    });
    await stopPromise;
    // Allow the exit handler to fire if it hasn't already.
    await waitFor(() => events.includes("exit"), 5000);
    // `exit` must be observed at or before stop-resolved.
    const exitIdx = events.indexOf("exit");
    const stopIdx = events.indexOf("stop-resolved");
    expect(exitIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(exitIdx).toBeLessThanOrEqual(stopIdx);
  }, 10000);
});

/* ───────────────────────────────────────────────────────────────────── */
/* Registry + restart                                                    */
/* ───────────────────────────────────────────────────────────────────── */

describe("SessionManager registry + restart", () => {
  let mgr: SessionManager;
  const spawned: AgentProcess[] = [];

  beforeEach(() => {
    mgr = new SessionManager({
      commandOverride: "/bin/cat",
      argsOverride: [],
      busSocketPath: "/tmp/test-bus.sock",
    });
  });

  afterEach(async () => {
    for (const p of spawned) {
      try {
        await mgr.stop(p.agent_id);
      } catch {
        /* ignore */
      }
    }
    spawned.length = 0;
  });

  it("rejects double-spawn of the same agent id", async () => {
    const agent = mkAgent({ id: "dup" });
    const a = await mgr.spawnAgent(agent, "cron");
    spawned.push(a);
    await expect(mgr.spawnAgent(agent, "cron")).rejects.toThrow(/already spawned/);
  });

  it("health() reports alive=true while the proc is running", async () => {
    const agent = mkAgent({ id: "health-alive" });
    const proc = await mgr.spawnAgent(agent, "cron");
    spawned.push(proc);
    const h = mgr.health();
    const entry = h["health-alive"];
    expect(entry).toBeDefined();
    expect(entry?.alive).toBe(true);
    // jsonl_recent is stubbed to true in Sprint 1
    expect(entry?.jsonl_recent).toBe(true);
  });

  it("restart() preserves the agent slot", async () => {
    const agent = mkAgent({ id: "restart-me" });
    const a = await mgr.spawnAgent(agent, "cron");
    const oldPid = a.pid;
    const b = await mgr.restart("restart-me");
    spawned.push(b);
    expect(b.agent_id).toBe("restart-me");
    expect(b.pid).not.toBe(oldPid);
    expect(mgr._list()).toContain("restart-me");
  }, 15000);

  it("rejects restart of unknown agent", async () => {
    await expect(mgr.restart("nope")).rejects.toThrow(/unknown agent/);
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* Path-length validation (Spike 0.3, UDS_PATH_MAX_BYTES)                */
/* ───────────────────────────────────────────────────────────────────── */

describe("bus socket path validation", () => {
  it("rejects bus socket paths over the 96-byte cap", async () => {
    const tooLong = `/tmp/${"x".repeat(120)}.sock`;
    const mgr = new SessionManager({
      commandOverride: "/bin/cat",
      argsOverride: [],
      busSocketPath: tooLong,
    });
    const agent = mkAgent({ id: "path-too-long" });
    await expect(mgr.spawnAgent(agent, "cron")).rejects.toThrow(/96-byte cap/);
  });
});
