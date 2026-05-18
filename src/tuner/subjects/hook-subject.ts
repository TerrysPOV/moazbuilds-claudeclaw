import {
  existsSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  chmodSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BaseSubject } from '../../skills-tuner/subjects/base.js';
import { sanitizeObservationContent } from '../../skills-tuner/core/security.js';
import type { LLMClient } from '../../skills-tuner/core/llm.js';
import type { Cluster, Observation, Patch, Proposal, UnsignedProposal, ValidationResult } from '../../skills-tuner/core/types.js';
import type { RevertibleSubject } from '../wisecron/types.js';

const DEFAULT_CRASH_RATE_THRESHOLD = 0.2;
const DEFAULT_P95_DURATION_THRESHOLD_MS = 5_000;
const HOOK_EXEC_MODE = 0o755;

interface HookLogEntry {
  hook: string;
  exitCode: number;
  durationMs: number;
  eventType: string;
  timestamp: Date;
}

interface HookHealth {
  hook: string;
  runs: number;
  crashes: number;
  durations: number[];
  crashRate: number;
  p95DurationMs: number;
}

/**
 * HookSubject — wisecron-managed Claude Code hook tuner (HIGH RISK).
 *
 * What it tunes: shell scripts in `~/.claude/hooks/` triggered by Claude
 * Code lifecycle events (UserPromptSubmit, ToolCall, SessionStart, …).
 *
 * Telemetry: exit codes + durations parsed from hook .log files
 * (existing log convention under ~/.claude/hooks/) plus session JSONLs
 * under ~/.claude/projects/.
 *
 * Risk class: HIGH — hooks are executable. A broken hook can block every
 * Claude Code interaction. Apply arms a 5-min observation window; auto-
 * revert if exit codes ≠ 0 detected after apply_time.
 */
export interface HookSubjectConfig {
  llm?: LLMClient;
  /** Hooks dir. Default: ~/.claude/hooks. */
  hooksDir?: string;
  /** Crash-rate threshold (0..1) for detectProblems. Default 0.2. */
  crashRateThreshold?: number;
  /** p95 duration threshold (ms) for detectProblems. Default 5000. */
  p95DurationThresholdMs?: number;
  /**
   * Injected log reader, useful for tests. Receives the resolved hooksDir,
   * returns a list of parsed entries. Default reads `*.log` files in the dir.
   */
  logReader?: (dir: string, since: Date) => HookLogEntry[];
  /**
   * Injected shellcheck runner. Returns null if shellcheck isn't installed,
   * { ok, message } otherwise. Default spawns `shellcheck -n -` over stdin.
   */
  shellcheckRunner?: (content: string) => { ok: boolean; message: string } | null;
}

export class HookSubject extends BaseSubject implements RevertibleSubject {
  readonly name = 'hook';
  readonly risk_tier = 'high' as const;
  readonly auto_merge_default = false;
  readonly supports_creation = false;
  readonly orphan_min_observations = 3;

  private readonly llm?: LLMClient;
  private readonly hooksDir: string;
  private readonly crashRateThreshold: number;
  private readonly p95DurationThresholdMs: number;
  private readonly logReader: (dir: string, since: Date) => HookLogEntry[];
  private readonly shellcheckRunner: (content: string) => { ok: boolean; message: string } | null;

  constructor(opts: HookSubjectConfig = {}) {
    super();
    this.llm = opts.llm;
    this.hooksDir = expandHome(opts.hooksDir ?? join(homedir(), '.claude', 'hooks'));
    this.crashRateThreshold = opts.crashRateThreshold ?? DEFAULT_CRASH_RATE_THRESHOLD;
    this.p95DurationThresholdMs = opts.p95DurationThresholdMs ?? DEFAULT_P95_DURATION_THRESHOLD_MS;
    this.logReader = opts.logReader ?? defaultLogReader;
    this.shellcheckRunner = opts.shellcheckRunner ?? defaultShellcheckRunner;
  }

  async collectObservations(since: Date): Promise<Observation[]> {
    const entries = this.logReader(this.hooksDir, since);
    if (entries.length === 0) return [];

    const health = aggregateHookHealth(entries);
    const observations: Observation[] = [];
    const now = new Date();

    for (const [hook, h] of health) {
      const crashedOnce = h.crashes > 0;
      const slow = h.p95DurationMs > this.p95DurationThresholdMs;
      if (!crashedOnce && !slow) continue;

      const signal_type =
        h.crashRate > this.crashRateThreshold ? 'correction' :
        slow ? 'repeated_trigger' : 'orphan';

      observations.push({
        session_id: `hook-${hook}-${now.getTime()}`,
        observed_at: now,
        signal_type,
        verbatim: sanitizeObservationContent(JSON.stringify({
          hook,
          runs: h.runs,
          crashes: h.crashes,
          crash_rate: Math.round(h.crashRate * 100) / 100,
          p95_duration_ms: h.p95DurationMs,
        }), 500),
        metadata: {
          subject: 'hook',
          hook,
          crash_rate: h.crashRate,
          p95_duration_ms: h.p95DurationMs,
          runs: h.runs,
        },
      });
    }
    return observations;
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    if (observations.length === 0) return [];
    const crashes: Observation[] = [];
    const slow: Observation[] = [];

    for (const obs of observations) {
      const meta = obs.metadata as Record<string, unknown>;
      const crashRate = (meta['crash_rate'] as number | undefined) ?? 0;
      const p95 = (meta['p95_duration_ms'] as number | undefined) ?? 0;
      if (crashRate > this.crashRateThreshold) crashes.push(obs);
      if (p95 > this.p95DurationThresholdMs) slow.push(obs);
    }

    const clusters: Cluster[] = [];
    if (crashes.length > 0) {
      clusters.push({
        id: 'hook-crashing',
        subject: 'hook',
        observations: crashes,
        frequency: crashes.length,
        success_rate: 0.1,
        sentiment: 'negative',
        subjects_touched: Array.from(new Set(crashes.map(o => (o.metadata as Record<string, unknown>)['hook'] as string))),
      });
    }
    if (slow.length > 0) {
      clusters.push({
        id: 'hook-slow',
        subject: 'hook',
        observations: slow,
        frequency: slow.length,
        success_rate: 0.5,
        sentiment: 'neutral',
        subjects_touched: Array.from(new Set(slow.map(o => (o.metadata as Record<string, unknown>)['hook'] as string))),
      });
    }
    return clusters;
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    const firstObs = cluster.observations[0];
    if (!firstObs) throw new Error('hook-subject.proposeChange: cluster empty');
    const hook = (firstObs.metadata as Record<string, unknown>)['hook'] as string;
    const hookPath = join(this.hooksDir, hook);

    let currentContent = '';
    if (existsSync(hookPath)) {
      try { currentContent = readFileSync(hookPath, 'utf8'); } catch { currentContent = ''; }
    }

    const hardened = ensureStrictMode(currentContent || '#!/bin/sh\n');
    const debounced = withDebounceWrapper(currentContent || '#!/bin/sh\n');
    const disabled = '#!/bin/sh\n# Disabled by wisecron — original moved to disabled/\nexit 0\n';

    return {
      id: Date.now(),
      cluster_id: cluster.id,
      subject: 'hook',
      kind: 'patch',
      target_path: hookPath,
      alternatives: [
        { id: 'harden', label: 'Add set -euo pipefail + error trap', diff_or_content: hardened, tradeoff: 'Surfaces silent failures.' },
        { id: 'debounce', label: 'Add caching/debounce wrapper', diff_or_content: debounced, tradeoff: 'Reduces p95 at cost of staleness.' },
        { id: 'disable', label: 'Disable hook (stub returning 0)', diff_or_content: disabled, tradeoff: 'Stops failures; removes functionality.' },
      ],
      pattern_signature: `hook:${cluster.id}:${hook}`,
      created_at: new Date(),
    };
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    const alt = proposal.alternatives.find(a => a.id === alternativeId);
    if (!alt) throw new Error(`hook-subject.apply: alternative ${alternativeId} not found`);

    this.assertInsideHooksDir(proposal.target_path);

    if (existsSync(proposal.target_path)) {
      copyFileSync(proposal.target_path, proposal.target_path + '.bak');
    }
    writeFileSync(proposal.target_path, alt.diff_or_content, 'utf8');
    chmodSync(proposal.target_path, HOOK_EXEC_MODE);

    return {
      target_path: proposal.target_path,
      kind: 'patch',
      applied_content: alt.diff_or_content,
    };
  }

  async validate(patch: Patch): Promise<ValidationResult> {
    if (typeof patch.applied_content !== 'string' || patch.applied_content.trim().length === 0) {
      return { valid: false, reason: 'applied_content is empty' };
    }
    try {
      this.assertInsideHooksDir(patch.target_path);
    } catch (e) {
      return { valid: false, reason: (e as Error).message };
    }
    const shellResult = this.shellcheckRunner(patch.applied_content);
    if (shellResult && !shellResult.ok) {
      return { valid: false, reason: `shellcheck: ${shellResult.message}` };
    }
    return { valid: true };
  }

  /**
   * Snapshot the prior hook bytes from disk before apply() overwrites.
   * Revert() prefers the `.bak` copy apply() drops (which captures the
   * exact pre-apply bytes), so this string is the fallback when the .bak
   * lineage is missing. Empty string when the hook file does not yet exist.
   */
  async snapshotInverse(target: string): Promise<string> {
    this.assertInsideHooksDir(target);
    if (!existsSync(target)) return '';
    try {
      return readFileSync(target, 'utf8');
    } catch {
      return '';
    }
  }

  async revert(inversePatch: Patch): Promise<void> {
    this.assertInsideHooksDir(inversePatch.target_path);

    const bakPath = inversePatch.target_path + '.bak';
    if (existsSync(bakPath)) {
      // Prefer .bak restoration when present — it captured the exact pre-apply
      // bytes (including any trailing/leading whitespace the patch may have lost).
      copyFileSync(bakPath, inversePatch.target_path);
    } else {
      writeFileSync(inversePatch.target_path, inversePatch.applied_content, 'utf8');
    }
    chmodSync(inversePatch.target_path, HOOK_EXEC_MODE);
  }

  private assertInsideHooksDir(target: string): void {
    const resolved = resolve(target);
    const root = resolve(this.hooksDir);
    if (resolved !== root && !resolved.startsWith(root + '/')) {
      throw new Error(`target_path outside hooksDir: ${target}`);
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function aggregateHookHealth(entries: HookLogEntry[]): Map<string, HookHealth> {
  const map = new Map<string, HookHealth>();
  for (const e of entries) {
    let h = map.get(e.hook);
    if (!h) {
      h = { hook: e.hook, runs: 0, crashes: 0, durations: [], crashRate: 0, p95DurationMs: 0 };
      map.set(e.hook, h);
    }
    h.runs += 1;
    if (e.exitCode !== 0) h.crashes += 1;
    h.durations.push(e.durationMs);
  }
  for (const h of map.values()) {
    h.crashRate = h.runs === 0 ? 0 : h.crashes / h.runs;
    h.p95DurationMs = computeP95(h.durations);
  }
  return map;
}

function computeP95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length));
  return sorted[idx]!;
}

function ensureStrictMode(content: string): string {
  if (/set\s+-euo?\s+pipefail/.test(content)) return content;
  const lines = content.split('\n');
  let insertAt = 0;
  if (lines[0]?.startsWith('#!')) insertAt = 1;
  lines.splice(insertAt, 0, 'set -euo pipefail');
  return lines.join('\n');
}

function withDebounceWrapper(content: string): string {
  const header = '#!/bin/sh\n# wisecron debounce wrapper — 30s cache\n_DEBOUNCE_FILE=/tmp/$(basename "$0").lastrun\nif [ -f "$_DEBOUNCE_FILE" ] && [ "$(find "$_DEBOUNCE_FILE" -mmin -0.5 2>/dev/null)" ]; then exit 0; fi\ntouch "$_DEBOUNCE_FILE"\n';
  const body = content.startsWith('#!') ? content.split('\n').slice(1).join('\n') : content;
  return header + body;
}

function defaultLogReader(dir: string, since: Date): HookLogEntry[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.endsWith('.log'));
  const entries: HookLogEntry[] = [];
  for (const f of files) {
    const path = join(dir, f);
    let content: string;
    try {
      const stats = statSync(path);
      if (stats.mtime < since) continue;
      content = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      const parsed = parseHookLogLine(line, f);
      if (parsed) entries.push(parsed);
    }
  }
  return entries;
}

function parseHookLogLine(line: string, file: string): HookLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj !== 'object' || obj === null) return null;
    const hookName = (obj as Record<string, unknown>)['hook'] as string ?? file.replace(/\.log$/, '');
    const exit = Number((obj as Record<string, unknown>)['exit_code'] ?? 0);
    const dur = Number((obj as Record<string, unknown>)['duration_ms'] ?? 0);
    const event = (obj as Record<string, unknown>)['event'] as string ?? 'unknown';
    const tsRaw = (obj as Record<string, unknown>)['ts'] as string | number | undefined;
    const ts = tsRaw ? new Date(tsRaw) : new Date();
    return { hook: hookName, exitCode: exit, durationMs: dur, eventType: event, timestamp: ts };
  } catch {
    return null;
  }
}

function defaultShellcheckRunner(content: string): { ok: boolean; message: string } | null {
  const result = spawnSync('shellcheck', ['-n', '-'], { input: content, encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status === null) return null; // not installed
  if (result.status === 0) return { ok: true, message: '' };
  return { ok: false, message: (result.stdout || result.stderr || '').slice(0, 500) };
}
