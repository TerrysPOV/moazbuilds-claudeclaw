/**
 * Schema-probe runner — default `bun-pty` factory.
 *
 * Split out of `schema-probe.ts` to keep that file under the 500-LOC
 * budget AND so unit tests that inject their own `ProbeRunnerFactory`
 * never load the native PTY module.
 *
 * Why PTY (not `-p`)?
 *   - Spike 0.4: claude REPL gates on `process.stdin.isTTY` AND
 *     `process.stdout.isTTY`. Plain `Bun.spawn({stdin:'pipe'})`
 *     downshifts to `--print` mode within ~3 s.
 *   - Spike 0.6: `claude -p --input-format=stream-json` silently drops
 *     `notifications/claude/channel`. The probe MUST validate the same
 *     supervision path production uses — and production needs channels.
 */

import type { ProbeRunner, ProbeRunnerFactory } from "./schema-probe-types";

interface BunPtyHandle {
  readonly pid: number;
  onData(cb: (d: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void };
  write(d: string): void;
  kill(sig?: string): void;
}

interface BunPtyModule {
  spawn: (
    cmd: string,
    args: string[],
    opts: { cwd: string; cols?: number; rows?: number; env?: Record<string, string> },
  ) => BunPtyHandle;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const defaultPtyRunnerFactory: ProbeRunnerFactory = async ({
  cwd,
  sessionId,
  claudeBin,
}) => {
  const bunPty = (await import("bun-pty")) as BunPtyModule;

  // Match spec §5.3 / session-manager.ts:154 — load the Bus plugin into
  // claude. Probe uses the same plugin spec as production so validation
  // reflects real behaviour, not a probe-only path. Spike 0.6 confirmed
  // this flag does NOT need `-p` (and `-p` would silently drop channel
  // notifications anyway).
  const args = [
    "--dangerously-load-development-channels",
    "plugin:plus-bus@local",
    "--permission-mode",
    "plan",
    "--session-id",
    sessionId,
  ];

  const handle = bunPty.spawn(claudeBin, args, {
    cwd,
    cols: 120,
    rows: 30,
    env: { ...process.env, CI: "1" } as Record<string, string>,
  });

  let exitCode: number | null = null;
  handle.onExit((e) => {
    exitCode = e.exitCode;
  });
  // Drain onData so the master fd doesn't block. Bus does NOT parse this
  // channel — model output comes from the JSONL Tailer (spec §5.3).
  handle.onData(() => {});

  const runner: ProbeRunner = {
    sendPrompt(text) {
      handle.write(`${text}\r`);
      return Promise.resolve();
    },
    sendSlash(cmd) {
      handle.write(`/${cmd}\r`);
      return Promise.resolve();
    },
    async waitForExit(timeoutMs) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (exitCode !== null) return true;
        await sleep(50);
      }
      return false;
    },
    kill() {
      try {
        handle.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    },
  };
  return runner;
};
