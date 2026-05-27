/**
 * Issue #165 — the bus spawn path must synthesize a per-agent
 * `--mcp-config` for `mcp.shared` servers (the legacy PTY supervisor
 * already does; the bus's own `buildClaudeArgs` never did).
 *
 * Two layers of coverage:
 *   1. `synthesizeBusMcpConfig` (pure): precedence + dormancy + the
 *      synthesized JSON shape (shared servers, bridge URLs, identity
 *      headers).
 *   2. `SessionManager.spawnAgent` integration: the synthesized
 *      `--mcp-config <path>` actually lands in the spawned process's argv
 *      (graceful-degradation + regression branches included), and
 *      `stop()` revokes the identity + deletes the 0600 config file.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PtyIdentity } from "../../runner/pty-mcp-config-writer";
import { configPathFor } from "../../runner/pty-mcp-config-writer";
import {
  type BusMcpConfigSynthesizer,
  SessionManager,
  synthesizeBusMcpConfig,
} from "../session-manager";
import type { AgentConfig } from "../types";

function makeSynth(overrides: Partial<BusMcpConfigSynthesizer> = {}): {
  synth: BusMcpConfigSynthesizer;
  issued: string[];
  revoked: string[];
} {
  const issued: string[] = [];
  const revoked: string[] = [];
  const synth: BusMcpConfigSynthesizer = {
    sharedServers: ["alpha", "beta"],
    bridgeBaseUrl: () => "http://127.0.0.1:4632",
    issue: (ptyId): PtyIdentity => {
      issued.push(ptyId);
      return {
        ptyId,
        issuedAt: 1234,
        headers: {
          Authorization: `Bearer secret-${ptyId}`,
          "X-Claudeclaw-Pty-Id": ptyId,
          "X-Claudeclaw-Ts": "1234",
        },
      };
    },
    revoke: (ptyId) => {
      revoked.push(ptyId);
    },
    ...overrides,
  };
  return { synth, issued, revoked };
}

function agentCfg(id: string, cwd: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id,
    cwd,
    session_id: `sess-${id}`,
    permission_mode: "bypassPermissions",
    ...overrides,
  };
}

describe("synthesizeBusMcpConfig (issue #165)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "ccaw-synth-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns undefined and writes nothing when the agent has a static mcp_config", () => {
    const { synth, issued } = makeSynth();
    const out = synthesizeBusMcpConfig(
      agentCfg("a", cwd, { mcp_config: "/operator/mcp.json" }),
      synth,
      cwd,
    );
    expect(out).toBeUndefined();
    expect(issued).toEqual([]); // operator's static config wins; no identity minted
    expect(existsSync(configPathFor(cwd, "a"))).toBe(false);
  });

  it("returns undefined when no synthesizer is wired (dormant multiplexer)", () => {
    const out = synthesizeBusMcpConfig(agentCfg("a", cwd), null, cwd);
    expect(out).toBeUndefined();
    expect(existsSync(configPathFor(cwd, "a"))).toBe(false);
  });

  it("returns undefined when there are zero shared servers", () => {
    const { synth, issued } = makeSynth({ sharedServers: [] });
    const out = synthesizeBusMcpConfig(agentCfg("a", cwd), synth, cwd);
    expect(out).toBeUndefined();
    expect(issued).toEqual([]);
    expect(existsSync(configPathFor(cwd, "a"))).toBe(false);
  });

  it("writes a per-agent config listing the shared servers with bridge URLs + identity headers", () => {
    const { synth, issued } = makeSynth();
    const out = synthesizeBusMcpConfig(agentCfg("triage", cwd), synth, cwd);

    expect(out).toBe(configPathFor(cwd, "triage"));
    expect(issued).toEqual(["triage"]); // keyed on the STABLE agent id
    const json = JSON.parse(readFileSync(out as string, "utf8"));
    expect(Object.keys(json.mcpServers).sort()).toEqual(["alpha", "beta"]);
    expect(json.mcpServers.alpha).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:4632/mcp/alpha",
      headers: {
        Authorization: "Bearer secret-triage",
        "X-Claudeclaw-Pty-Id": "triage",
      },
    });
    expect(json.mcpServers.beta.url).toBe("http://127.0.0.1:4632/mcp/beta");
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* Spawn integration: the synthesized flag lands in the child's argv.     */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * A stand-in for `claude` that records the argv it was launched with into
 * `<cwd>/argv.txt`, then blocks on stdin so the PTY stays alive (mirrors a
 * live REPL). `claude`'s flags are harmless to it — it ignores everything
 * but recording them, which is exactly what we assert against.
 */
function writeArgvRecorder(dir: string): string {
  const path = join(dir, "argv-recorder.sh");
  writeFileSync(path, '#!/bin/sh\nprintf "%s\\n" "$@" > "$(pwd)/argv.txt"\ncat >/dev/null\n', {
    mode: 0o755,
  });
  chmodSync(path, 0o755);
  return path;
}

async function readArgvWhenReady(dir: string, timeoutMs = 8000): Promise<string[]> {
  const path = join(dir, "argv.txt");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      if (lines.length > 0) return lines;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`argv recorder never wrote ${path}`);
}

describe("SessionManager spawn → synthesized --mcp-config in argv (issue #165)", () => {
  let cwd: string;
  let mgr: SessionManager;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "ccaw-spawn-"));
  });
  afterEach(async () => {
    try {
      await mgr?.stop("a");
    } catch {
      /* ignore */
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  it("appends --mcp-config <synth path> when the multiplexer synthesizer is active", async () => {
    const recorder = writeArgvRecorder(cwd);
    const { synth, issued } = makeSynth();
    mgr = new SessionManager({ commandOverride: recorder, sessionCollisionDetectMs: 0 });
    mgr.setMcpConfigSynthesizer(synth);

    await mgr.spawnAgent(agentCfg("a", cwd, { supervision: "pty-stdin" }), "cli");
    const argv = await readArgvWhenReady(cwd);

    const idx = argv.indexOf("--mcp-config");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe(configPathFor(cwd, "a"));
    expect(issued).toEqual(["a"]);
    expect(existsSync(configPathFor(cwd, "a"))).toBe(true);
  });

  it("graceful degradation: no synthesizer wired → no --mcp-config", async () => {
    const recorder = writeArgvRecorder(cwd);
    mgr = new SessionManager({ commandOverride: recorder, sessionCollisionDetectMs: 0 });
    // No setMcpConfigSynthesizer call — multiplexer dormant / inactive.

    await mgr.spawnAgent(agentCfg("a", cwd, { supervision: "pty-stdin" }), "cli");
    const argv = await readArgvWhenReady(cwd);

    expect(argv).not.toContain("--mcp-config");
    expect(existsSync(configPathFor(cwd, "a"))).toBe(false);
  });

  it("regression: synthesizer with zero shared servers → no --mcp-config (byte-identical to dormant)", async () => {
    const recorder = writeArgvRecorder(cwd);
    const { synth } = makeSynth({ sharedServers: [] });
    mgr = new SessionManager({ commandOverride: recorder, sessionCollisionDetectMs: 0 });
    mgr.setMcpConfigSynthesizer(synth);

    await mgr.spawnAgent(agentCfg("a", cwd, { supervision: "pty-stdin" }), "cli");
    const argv = await readArgvWhenReady(cwd);

    expect(argv).not.toContain("--mcp-config");
    expect(existsSync(configPathFor(cwd, "a"))).toBe(false);
  });

  it("stop() revokes the identity and deletes the synthesized config file", async () => {
    const recorder = writeArgvRecorder(cwd);
    const { synth, revoked } = makeSynth();
    mgr = new SessionManager({ commandOverride: recorder, sessionCollisionDetectMs: 0 });
    mgr.setMcpConfigSynthesizer(synth);

    await mgr.spawnAgent(agentCfg("a", cwd, { supervision: "pty-stdin" }), "cli");
    await readArgvWhenReady(cwd);
    expect(existsSync(configPathFor(cwd, "a"))).toBe(true);

    await mgr.stop("a");

    expect(existsSync(configPathFor(cwd, "a"))).toBe(false);
    // revoke is fire-and-forget on a microtask; let it settle.
    await new Promise((r) => setTimeout(r, 25));
    expect(revoked).toEqual(["a"]);
  });
});
