/**
 * CrontabPosixBackend — POSIX crontab.
 *
 * Works on any host with the `crontab` binary (Linux, macOS, BSD). The active
 * table itself is root-managed under `/var/spool/cron/...` and is only
 * accessible via `crontab -l/-e`, so the on-disk artifact we version lives
 * in an XDG-config sidecar at `~/.config/cron/crontab.snapshot`.
 *
 * Job identification: each managed line ends with a `# wisecron:<name>` marker
 * so list()/remove() can find their lines without parsing free-form cron
 * commands. Operators may add their own crontab entries freely — only the
 * marker-tagged lines are managed by this backend.
 *
 * Concurrency: `crontab -` is atomic from the kernel's perspective but two
 * concurrent writers will race on the user table. We accept that race for v0
 * — the tuner is single-threaded per cycle, and operators shouldn't be
 * running parallel `crontab -e` sessions anyway.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type SchedulerBackend,
  type JobSpec,
  type ScheduledJob,
  type RenderedArtifacts,
  BackendError,
  validateJobName,
  validateJobCommand,
} from "./base.js";

const SIDECAR_DIR = join(homedir(), ".config", "cron");
const SIDECAR_FILE = join(SIDECAR_DIR, "crontab.snapshot");
const MARKER_PREFIX = "# wisecron:";

export class CrontabPosixBackend implements SchedulerBackend {
  readonly name = "crontab-posix" as const;

  async detect(): Promise<boolean> {
    // `crontab -l` exits 0 with content, exits 1 with "no crontab for ..." when
    // the user has no entries yet. Both mean the binary works — we just need
    // to know spawnSync can find it.
    const which = spawnSync("which", ["crontab"], { stdio: ["ignore", "pipe", "pipe"], timeout: 500 });
    return which.status === 0;
  }

  gitRepoPath(): string {
    return SIDECAR_DIR;
  }

  async list(): Promise<ScheduledJob[]> {
    const current = this.readCrontab();
    const jobs: ScheduledJob[] = [];
    for (const line of current.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const markerMatch = trimmed.match(/\s+# wisecron:([a-z][a-z0-9-]{0,62})\s*$/);
      if (!markerMatch) continue;
      const name = markerMatch[1]!;
      // Strip the trailing marker so `command` reflects the actual shell command.
      const body = trimmed.replace(/\s+# wisecron:.+$/, "");
      const fields = body.split(/\s+/);
      if (fields.length < 6) continue;
      const schedule = fields.slice(0, 5).join(" ");
      const command = fields.slice(5).join(" ");
      jobs.push({ name, schedule, command, status: "active", artifactPath: SIDECAR_FILE });
    }
    return jobs;
  }

  render(spec: JobSpec): RenderedArtifacts {
    const line = this.formatLine(spec);
    return {
      // Key matches the write path so dry-run output corresponds to what create()
      // will produce. The fragment is the line that will be appended; render()
      // does not show the full crontab content because that would require
      // shelling out to crontab -l, which violates the pure-function contract.
      files: { "crontab.snapshot (fragment to append)": line + "\n" },
      summary: `crontab-posix: ${line}`,
    };
  }

  async create(spec: JobSpec): Promise<{ artifactPath: string | null }> {
    validateJobName(spec.name);
    validateJobCommand(spec.command);
    this.validateCronExpression(spec.schedule);

    const current = this.readCrontab();
    const marker = `${MARKER_PREFIX}${spec.name}`;
    if (new RegExp(`(^|\\s)${marker}($|\\s)`, 'm').test(current)) {
      throw new BackendError(
        `crontab already has a ${marker} entry — remove() first or rename`,
        false,
      );
    }
    const newLine = this.formatLine(spec);
    const updated =
      (current.length === 0 || current.endsWith("\n") ? current : current + "\n") + newLine + "\n";
    this.writeCrontab(updated);
    this.updateSidecar(updated);
    return { artifactPath: SIDECAR_FILE };
  }

  async remove(name: string): Promise<void> {
    validateJobName(name);
    const current = this.readCrontab();
    const marker = new RegExp(`\\s${MARKER_PREFIX}${name}\\s*$`);
    const kept = current
      .split("\n")
      .filter((line) => !marker.test(line))
      .join("\n");
    if (kept === current) return; // idempotent no-op
    this.writeCrontab(kept);
    this.updateSidecar(kept);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private formatLine(spec: JobSpec): string {
    return `${spec.schedule} ${spec.command}  ${MARKER_PREFIX}${spec.name}`;
  }

  private readCrontab(): string {
    const result = spawnSync("crontab", ["-l"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2000,
    });
    // "no crontab for <user>" prints to stderr with status 1; treat as empty.
    if (result.status !== 0) return "";
    return result.stdout.toString();
  }

  private writeCrontab(content: string): void {
    const result = spawnSync("crontab", ["-"], {
      input: content,
      encoding: "utf8",
      timeout: 2000,
    });
    if (result.status !== 0) {
      throw new BackendError(
        `crontab write failed: ${(result.stderr || "").trim().slice(0, 200) || `exit ${result.status}`}`,
        true,
      );
    }
  }

  private updateSidecar(content: string): void {
    mkdirSync(SIDECAR_DIR, { recursive: true });
    writeFileSync(SIDECAR_FILE, content, "utf8");
    // We DON'T auto-commit here — the engine's BranchManager owns commit
    // semantics for proposal applies. The sidecar is plain content; commits
    // happen at the engine layer in a uniform way.
  }

  private validateCronExpression(expr: string): void {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) {
      throw new BackendError(
        `cron expression must have 5 fields, got ${parts.length}: ${JSON.stringify(expr)}`,
        false,
      );
    }
    const fieldRe = /^[\d*,\/\-]+$/;
    for (const [i, p] of parts.entries()) {
      if (!fieldRe.test(p)) {
        throw new BackendError(`cron field ${i} invalid: ${JSON.stringify(p)}`, false);
      }
    }
  }
}

// Used by callers that prefer a function over a class.
export function readCrontabSnapshot(): string {
  const backend = new CrontabPosixBackend();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (backend as any).readCrontab() as string;
}
