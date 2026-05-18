/**
 * Backend registry + auto-detection.
 *
 * The registry holds backend instances in priority order. `detectBackend()`
 * probes them sequentially and returns the first one that says it's usable.
 * Callers pin their choice via the `WISECRON_BACKEND` env var when needed:
 *
 *   WISECRON_BACKEND=systemd-user|crontab-posix|in-process
 *
 * In tests, register a fake backend before calling `detectBackend()` to
 * avoid hitting `systemctl` / `crontab` on the test host.
 */

import { type SchedulerBackend } from "./base.js";
import { SystemdUserBackend } from "./systemd-user.js";
import { CrontabPosixBackend } from "./crontab-posix.js";
import { InProcessBackend } from "./in-process.js";

const _registered: SchedulerBackend[] = [];
let _cached: SchedulerBackend | null = null;

/** Reset internal state. For tests only. */
export function resetBackendRegistry(): void {
  _registered.length = 0;
  _cached = null;
}

/** Register a backend candidate. First registered = highest priority. */
export function registerBackend(backend: SchedulerBackend): void {
  _registered.push(backend);
  _cached = null;
}

/**
 * Returns the backend to use on this host. Caches the result for the lifetime
 * of the process; call `resetBackendRegistry()` if the host changes (tests).
 *
 * Priority (default registration order):
 *   1. systemd-user (Linux + systemd)
 *   2. crontab-posix (Linux/macOS/BSD with `crontab`)
 *   3. in-process (universal fallback)
 *
 * Env override `WISECRON_BACKEND` skips detection and demands a specific
 * backend by name, failing loudly if it isn't registered or doesn't `detect()`.
 */
export async function detectBackend(): Promise<SchedulerBackend> {
  if (_cached) return _cached;

  if (_registered.length === 0) {
    registerBackend(new SystemdUserBackend());
    registerBackend(new CrontabPosixBackend());
    registerBackend(new InProcessBackend());
  }

  const pinned = process.env["WISECRON_BACKEND"];
  if (pinned) {
    const found = _registered.find((b) => b.name === pinned);
    if (!found) {
      throw new Error(
        `WISECRON_BACKEND=${pinned} is not registered (have: ${_registered.map((b) => b.name).join(", ")})`,
      );
    }
    if (!(await found.detect())) {
      throw new Error(
        `WISECRON_BACKEND=${pinned} is registered but detect() returned false on this host`,
      );
    }
    _cached = found;
    return found;
  }

  for (const candidate of _registered) {
    try {
      if (await candidate.detect()) {
        _cached = candidate;
        return candidate;
      }
    } catch {
      // detect() must not throw, but if a buggy backend does, treat as not-usable.
      continue;
    }
  }

  // The InProcessBackend always detects true, so reaching here means
  // registration was tampered with. Make the failure mode visible.
  throw new Error(
    "No SchedulerBackend reported detect()=true. InProcessBackend should always succeed — check that it is registered.",
  );
}

/** Snapshot of every registered backend with its current detect() result. */
export async function describeBackends(): Promise<
  { name: string; detected: boolean; gitRepoPath: string | null }[]
> {
  if (_registered.length === 0) await detectBackend();
  const out = [];
  for (const b of _registered) {
    let detected = false;
    try {
      detected = await b.detect();
    } catch {
      detected = false;
    }
    out.push({ name: b.name, detected, gitRepoPath: b.gitRepoPath() });
  }
  return out;
}
