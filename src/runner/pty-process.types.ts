/**
 * STUB: Phase C will replace this file with the actual implementation from
 * worktree `wt-pty-core` (engineer-pty-core). This file exists only so that
 * `pty-supervisor.ts` and its tests can compile and run in isolation while
 * engineer-pty-core is working in parallel.
 *
 * Source of truth: `.planning/pty-migration/SPEC.md` §3.1 — `src/runner/pty-process.ts`.
 *
 * Once Phase C merges the two worktrees, this stub file is deleted and the
 * imports point at engineer-pty-core's real implementation, which exports the
 * IDENTICAL types listed below (the spec freezes the surface).
 */
import type { SecurityConfig } from "../config";

export interface PtyProcessOptions {
  sessionId: string;
  newSessionId?: string;
  cwd: string;
  agentName?: string;
  modelOverride?: string;
  security: SecurityConfig;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  turnIdleTimeoutMs?: number;
}

export interface PtyTurnResult {
  text: string;
  bytesCaptured: number;
  cleanBoundary: boolean;
  sessionId: string;
}

export interface PtyProcess {
  readonly label: string;
  readonly pid: number;
  readonly sessionId: string;
  readonly cwd: string;
  isAlive(): boolean;
  lastTurnEndedAt(): number;
  runTurn(
    prompt: string,
    opts: {
      timeoutMs: number;
      onChunk?: (text: string) => void;
      onToolEvent?: (line: string) => void;
    }
  ): Promise<PtyTurnResult>;
  dispose(): Promise<void>;
}

export class PtyTurnTimeoutError extends Error {
  constructor(public readonly label: string, public readonly elapsedMs: number) {
    super(`PTY turn timed out for ${label} after ${elapsedMs}ms`);
    this.name = "PtyTurnTimeoutError";
  }
}

export class PtyClosedError extends Error {
  constructor(
    public readonly label: string,
    public readonly exitCode: number | null,
    public readonly signal: string | null,
  ) {
    super(`PTY closed during turn for ${label} (exit=${exitCode} signal=${signal})`);
    this.name = "PtyClosedError";
  }
}

/**
 * Spawn one Claude interactive PTY. The supervisor calls this; the real
 * implementation lives in `pty-process.ts` (engineer-pty-core's worktree).
 *
 * Phase B engineer-pty-supervisor never imports the runtime symbol directly —
 * it imports through `pty-supervisor.ts`'s `injectSpawnPty()` for tests, and at
 * runtime uses a small deferred-import indirection so the supervisor module
 * doesn't need engineer-pty-core's file present at compile time.
 *
 * The supervisor calls this via the spawn-injection seam (`injectSpawnPty`),
 * so we declare the signature here but provide no implementation — runtime
 * code goes through the injection seam, tests inject a fake.
 */
export type SpawnPty = (opts: PtyProcessOptions) => Promise<PtyProcess>;
