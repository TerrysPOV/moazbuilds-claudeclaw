/**
 * Bus runtime scheduler wiring (Sprint 5.2c).
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.6 + §10
 * Sprint 5.2.
 *
 * Responsibility: given a parsed `Settings` + the list of cron jobs +
 * a default agent_id, construct a `BusScheduler` and register every
 * heartbeat / cron trigger against it. Returns a teardown handle the
 * daemon's `BusRuntimeHandle` can adopt via `attachScheduler`.
 *
 * Mapping from legacy config:
 *   - `settings.heartbeat.enabled === true` → one `scheduleHeartbeat`
 *     call against the default agent_id. The legacy heartbeat ran a
 *     single global session so "first agent" matches that behaviour.
 *   - Each `Job` from `loadJobs()` → one `scheduleCron` call. Jobs with
 *     `enabled: false` are skipped (legacy parity).
 *     - `job.agent` overrides the default agent_id when set; otherwise
 *       the default applies.
 *     - The job's `prompt` is forwarded verbatim — model / timeout
 *       overrides aren't honoured under the Bus runtime yet (Sprint
 *       5.2c+ follow-up).
 *
 * Not handled (deliberately):
 *   - `settings.heartbeat.excludeWindows` — the BusScheduler doesn't
 *     model exclusion windows. The legacy `isHeartbeatExcludedNow`
 *     check lives in `start.ts`'s tick(); we'd need to add a
 *     scheduler-side filter for the Bus path. Tracked for Sprint
 *     5.2c+ follow-up; for now operators using exclusion windows stay
 *     on `runtime: pty`.
 *   - Hot-reload on settings change. The schedule survives until
 *     daemon restart.
 */

import type { BusCore } from "./core";
import { createBusScheduler, type BusScheduler, type ScheduledTrigger } from "./scheduler";
import type { HeartbeatConfig } from "../config";
import type { Job } from "../jobs";

export interface ScheduledItem {
  /** Stable label for logging — e.g. `"heartbeat"` or `"cron:auto-commit"`. */
  label: string;
  trigger: ScheduledTrigger;
}

export interface BusSchedulerHandle {
  scheduler: BusScheduler;
  scheduled: readonly ScheduledItem[];
  /** Cancel every trigger + stop the scheduler. Idempotent. */
  stop(): Promise<void>;
}

export interface WireBusSchedulerOptions {
  bus: BusCore;
  /**
   * The agent_id that catches heartbeats and any job without an explicit
   * `agent` field. Caller should pass the first spawned agent (matches
   * the legacy single-global-agent shape).
   *
   * If `null`, heartbeats are skipped entirely and only jobs WITH an
   * explicit `agent` field are scheduled.
   */
  defaultAgentId: string | null;
  heartbeat: HeartbeatConfig;
  jobs: readonly Job[];
  /** Mirrors `BusSchedulerOptions.timezoneOffsetMinutes`. */
  timezoneOffsetMinutes?: number;
  /** Logger — defaults to `console`. */
  logger?: Pick<Console, "warn" | "info" | "error">;
}

/**
 * Construct a `BusScheduler`, register heartbeat + cron triggers, and
 * return a teardown handle.
 *
 * Failure semantics: per-trigger registration errors (e.g. invalid cron
 * expression) are logged via `logger.warn` and the offending trigger is
 * skipped. The scheduler itself stays alive and the rest of the
 * triggers proceed — matches the operator-friendly "fall back
 * gracefully" pattern.
 */
export async function wireBusScheduler(opts: WireBusSchedulerOptions): Promise<BusSchedulerHandle> {
  const logger = opts.logger ?? console;
  const scheduler = createBusScheduler({
    bus: opts.bus,
    timezoneOffsetMinutes: opts.timezoneOffsetMinutes ?? 0,
  });
  await scheduler.start();

  const scheduled: ScheduledItem[] = [];

  // Heartbeat: one trigger per daemon when enabled.
  if (opts.heartbeat.enabled && opts.defaultAgentId) {
    if (opts.heartbeat.excludeWindows.length > 0) {
      // Documented limitation — operators relying on this stay on
      // `runtime: pty` until the scheduler grows exclusion-window
      // support.
      logger.warn(
        "[bus-scheduler] settings.heartbeat.excludeWindows is set but the Bus scheduler doesn't honour it yet. The heartbeat will fire every interval regardless of windowing.",
      );
    }
    try {
      const trigger = scheduler.scheduleHeartbeat({
        agent_id: opts.defaultAgentId,
        interval_minutes: opts.heartbeat.interval,
        prompt: opts.heartbeat.prompt,
      });
      scheduled.push({ label: "heartbeat", trigger });
      logger.info(
        `[bus-scheduler] heartbeat scheduled every ${opts.heartbeat.interval}m for agent="${opts.defaultAgentId}"`,
      );
    } catch (err) {
      logger.warn(
        `[bus-scheduler] heartbeat schedule failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (opts.heartbeat.enabled && !opts.defaultAgentId) {
    logger.warn(
      "[bus-scheduler] settings.heartbeat.enabled is true but no agent is configured under settings.agents — heartbeat skipped",
    );
  }

  // Cron jobs.
  for (const job of opts.jobs) {
    if (job.enabled === false) continue;
    const agentId = job.agent ?? opts.defaultAgentId;
    if (!agentId) {
      logger.warn(
        `[bus-scheduler] job "${job.name}" has no explicit agent and no defaultAgentId; skipping`,
      );
      continue;
    }
    try {
      const trigger = scheduler.scheduleCron({
        agent_id: agentId,
        cronExpr: job.schedule,
        prompt: job.prompt,
        metadata: { job_name: job.name },
      });
      scheduled.push({ label: `cron:${job.name}`, trigger });
      logger.info(
        `[bus-scheduler] cron job "${job.name}" scheduled "${job.schedule}" for agent="${agentId}"`,
      );
    } catch (err) {
      logger.warn(
        `[bus-scheduler] cron job "${job.name}" failed to schedule: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let stopped = false;
  return {
    scheduler,
    get scheduled() {
      return scheduled.slice();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      // Cancel individual triggers first so the scheduler.stop() loop
      // doesn't race with our snapshot.
      for (const item of scheduled) {
        try {
          item.trigger.cancel();
        } catch (err) {
          logger.error(`[bus-scheduler] trigger.cancel(${item.label}) failed`, err);
        }
      }
      try {
        await scheduler.stop();
      } catch (err) {
        logger.error("[bus-scheduler] scheduler.stop() failed", err);
      }
    },
  };
}
