/**
 * Bus Scheduler — cron + heartbeat trigger emitter.
 *
 * Sprint 4 Agent B deliverable.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md`
 *   - §5.6 "Cron / heartbeat / scheduler" — emits prompts via
 *     `bus.sendPrompt({origin: 'cron' | 'heartbeat', user_id: 'system', …})`.
 *   - §6.4 "Heartbeat tick" — one tick = one `bus.sendPrompt` with
 *     `origin: 'heartbeat'`, `user_id: 'system'`. The hybrid auth router
 *     can later flip system traffic onto an API key (proposal §2.3 C.1);
 *     this module only needs to make sure the tag is set.
 *
 * Replaces (does NOT modify) the existing legacy primitives:
 *   - `src/cron.ts` (53 LOC, `cronMatches` / `nextCronMatch`) — re-used
 *     here for the 5-field cron expression case. Behaviour parity is the
 *     goal: same cron grammar, same in-process timer model, no
 *     persistence (restart loses scheduled jobs — matches legacy).
 *   - Heartbeat plumbing in `src/runner.ts` + `src/sessions.ts` +
 *     `src/config.ts` — those stay live for `runtime: pty`. The Bus
 *     scheduler is the equivalent surface for `runtime: bus`.
 *
 * Non-goals (deferred to later sprints, per SPRINT_4_PLAN.md):
 *   - Persistence / restart recovery.
 *   - Queue / dedupe coupling (that lives in Gateway, Sprint 3+).
 *   - Hybrid auth router routing (it just reads the `user_id: 'system'`
 *     tag this module emits).
 *
 * Drift note: `setInterval` accumulates drift over long runs (libuv
 * timers fire on monotonic clock but the JS callback is scheduled
 * relative to "now" — see Node.js docs §timers). For heartbeats at
 * minute-scale this is invisible, but the test suite exercises 100ms
 * intervals and asserts ±50ms total drift after 10 ticks, so we anchor
 * to the original `startedAt` and recompute each timeout from
 * `Date.now()` rather than blindly trusting `setInterval`'s cadence.
 */

import { randomUUID } from "node:crypto";
import { nextCronMatch } from "../cron";
import type { BusCore, SendPromptRequest } from "./core";
import type { BusOrigin } from "./types";

/* ───────────────────────────────────────────────────────────────────── */
/* Public surface                                                        */
/* ───────────────────────────────────────────────────────────────────── */

export interface ScheduledTrigger {
  /** Cancel the trigger. Idempotent. */
  cancel(): void;
}

export interface ScheduleHeartbeatRequest {
  agent_id: string;
  /** Interval in minutes. Fractional values allowed for tests (e.g. 0.001). */
  interval_minutes: number;
  prompt: string;
  metadata?: Record<string, unknown>;
}

export interface ScheduleCronRequest {
  agent_id: string;
  /**
   * Standard 5-field cron expression (`minute hour dayOfMonth month dayOfWeek`).
   * Mutually exclusive with `at`. Re-uses `src/cron.ts` semantics for
   * behaviour parity with the legacy scheduler.
   */
  cronExpr?: string;
  /** One-shot `Date`. Mutually exclusive with `cronExpr`. */
  at?: Date;
  prompt: string;
  metadata?: Record<string, unknown>;
}

export interface BusScheduler {
  /** Mostly bookkeeping. Idempotent. */
  start(): Promise<void>;
  /** Clear all pending timers. Idempotent. No events fire after this. */
  stop(): Promise<void>;
  /** Recurring heartbeat for an agent. */
  scheduleHeartbeat(req: ScheduleHeartbeatRequest): ScheduledTrigger;
  /** Cron job — either `cronExpr` (recurring) or `at` (one-shot). */
  scheduleCron(req: ScheduleCronRequest): ScheduledTrigger;
}

export interface BusSchedulerOptions {
  /** Bus core that receives `sendPrompt` calls. */
  bus: BusCore;
  /**
   * Timezone offset (minutes east of UTC) passed through to `nextCronMatch`.
   * Mirrors `src/cron.ts` semantics. Defaults to 0 (UTC).
   */
  timezoneOffsetMinutes?: number;
  /** Logger; defaults to console.error for bus consistency. */
  onError?: (err: unknown, ctx?: Record<string, unknown>) => void;
  /**
   * Test hook — override `Date.now`/`setTimeout` injection. Production
   * code never sets this; bun:test mocks `setTimeout`/`Date.now` globally
   * so the in-tree path is enough for the test suite. Left as an escape
   * hatch in case future runtime tests need deterministic timing
   * without monkey-patching globals.
   */
  clock?: SchedulerClock;
}

export interface SchedulerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export type TimerHandle = ReturnType<typeof setTimeout>;

/* ───────────────────────────────────────────────────────────────────── */
/* Implementation                                                        */
/* ───────────────────────────────────────────────────────────────────── */

interface TimerRecord {
  id: string;
  handle: TimerHandle | null;
  cancel: () => void;
}

const DEFAULT_CLOCK: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

class BusSchedulerImpl implements BusScheduler {
  private readonly bus: BusCore;
  private readonly clock: SchedulerClock;
  private readonly timezoneOffsetMinutes: number;
  private readonly onError: (err: unknown, ctx?: Record<string, unknown>) => void;
  private readonly timers = new Map<string, TimerRecord>();
  private stopped = false;

  constructor(opts: BusSchedulerOptions) {
    this.bus = opts.bus;
    this.clock = opts.clock ?? DEFAULT_CLOCK;
    this.timezoneOffsetMinutes = opts.timezoneOffsetMinutes ?? 0;
    this.onError = opts.onError ?? ((err, ctx) => console.error("[bus:scheduler]", err, ctx));
  }

  async start(): Promise<void> {
    // Bookkeeping only — scheduler is lazy. `stop()` flips `stopped`, so
    // restarting after stop should re-enable scheduling.
    this.stopped = false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Snapshot — `cancel` mutates the map.
    const records = Array.from(this.timers.values());
    for (const rec of records) rec.cancel();
    this.timers.clear();
  }

  scheduleHeartbeat(req: ScheduleHeartbeatRequest): ScheduledTrigger {
    if (this.stopped) return noopTrigger();
    if (!(req.interval_minutes > 0)) {
      throw new Error("scheduleHeartbeat: interval_minutes must be > 0");
    }
    const id = randomUUID();
    const intervalMs = req.interval_minutes * 60_000;
    const startedAt = this.clock.now();
    let tickIndex = 0;

    const fire = () => {
      const rec = this.timers.get(id);
      if (!rec || this.stopped) return;
      tickIndex += 1;

      // Anchor to `startedAt` to avoid drift — naive `setInterval`
      // accumulates the duration of the callback into each gap. The next
      // fire happens at `startedAt + (tickIndex + 1) * intervalMs`, i.e.
      // one full interval after THIS tick's target. `Math.max(0, …)`
      // guards against the case where dispatch itself ran longer than
      // the interval (we'd fire back-to-back to catch up rather than
      // skipping ticks — matches the conservative legacy behaviour).
      const nextTargetAbs = startedAt + (tickIndex + 1) * intervalMs;
      const delay = Math.max(0, nextTargetAbs - this.clock.now());
      rec.handle = this.clock.setTimeout(fire, delay);

      // Dispatch this tick. Failures are swallowed into onError — one
      // bad sendPrompt must not break the cadence.
      this.dispatch({
        agent_id: req.agent_id,
        origin: "heartbeat",
        origin_id: `bus-scheduler:${id}`,
        user_id: "system",
        text: req.prompt,
        metadata: {
          ...(req.metadata ?? {}),
          scheduler: "bus",
          kind: "heartbeat",
          scheduler_trigger_id: id,
          tick: tickIndex,
        },
      });
    };

    // First tick fires after `intervalMs`, not immediately. Matches the
    // legacy heartbeat semantics in `src/runner.ts` (heartbeat doesn't
    // fire on registration — it waits one interval).
    const record: TimerRecord = {
      id,
      handle: null,
      cancel: () => {
        const r = this.timers.get(id);
        if (!r) return;
        if (r.handle) this.clock.clearTimeout(r.handle);
        this.timers.delete(id);
      },
    };
    this.timers.set(id, record);
    record.handle = this.clock.setTimeout(fire, intervalMs);

    return { cancel: record.cancel };
  }

  scheduleCron(req: ScheduleCronRequest): ScheduledTrigger {
    if (this.stopped) return noopTrigger();

    const hasAt = req.at instanceof Date;
    const hasExpr = typeof req.cronExpr === "string" && req.cronExpr.trim().length > 0;
    if (hasAt === hasExpr) {
      throw new Error("scheduleCron: exactly one of { at, cronExpr } is required");
    }

    const id = randomUUID();
    return hasAt
      ? this.scheduleCronOneShot(id, req.at as Date, req)
      : this.scheduleCronRecurring(id, req.cronExpr as string, req);
  }

  /* ─────────────────────────────── internals ─────────────────────────────── */

  private scheduleCronOneShot(id: string, at: Date, req: ScheduleCronRequest): ScheduledTrigger {
    const fireAt = at.getTime();
    const delay = Math.max(0, fireAt - this.clock.now());

    const fire = () => {
      this.timers.delete(id);
      if (this.stopped) return;
      this.dispatch({
        agent_id: req.agent_id,
        origin: "cron",
        origin_id: `bus-scheduler:${id}`,
        user_id: "system",
        text: req.prompt,
        metadata: {
          ...(req.metadata ?? {}),
          scheduler: "bus",
          kind: "cron",
          scheduler_trigger_id: id,
          mode: "at",
          fire_at: fireAt,
        },
      });
    };

    const record: TimerRecord = {
      id,
      handle: null,
      cancel: () => {
        const r = this.timers.get(id);
        if (!r) return;
        if (r.handle) this.clock.clearTimeout(r.handle);
        this.timers.delete(id);
      },
    };
    this.timers.set(id, record);
    record.handle = this.clock.setTimeout(fire, delay);
    return { cancel: record.cancel };
  }

  private scheduleCronRecurring(
    id: string,
    cronExpr: string,
    req: ScheduleCronRequest,
  ): ScheduledTrigger {
    // Validate the expression eagerly — `nextCronMatch` will silently
    // produce a "matches in 2 days" Date on garbage input, but at least
    // it won't throw. We use a probe call to catch obvious junk.
    try {
      nextCronMatch(cronExpr, new Date(this.clock.now()), this.timezoneOffsetMinutes);
    } catch (err) {
      throw new Error(`scheduleCron: invalid cron expression "${cronExpr}": ${String(err)}`);
    }

    const arm = () => {
      const rec = this.timers.get(id);
      if (!rec || this.stopped) return;
      const now = this.clock.now();
      const nextDate = nextCronMatch(cronExpr, new Date(now), this.timezoneOffsetMinutes);
      const delay = Math.max(0, nextDate.getTime() - now);
      rec.handle = this.clock.setTimeout(() => {
        // Re-fetch the record — `cancel`/`stop` may have purged it
        // between scheduling and firing.
        const live = this.timers.get(id);
        if (!live || this.stopped) return;
        this.dispatch({
          agent_id: req.agent_id,
          origin: "cron",
          origin_id: `bus-scheduler:${id}`,
          user_id: "system",
          text: req.prompt,
          metadata: {
            ...(req.metadata ?? {}),
            scheduler: "bus",
            kind: "cron",
            scheduler_trigger_id: id,
            mode: "cron",
            cron: cronExpr,
            fire_at: nextDate.getTime(),
          },
        });
        // Re-arm for the next match.
        arm();
      }, delay);
    };

    const record: TimerRecord = {
      id,
      handle: null,
      cancel: () => {
        const r = this.timers.get(id);
        if (!r) return;
        if (r.handle) this.clock.clearTimeout(r.handle);
        this.timers.delete(id);
      },
    };
    this.timers.set(id, record);
    arm();
    return { cancel: record.cancel };
  }

  private dispatch(req: SendPromptRequest & { origin: BusOrigin }): void {
    // Promise rejections are isolated — one bad dispatch must not break
    // the cadence. Mirrors `BusCore.publish`'s defensive style.
    this.bus.sendPrompt(req).catch((err) => {
      this.onError(err, { ctx: "scheduler-dispatch", agent_id: req.agent_id });
    });
  }
}

function noopTrigger(): ScheduledTrigger {
  return { cancel: () => {} };
}

/* ───────────────────────────────────────────────────────────────────── */
/* Convenience factory                                                   */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Create a Bus scheduler. Caller may call `start()` for clarity, but the
 * scheduler is lazy and `scheduleX` calls work immediately.
 *
 * Backwards-compatible overload: passing a bare `BusCore` works because
 * older drafts of the spec described the factory as `createBusScheduler(bus)`.
 */
export function createBusScheduler(bus: BusCore): BusScheduler;
export function createBusScheduler(opts: BusSchedulerOptions): BusScheduler;
export function createBusScheduler(arg: BusCore | BusSchedulerOptions): BusScheduler {
  const opts: BusSchedulerOptions = isBusSchedulerOptions(arg) ? arg : { bus: arg };
  return new BusSchedulerImpl(opts);
}

function isBusSchedulerOptions(x: BusCore | BusSchedulerOptions): x is BusSchedulerOptions {
  return typeof (x as BusSchedulerOptions).bus !== "undefined";
}
