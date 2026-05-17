/**
 * ClaudeClaw+ Bus runtime — Session Manager.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.3
 *
 * Responsibility: spawn + supervise one `claude` process per Plus agent.
 * Picks a `SupervisionMode` based on origin (channel-driven origins need the
 * PTY-backed REPL; non-channel origins use the lighter `process-stream-json`
 * runner). Provides a stable per-agent handle (`AgentProcess`) with
 * lifecycle methods and slash-command relay.
 *
 * Empirical foundations:
 * - Spike 0.4 — `claude` gates the REPL on `process.stdin.isTTY` AND
 *   `process.stdout.isTTY`. Plain `Bun.spawn({stdin:'pipe'})` downshifts
 *   to `--print` mode within ~3 s, so channel-driven agents must use
 *   `bun-pty`.
 * - Spike 0.5 — JSONL carries no top-level `session.end` marker; process
 *   exit IS the authoritative end signal. `/quit` is `/exit` under the
 *   hood. macOS `/tmp` is a symlink to `/private/tmp` — encoded JSONL
 *   paths must use realpath.
 * - Spike 0.6 — `claude -p --input-format=stream-json` supports long-lived
 *   multi-turn AND slash commands, but silently drops
 *   `notifications/claude/channel` (the entire reason the Bus exists).
 *   Use it only for non-channel origins.
 *
 * Helper classes (`PtyAgentProcess`, `ChildAgentProcess`) live in
 * `session-agent-process.ts` to keep this file under the 500-LOC budget.
 */

import { spawn as nodeSpawnChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanSpawnEnv } from "../runner";
import {
  type AgentProcess,
  ChildAgentProcess,
  type DataHandler,
  type ExitHandler,
  PtyAgentProcess,
  type PtyHandle,
} from "./session-agent-process";
import {
  type AgentConfig,
  type BusOrigin,
  defaultSupervisionFor,
  type SupervisionMode,
  UDS_PATH_MAX_BYTES,
} from "./types";

/* ───────────────────────────────────────────────────────────────────── */
/* Public surface                                                        */
/* ───────────────────────────────────────────────────────────────────── */

export type { AgentProcess, DataHandler, ExitHandler };

export interface AgentHealth {
  alive: boolean;
  jsonl_recent: boolean;
}

export interface SessionManagerOptions {
  /**
   * Test seam: override the spawned executable (default `"claude"`). The same
   * trick is used by `src/runner/pty-process.ts` so unit tests can swap in
   * `/bin/cat`, `/bin/sh`, etc.
   */
  commandOverride?: string;
  /**
   * Test seam: when set, replaces the claude args list entirely. Used by
   * tests that swap `command` for a stand-in (e.g. `/bin/cat`) which doesn't
   * accept claude's flags.
   */
  argsOverride?: string[];
  /**
   * Test seam: override the IPC socket env propagated to children. When unset
   * we read `CCAW_BUS_SOCK` from the daemon env or fall back to the spec
   * default path (`${XDG_RUNTIME_DIR ?? $HOME/.claudeclaw/run}/bus.sock`).
   */
  busSocketPath?: string;
}

/* ───────────────────────────────────────────────────────────────────── */
/* Helpers                                                               */
/* ───────────────────────────────────────────────────────────────────── */

function resolveBusSocketPath(override?: string): string {
  if (override) return override;
  const fromEnv = process.env.CCAW_BUS_SOCK;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const runtimeDir =
    process.env.XDG_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR.length > 0
      ? process.env.XDG_RUNTIME_DIR
      : join(homedir(), ".claudeclaw", "run");
  return join(runtimeDir, "bus.sock");
}

/**
 * Resolve `agent.cwd` through realpath to defeat the macOS `/tmp` →
 * `/private/tmp` symlink. The encoded JSONL path under `~/.claude/projects/`
 * uses the realpath as the dir name — naive `cwd` without realpath causes
 * the Sprint 2 tailer to miss the file (Spike 0.5).
 */
export function resolveAgentCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    // cwd may not exist yet (test/setup races); fall back to input.
    return cwd;
  }
}

/**
 * Build the env passed to the spawned child. Reuses `cleanSpawnEnv()` from
 * `src/runner.ts` (the canonical strip-list — DO NOT duplicate, see PR #104
 * for the long-lived `sk-ant-oat01-*` exception).
 */
function buildChildEnv(agent: AgentConfig, busSocketPath: string): Record<string, string> {
  const env = cleanSpawnEnv();
  env.CCAW_AGENT_ID = agent.id;
  env.CCAW_BUS_SOCK = busSocketPath;
  // TCP fallback wiring is a stub in Sprint 1 — values flow through if the
  // daemon set them but we do not synthesise them here.
  if (process.env.CCAW_BUS_PORT) env.CCAW_BUS_PORT = process.env.CCAW_BUS_PORT;
  if (process.env.CCAW_BUS_TOKEN) env.CCAW_BUS_TOKEN = process.env.CCAW_BUS_TOKEN;
  return env;
}

/**
 * Build the args list passed to the spawned `claude`. Mirrors §5.3 sample.
 */
function buildClaudeArgs(agent: AgentConfig, mode: SupervisionMode): string[] {
  const args: string[] = [];
  if (mode === "process-stream-json") {
    args.push("-p", "--input-format=stream-json", "--output-format=stream-json", "--verbose");
  }
  args.push("--dangerously-load-development-channels", "plugin:plus-bus@local");
  args.push("--permission-mode", agent.permission_mode ?? "plan");
  if (agent.system_prompt_file) {
    args.push("--append-system-prompt", agent.system_prompt_file);
  }
  if (agent.mcp_config) {
    args.push("--mcp-config", agent.mcp_config);
  }
  args.push("--session-id", agent.session_id);
  return args;
}

/* ───────────────────────────────────────────────────────────────────── */
/* SessionManager                                                        */
/* ───────────────────────────────────────────────────────────────────── */

interface AgentRecord {
  agent: AgentConfig;
  origin: BusOrigin;
  mode: SupervisionMode;
  proc: PtyAgentProcess | ChildAgentProcess;
}

export class SessionManager {
  private readonly options: SessionManagerOptions;
  private readonly agents = new Map<string, AgentRecord>();

  constructor(options: SessionManagerOptions = {}) {
    this.options = options;
  }

  async spawnAgent(agent: AgentConfig, origin: BusOrigin): Promise<AgentProcess> {
    if (this.agents.has(agent.id)) {
      throw new Error(`agent ${agent.id} is already spawned; call stop() or restart() first`);
    }
    const mode: SupervisionMode = agent.supervision ?? defaultSupervisionFor(origin);
    const realCwd = resolveAgentCwd(agent.cwd);
    const busSock = resolveBusSocketPath(this.options.busSocketPath);

    // Path-length validation (Spike 0.3 — UDS sun_path budget).
    if (Buffer.byteLength(busSock, "utf8") > UDS_PATH_MAX_BYTES) {
      throw new Error(
        `bus socket path exceeds ${UDS_PATH_MAX_BYTES}-byte cap: ${busSock} ` +
          `(${Buffer.byteLength(busSock, "utf8")}B)`,
      );
    }

    const env = buildChildEnv(agent, busSock);
    const args = this.options.argsOverride ?? buildClaudeArgs(agent, mode);

    let proc: PtyAgentProcess | ChildAgentProcess;
    if (mode === "pty-stdin") {
      proc = await this.spawnPty(agent, args, env, realCwd);
    } else if (mode === "process-stream-json" || mode === "process") {
      proc = this.spawnChild(agent, mode, args, env, realCwd);
    } else if (mode === "tmux") {
      proc = this.spawnTmux(agent, args, env, realCwd);
    } else {
      throw new Error(`unsupported supervision mode: ${mode satisfies never}`);
    }

    const record: AgentRecord = { agent, origin, mode, proc };
    this.agents.set(agent.id, record);
    // Auto-cleanup: drop registry entry on exit so restart() can reuse the id.
    proc.onExit(() => {
      const current = this.agents.get(agent.id);
      if (current && current.proc === proc) {
        this.agents.delete(agent.id);
      }
    });
    return proc;
  }

  private async spawnPty(
    agent: AgentConfig,
    args: string[],
    env: Record<string, string>,
    realCwd: string,
  ): Promise<PtyAgentProcess> {
    const cmd = this.options.commandOverride ?? "claude";
    // Dynamic import keeps `bun-pty` (native) out of the cold path for tests
    // that exercise non-PTY modes.
    const { spawn: ptySpawn } = (await import("bun-pty")) as {
      spawn: (
        file: string,
        argv: string[],
        opts: {
          name: string;
          cols?: number;
          rows?: number;
          cwd?: string;
          env?: Record<string, string>;
        },
      ) => PtyHandle;
    };
    // NOTE: production code paths must wrap this call in `withCleanProcessEnv`
    // (see `src/runner/pty-process.ts`) because bun-pty's Rust wrapper does
    // NOT call `env_clear()` before forking — the child inherits unsanitised
    // env from the parent process. Bus Sprint 1 inherits the daemon's
    // already-clean process.env (no API-key leakage at the daemon level),
    // but if anything sets ANTHROPIC_API_KEY in the daemon env this must be
    // upgraded. TODO(sprint-2): wire `withCleanProcessEnv` here once the
    // daemon-env story is settled.
    const pty = ptySpawn(cmd, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: realCwd,
      env,
    });
    return new PtyAgentProcess(agent.id, pty);
  }

  private spawnChild(
    agent: AgentConfig,
    mode: SupervisionMode,
    args: string[],
    env: Record<string, string>,
    realCwd: string,
  ): ChildAgentProcess {
    const cmd = this.options.commandOverride ?? "claude";
    // Use node:child_process for broad compatibility and a stable
    // `ChildProcess` interface across Bun + Node runtimes. (`Bun.spawn`
    // returns a different shape; using node:child_process avoids the
    // type-divergence between Subprocess and ChildProcess.)
    const child = nodeSpawnChildProcess(cmd, args, {
      cwd: realCwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new ChildAgentProcess(agent.id, mode, child);
  }

  private spawnTmux(
    agent: AgentConfig,
    args: string[],
    env: Record<string, string>,
    realCwd: string,
  ): ChildAgentProcess {
    // tmux mode (opt-in, spec §5.3): wrap the same args under a detached
    // tmux session. Slash commands flow via `tmux send-keys` — not stdin —
    // so this AgentProcess overrides `send_slash` indirectly through the
    // subprocess (the tmux client itself terminates immediately after `-d`).
    //
    // TODO(sprint-2): implement a TmuxAgentProcess that overrides
    // `send_slash` to shell out to `tmux send-keys -t <session> "/<cmd>"
    // Enter`. For now we return a ChildAgentProcess; send_slash will be a
    // no-op against the already-exited tmux client and reject.
    const claudeBin = this.options.commandOverride ?? "claude";
    const sessionName = `claudeclaw-${agent.id}`;
    const tmuxArgs = ["new-session", "-d", "-s", sessionName, claudeBin, ...args];
    const child = nodeSpawnChildProcess("tmux", tmuxArgs, {
      cwd: realCwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new ChildAgentProcess(agent.id, "tmux", child);
  }

  /**
   * Stop an agent. Per Spike 0.5: write `/quit` via the active supervision
   * channel; observe process exit; the caller (Bus core) publishes
   * `session.end` AFTER the process exit fires — not before.
   */
  stop(agent_id: string): Promise<void> {
    const record = this.agents.get(agent_id);
    if (!record) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finalise = (): void => {
        // Drop from registry (the onExit handler installed in spawnAgent()
        // will also do this; harmless to do twice).
        this.agents.delete(agent_id);
        resolve();
      };
      if (record.proc._isExited()) {
        finalise();
        return;
      }
      record.proc.onExit(() => {
        finalise();
      });
      // Try graceful first: /quit via the active relay channel. If that path
      // fails (closed stdin, dead PTY), fall through to SIGTERM.
      record.proc
        .send_slash("quit")
        .catch(() => {
          /* fall through to kill */
        })
        .finally(() => {
          // Belt + braces: if the process hasn't exited within a short
          // grace window after /quit, SIGTERM. We schedule this rather than
          // calling kill() immediately so a clean /quit can complete (it's
          // the recorded path that produces `<command-name>/exit</...>`
          // envelopes in the JSONL — see Spike 0.5).
          setTimeout(() => {
            if (!record.proc._isExited()) record.proc._kill();
          }, 2000).unref?.();
        });
    });
  }

  /**
   * Restart an agent. Same `session_id` (claude resumes via `--session-id`).
   */
  async restart(agent_id: string): Promise<AgentProcess> {
    const record = this.agents.get(agent_id);
    if (!record) {
      throw new Error(`cannot restart unknown agent ${agent_id}`);
    }
    const { agent, origin } = record;
    await this.stop(agent_id);
    return this.spawnAgent(agent, origin);
  }

  /**
   * Health snapshot. For each known agent: alive (process not exited) +
   * `jsonl_recent` (file mtime within heartbeat interval).
   *
   * TODO(sprint-2): wire `jsonl_recent` to the JSONL tailer. The path is
   * `~/.claude/projects/<encoded-realpath>/<sessionId>.jsonl`. For Sprint 1
   * this stubs to `true` so callers can wire against the shape without
   * blocking on the tailer.
   */
  health(): Record<string, AgentHealth> {
    const out: Record<string, AgentHealth> = {};
    for (const [id, record] of this.agents) {
      out[id] = {
        alive: !record.proc._isExited(),
        jsonl_recent: true, // Sprint 2 fills this in
      };
    }
    return out;
  }

  /** Test helper: list spawned agent_ids. Not part of the public spec. */
  _list(): string[] {
    return Array.from(this.agents.keys());
  }
}

/* ───────────────────────────────────────────────────────────────────── */
/* Re-exports for callers + tests                                        */
/* ───────────────────────────────────────────────────────────────────── */

export { defaultSupervisionFor } from "./types";
export type { AgentConfig, BusOrigin, SupervisionMode } from "./types";
