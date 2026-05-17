/**
 * Schema-probe types — extracted so `schema-probe.ts` and
 * `schema-probe-runner.ts` can share them without a circular import.
 */

export interface ProbeRunner {
  /** Write a prompt to the session (followed by Enter). */
  sendPrompt(text: string): Promise<void>;
  /** Send a slash command (no leading slash; runner adds CR). */
  sendSlash(cmd: string): Promise<void>;
  /** Wait for process exit (timeout returns `false`). */
  waitForExit(timeoutMs: number): Promise<boolean>;
  /** Hard kill if still alive. */
  kill(): void;
}

export interface ProbeRunnerSpawnArgs {
  cwd: string;
  sessionId: string;
  claudeBin: string;
}

export type ProbeRunnerFactory = (args: ProbeRunnerSpawnArgs) => Promise<ProbeRunner>;
