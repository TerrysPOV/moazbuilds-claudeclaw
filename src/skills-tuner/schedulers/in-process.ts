/**
 * InProcessBackend — pure-runtime scheduler used as a universal fallback.
 *
 * Runs jobs via setInterval/setTimeout inside the tuner process. Survives
 * only as long as the tuner does — restart loses all jobs. Suitable for:
 *   - Containers / serverless deployments with no host scheduler
 *   - Development environments
 *   - Test fixtures
 *
 * NOT suitable for production setups where jobs must outlive the process —
 * use SystemdUserBackend or CrontabPosixBackend instead.
 *
 * Persistence: jobs are mirrored to a JSON file at
 * `~/.config/tuner/in-process-jobs.json` so a subsequent process can rehydrate
 * them. Rehydration is the caller's responsibility (call `rehydrate()` at
 * startup); we deliberately do NOT auto-run jobs on import to keep test
 * isolation simple.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import {
  type SchedulerBackend,
  type JobSpec,
  type ScheduledJob,
  type RenderedArtifacts,
  BackendError,
  validateJobName,
  validateJobCommand,
} from "./base.js";

interface PersistedJob {
  name: string;
  description: string;
  schedule: string;
  command: string;
  createdAt: string;
}

interface ActiveJob extends PersistedJob {
  timer: ReturnType<typeof setInterval> | null;
  status: "active" | "inactive" | "failed";
  lastError?: string;
}

const STATE_FILE = join(homedir(), ".config", "tuner", "in-process-jobs.json");

export class InProcessBackend implements SchedulerBackend {
  readonly name = "in-process" as const;
  private jobs = new Map<string, ActiveJob>();

  // ── SchedulerBackend ───────────────────────────────────────────────────

  async detect(): Promise<boolean> {
    // Always available — that's the point of this backend.
    return true;
  }

  gitRepoPath(): string | null {
    // In-process state isn't a meaningful git artifact: the durable record is
    // the persistence file, but versioning every interval tweak as a commit
    // would be noisy. Return null and let the engine route around it.
    return null;
  }

  async list(): Promise<ScheduledJob[]> {
    return [...this.jobs.values()].map((j) => ({
      name: j.name,
      schedule: j.schedule,
      command: j.command,
      status: j.status,
      artifactPath: null,
    }));
  }

  render(spec: JobSpec): RenderedArtifacts {
    return {
      files: {},
      summary: `in-process: ${spec.name} every ${this.describeInterval(spec.schedule)}`,
    };
  }

  async create(spec: JobSpec): Promise<{ artifactPath: string | null }> {
    validateJobName(spec.name);
    validateJobCommand(spec.command);
    if (this.jobs.has(spec.name)) {
      throw new BackendError(`job already exists: ${spec.name}`, false);
    }
    const intervalMs = this.parseScheduleToMs(spec.schedule);
    const persisted: PersistedJob = {
      name: spec.name,
      description: spec.description,
      schedule: spec.schedule,
      command: spec.command,
      createdAt: new Date().toISOString(),
    };
    const job: ActiveJob = { ...persisted, timer: null, status: "inactive" };
    this.jobs.set(spec.name, job);
    this.startJob(job, intervalMs);
    this.persistState();
    return { artifactPath: null };
  }

  async remove(name: string): Promise<void> {
    const job = this.jobs.get(name);
    if (!job) {
      // Idempotent: not present is not an error.
      return;
    }
    if (job.timer) clearInterval(job.timer);
    this.jobs.delete(name);
    this.persistState();
  }

  // ── Public helpers (not on the interface) ──────────────────────────────

  /** Load persisted jobs from disk and restart their timers. Call at process startup. */
  rehydrate(): { rehydrated: number } {
    if (!existsSync(STATE_FILE)) return { rehydrated: 0 };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    } catch {
      // Corrupt state file — refuse to silently lose jobs. Caller can rm if intended.
      throw new BackendError(`corrupt in-process state file: ${STATE_FILE}`, true);
    }
    if (!Array.isArray(parsed)) {
      throw new BackendError(
        `in-process state file is not a JSON array: ${STATE_FILE} (got ${typeof parsed})`,
        true,
      );
    }
    const persistedJobs = parsed as PersistedJob[];
    let count = 0;
    for (const p of persistedJobs) {
      if (this.jobs.has(p.name)) continue;
      const intervalMs = this.parseScheduleToMs(p.schedule);
      const job: ActiveJob = { ...p, timer: null, status: "inactive" };
      this.jobs.set(p.name, job);
      this.startJob(job, intervalMs);
      count++;
    }
    return { rehydrated: count };
  }

  /** Stop all timers. Call before process exit to release event-loop refs. */
  shutdown(): void {
    for (const job of this.jobs.values()) {
      if (job.timer) clearInterval(job.timer);
      job.timer = null;
      job.status = "inactive";
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private startJob(job: ActiveJob, intervalMs: number): void {
    const exec = () => {
      const child = spawn("/bin/sh", ["-c", job.command], { stdio: "ignore" });
      child.on("error", (err) => {
        job.status = "failed";
        job.lastError = err.message.slice(0, 200);
      });
      child.on("exit", (code) => {
        job.status = code === 0 ? "active" : "failed";
        if (code !== 0) job.lastError = `exit ${code}`;
      });
    };
    job.timer = setInterval(exec, intervalMs);
    // Don't keep the event loop alive solely for in-process jobs.
    job.timer.unref?.();
    job.status = "active";
  }

  private persistState(): void {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    const snapshot: PersistedJob[] = [...this.jobs.values()].map((j) => ({
      name: j.name,
      description: j.description,
      schedule: j.schedule,
      command: j.command,
      createdAt: j.createdAt,
    }));
    writeFileSync(STATE_FILE, JSON.stringify(snapshot, null, 2), "utf8");
  }

  /**
   * Best-effort schedule parsing. Recognizes:
   *   - 5-field POSIX cron with `* / N` in the minute field → N minutes
   *   - 5-field POSIX cron with explicit minute + hourly defaults → 1 hour
   *   - systemd `*:0/N` → N minutes
   *   - systemd `OnUnitActiveSec=N` style (e.g. `15min`, `2h`) → that interval
   *
   * For schedules we can't reduce to a fixed interval (calendar dates,
   * weekday restrictions, etc.), default to hourly and emit a console warn —
   * the operator will see the next-tick mismatch and switch to systemd/crontab.
   */
  private parseScheduleToMs(schedule: string): number {
    const trimmed = schedule.trim();

    // systemd-style "*:0/N"
    const systemdInterval = trimmed.match(/^\*:0\/(\d+)$/);
    if (systemdInterval) return parseInt(systemdInterval[1]!, 10) * 60_000;

    // systemd OnUnitActiveSec-style "15min" or "2h"
    const durMatch = trimmed.match(/^(\d+)\s*(s|sec|m|min|h|hr|d)$/i);
    if (durMatch) {
      const n = parseInt(durMatch[1]!, 10);
      const unit = durMatch[2]!.toLowerCase();
      if (unit.startsWith("s")) return n * 1000;
      if (unit.startsWith("m")) return n * 60_000;
      if (unit.startsWith("h")) return n * 3_600_000;
      if (unit.startsWith("d")) return n * 86_400_000;
    }

    // POSIX cron 5 fields
    const fields = trimmed.split(/\s+/);
    if (fields.length === 5) {
      const minute = fields[0]!;
      const everyNMin = minute.match(/^\*\/(\d+)$/);
      if (everyNMin) return parseInt(everyNMin[1]!, 10) * 60_000;
      // Anything else with a literal minute defaults to hourly (best-effort).
      if (/^\d+$/.test(minute) && fields[1] === "*") return 3_600_000;
    }

    throw new BackendError(
      `InProcessBackend cannot derive a fixed interval from schedule ${JSON.stringify(schedule)}. Calendar-based schedules (specific weekdays, dates) need a systemd or crontab backend. Set WISECRON_BACKEND=systemd-user or crontab-posix on a host that supports them.`,
      false,
    );
  }

  /**
   * Best-effort interval description for render(). MUST NOT throw — render()
   * is the dry-run path and operators expect it to be pure. parseScheduleToMs
   * throws on calendar-only schedules; we catch and report "unsupported" here.
   */
  private describeInterval(schedule: string): string {
    let ms: number;
    try {
      ms = this.parseScheduleToMs(schedule);
    } catch {
      return "unsupported interval (calendar-only schedule)";
    }
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
    return `${Math.round(ms / 86_400_000)}d`;
  }
}
