/**
 * WiseCronSubject — intelligent cron job monitoring & optimization
 *
 * Analyzes every cron in crontab -l with deep per-cron metrics:
 * - Success rate from log files
 * - Runtime patterns & anomalies
 * - Schedule vs actual relevance window
 * - Criticality classification
 * - Dependency awareness
 * - Redundancy detection
 *
 * Proposes: schedule changes, criticality upgrades, log additions, disabling dead crons.
 * Auto-merges: low-risk changes only (add logging). Medium/high = Telegram proposal.
 */

import { execSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { BaseSubject } from './base.js';
import type { Cluster, Observation, Patch, Proposal, UnsignedProposal, ValidationResult } from '../core/types.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type Criticality = 'critical' | 'high' | 'medium' | 'low';

export interface CronEntry {
  raw: string;          // original crontab line
  schedule: string;     // e.g. "*/15 * * * *"
  command: string;      // full command string
  logPath: string | null;
  scriptName: string;   // basename of script/cmd
  criticality: Criticality;
  tags: Set<string>;    // 'trading','email','backup','monitor','cleanup','ai'
  /** Expected window when this cron is relevant. null = 24/7 */
  relevanceWindow: { startH: number; endH: number; daysOfWeek: number[] } | null;
}

export interface CronHealth {
  entry: CronEntry;
  logExists: boolean;
  logSizeBytes: number;
  lastModifiedAt: Date | null;
  /** Lines containing error indicators in the last 24h window */
  errorCount24h: number;
  /** Total error-like lines in log */
  errorCountTotal: number;
  /** Estimated total line count */
  lineCount: number;
  /** 0-1, estimated from error density */
  successRate: number;
  /** Hours since last log activity */
  hoursSinceLastRun: number | null;
  anomalies: string[];
}

// ── Constants ────────────────────────────────────────────────────────────────

// Starter classification keywords. Operators with substantially different
// cron mixes (different industries, different naming conventions) should
// override these by passing { overrides: { critical_keywords: [...] } } to
// the WiseCronSubject constructor when registering it with the engine.
//
// The defaults below reflect a common mix: trading/finance scripts as critical,
// monitoring/alerting as high, backups/sync as medium.
const CRITICAL_KEYWORDS = ['ibkr', 'gateway', 'swing', 'momentum', 'trader'];
const HIGH_KEYWORDS     = ['email', 'gmail', 'monitor', 'error-detective', 'pending', 'infra', 'oauth'];
const MEDIUM_KEYWORDS   = ['backup', 'sync', 'memory', 'session', 'archiviste', 'tuner', 'digest', 'brief'];
// everything else = low

const TRADING_KEYWORDS  = ['ibkr', 'gateway', 'swing', 'momentum', 'trader', 'breakout', 'market-top', 'hindsight'];
const EMAIL_KEYWORDS    = ['gmail', 'email', 'oauth', 'token'];
const BACKUP_KEYWORDS   = ['backup', 'sync', 'dream-sync'];
const AI_KEYWORDS       = ['claude', 'tuner', 'session', 'context', 'archiviste', 'autofix', 'autonomous', 'grok'];
const MONITORING_KEYWORDS = ['monitor', 'error-detective', 'infra', 'health', 'watchdog', 'detective'];

const ERROR_PATTERNS = [
  /\berror\b/i, /exception/i, /traceback/i, /failed/i,
  /critical/i, /fatal/i, /abort/i, /module not found/i,
  /no such file/i, /connection refused/i, /timeout/i,
];

const TRADING_HOURS = { startH: 9, endH: 17, daysOfWeek: [1, 2, 3, 4, 5] }; // Mon-Fri 9-17

// ── Parsers ──────────────────────────────────────────────────────────────────

function parseCrontab(): CronEntry[] {
  let raw: string;
  try {
    raw = execSync('crontab -l', { encoding: 'utf8', timeout: 5000 });
  } catch {
    return [];
  }

  const entries: CronEntry[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Parse schedule (5 fields) + command
    const parts = trimmed.split(/\s+/);
    if (parts.length < 6) continue;

    const schedule = parts.slice(0, 5).join(' ');
    const command  = parts.slice(5).join(' ');

    // Extract log path from >> redirection
    const logMatch = command.match(/>>?\s*([^\s;|&]+\.log[^\s;|&]*)/);
    const logPath  = logMatch ? logMatch[1]!.trim() : null;

    const scriptName = extractScriptName(command);
    const criticality = classifyCriticality(command, scriptName);
    const tags = extractTags(command, scriptName);
    const relevanceWindow = inferRelevanceWindow(command, scriptName, schedule, tags);

    entries.push({ raw: trimmed, schedule, command, logPath, scriptName, criticality, tags, relevanceWindow });
  }

  return entries;
}

/** Shell operators / builtins that must never be returned as a script name. */
const SHELL_NON_NAMES = new Set([
  '>>', '>', '<<', '<', '|', '||', '&&', '&', ';', '!',
  '2>&1', '2>', '>&', '/dev/null',
  'echo', 'true', 'false', 'set', 'unset', 'export', 'cd', 'test', ':',
  '(', ')', '{', '}',
]);

function isShellOperatorOrBuiltin(tok: string): boolean {
  if (!tok) return true;
  if (SHELL_NON_NAMES.has(tok)) return true;
  // Anything that looks like a redirection (starts with > or <) or is purely punctuation.
  if (/^[<>&|;!]/.test(tok)) return true;
  if (/^["']/.test(tok)) return true;
  // Bare numeric file descriptors used in redirections, e.g. `2>&1` already split to `2` + `1`.
  if (/^\d+$/.test(tok)) return true;
  return false;
}

function extractScriptName(command: string): string {
  // echo-only lines write a static message to a log. The "purpose" of the cron
  // is the log destination, not the echo binary or the message content.
  if (/^\s*echo\b/.test(command)) {
    const redirMatch = command.match(/>>?\s*(\S+)/);
    if (redirMatch) {
      const base = basename(redirMatch[1]!).replace(/\.log$/i, '');
      if (base) return base + '.log';
    }
    return 'echo-message';
  }

  // Match `python3 …`, `bash …`, `sh …`, `node …`, `bun run …` at a word boundary
  // — handles both bare `python3 script.py` and full paths like `/usr/bin/python3 script.py`.
  // `\b` ensures `.sh` (end of any script filename) doesn't trigger a spurious match.
  const interpMatch = command.match(/\b(python3?|bash|sh|node|bun\s+run)\s+([^\s;|&<>]+)/);
  if (interpMatch) {
    const captured = interpMatch[2]!;
    if (
      !captured.startsWith('-') &&
      !captured.startsWith('$') &&
      !isShellOperatorOrBuiltin(captured)
    ) {
      return basename(captured);
    }
  }
  // Fallback: walk tokens until we find one that looks like a real path or program.
  // Split on whitespace AND shell operators so redirections and pipes don't pollute tokens.
  const parts = command.split(/[\s;|&<>]+/);
  for (const p of parts) {
    if (!p) continue;
    if (p.startsWith('-') || p.startsWith('$')) continue;
    if (isShellOperatorOrBuiltin(p)) continue;
    // If this token is itself an interpreter (`python3`, `/usr/bin/python3`, etc.),
    // skip it so the next token (the actual script path) is returned instead.
    const base = basename(p);
    if (/^(python3?|bash|sh|node|bun)$/.test(base)) continue;
    return base;
  }
  return command.slice(0, 40);
}

function classifyCriticality(command: string, script: string): Criticality {
  const text = (command + ' ' + script).toLowerCase();
  if (CRITICAL_KEYWORDS.some(k => text.includes(k))) return 'critical';
  if (HIGH_KEYWORDS.some(k => text.includes(k))) return 'high';
  if (MEDIUM_KEYWORDS.some(k => text.includes(k))) return 'medium';
  return 'low';
}

function extractTags(command: string, script: string): Set<string> {
  const text = (command + ' ' + script).toLowerCase();
  const tags = new Set<string>();
  if (TRADING_KEYWORDS.some(k => text.includes(k)))   tags.add('trading');
  if (EMAIL_KEYWORDS.some(k => text.includes(k)))     tags.add('email');
  if (BACKUP_KEYWORDS.some(k => text.includes(k)))    tags.add('backup');
  if (AI_KEYWORDS.some(k => text.includes(k)))        tags.add('ai');
  if (MONITORING_KEYWORDS.some(k => text.includes(k))) tags.add('monitor');
  return tags;
}

function inferRelevanceWindow(
  command: string, script: string, schedule: string, tags: Set<string>
): CronEntry['relevanceWindow'] {
  const text = (command + ' ' + script + ' ' + schedule).toLowerCase();

  // Cron already has market-hour restriction in schedule
  if (schedule.includes('1-5') && (schedule.includes('9-') || schedule.includes('13-') || schedule.includes('16'))) {
    return TRADING_HOURS;
  }

  if (tags.has('trading')) return TRADING_HOURS;
  if (tags.has('backup'))  return { startH: 2, endH: 6, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
  if (text.includes('morning-brief') || text.includes('digest')) {
    return { startH: 6, endH: 9, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
  }
  return null; // 24/7 OK
}

// ── Health analysis ──────────────────────────────────────────────────────────

function analyzeHealth(entry: CronEntry): CronHealth {
  const now = new Date();
  const anomalies: string[] = [];

  if (!entry.logPath) {
    return {
      entry, logExists: false, logSizeBytes: 0, lastModifiedAt: null,
      errorCount24h: 0, errorCountTotal: 0, lineCount: 0, successRate: 1,
      hoursSinceLastRun: null,
      anomalies: entry.criticality !== 'low' ? ['no_log_file'] : [],
    };
  }

  if (!existsSync(entry.logPath)) {
    return {
      entry, logExists: false, logSizeBytes: 0, lastModifiedAt: null,
      errorCount24h: 0, errorCountTotal: 0, lineCount: 0, successRate: 1,
      hoursSinceLastRun: null,
      anomalies: entry.criticality !== 'low' ? ['log_path_missing'] : [],
    };
  }

  const stat = statSync(entry.logPath);
  const lastModifiedAt = stat.mtime;
  const hoursSinceLastRun = (now.getTime() - lastModifiedAt.getTime()) / 3_600_000;

  // Read log (last 5000 lines max to keep memory bounded)
  let logContent = '';
  try {
    const result = spawnSync('tail', ['-n', '5000', entry.logPath], { encoding: 'utf8', timeout: 5000 });
    logContent = result.stdout ?? '';
  } catch {
    logContent = '';
  }

  const lines = logContent.split('\n').filter(l => l.trim());
  const lineCount = lines.length;
  const cutoff24h = new Date(now.getTime() - 86_400_000);

  let errorCountTotal = 0;
  let errorCount24h = 0;

  for (const line of lines) {
    const hasError = ERROR_PATTERNS.some(re => re.test(line));
    if (hasError) {
      errorCountTotal++;
      // Rough 24h detection — look for today's date in line
      if (isLineRecent(line, cutoff24h)) errorCount24h++;
    }
  }

  const successRate = lineCount > 0 ? Math.max(0, 1 - errorCountTotal / Math.max(lineCount, 1)) : 1;

  // Anomaly detection
  if (successRate < 0.5 && lineCount > 10) {
    anomalies.push('high_error_rate');
  } else if (successRate < 0.8 && lineCount > 20) {
    anomalies.push('elevated_error_rate');
  }

  if (hoursSinceLastRun !== null) {
    const expectedIntervalH = scheduleToIntervalHours(entry.schedule);
    if (expectedIntervalH !== null && hoursSinceLastRun > expectedIntervalH * 3) {
      anomalies.push('stale_log');
    }
  }

  if (lineCount === 0) {
    anomalies.push('empty_log');
  }

  // Check schedule vs relevance mismatch
  if (entry.relevanceWindow && !scheduleRespectsWindow(entry.schedule, entry.relevanceWindow)) {
    anomalies.push('schedule_outside_relevance');
  }

  return {
    entry, logExists: true, logSizeBytes: stat.size, lastModifiedAt,
    errorCount24h, errorCountTotal, lineCount, successRate, hoursSinceLastRun,
    anomalies,
  };
}

function isLineRecent(line: string, cutoff: Date): boolean {
  // Match timestamps like "2026-05-11" or "May 11" or "11/05"
  const datePatterns = [
    /(\d{4}-\d{2}-\d{2})/,
    /(\w{3}\s+\d{1,2})/,
  ];
  for (const re of datePatterns) {
    const m = line.match(re);
    if (m) {
      try {
        const d = new Date(m[1]!);
        if (!isNaN(d.getTime())) return d >= cutoff;
      } catch { /* ignore */ }
    }
  }
  return false;
}

function scheduleToIntervalHours(schedule: string): number | null {
  const parts = schedule.split(/\s+/);
  if (parts.length < 5) return null;
  const [min, hour] = parts;
  if (!min || !hour) return null;

  const minuteMatch = min.match(/^\*\/(\d+)$/);
  if (minuteMatch) return parseInt(minuteMatch[1]!) / 60;

  const hourMatch = hour.match(/^\*\/(\d+)$/);
  if (hourMatch) return parseInt(hourMatch[1]!);

  if (min === '0' && !hour.includes('*') && !hour.includes('/')) {
    return 24; // daily
  }

  return null;
}

function scheduleRespectsWindow(
  schedule: string,
  window: NonNullable<CronEntry['relevanceWindow']>
): boolean {
  const parts = schedule.split(/\s+/);
  if (parts.length < 5) return true;
  const dow = parts[4]!;
  // If cron runs every day (*) but should only run on specific days
  if (dow === '*' && window.daysOfWeek.length < 7) return false;
  return true;
}

// ── WiseCronSubject ──────────────────────────────────────────────────────────

export interface WiseCronSubjectConfig {
  /** Directory where missing-log proposals suggest writing logs. Defaults to XDG state path. */
  logDir?: string;
  /** Per-operator overrides for criticality / tag keywords (advanced; leave undefined to use starter defaults). */
  overrides?: Partial<WiseCronKeywordOverrides>;
}

export interface WiseCronKeywordOverrides {
  critical_keywords: string[];
  high_keywords: string[];
  medium_keywords: string[];
  trading_keywords: string[];
  email_keywords: string[];
  backup_keywords: string[];
  ai_keywords: string[];
  monitoring_keywords: string[];
}

export class WiseCronSubject extends BaseSubject {
  private readonly logDir: string;
  readonly name = 'wisecron';
  readonly risk_tier = 'medium' as const;
  readonly auto_merge_default = false;
  readonly supports_creation = false;

  // Detect redundant cron pairs (same script, different intervals)
  private detectRedundancy(entries: CronEntry[]): string[] {
    const byScript = new Map<string, CronEntry[]>();
    for (const e of entries) {
      const key = e.scriptName;
      if (!byScript.has(key)) byScript.set(key, []);
      byScript.get(key)!.push(e);
    }
    const redundant: string[] = [];
    for (const [script, group] of byScript) {
      if (group.length > 1) redundant.push(script);
    }
    return redundant;
  }

  constructor(opts: WiseCronSubjectConfig = {}) {
    super();
    // XDG-style default: ~/.local/state/cron-logs. Operators override via the
    // `logDir` constructor arg when wiring the subject in their adapter.
    this.logDir = opts.logDir ?? join(homedir(), '.local', 'state', 'cron-logs');
  }

  async collectObservations(since: Date): Promise<Observation[]> {
    const entries = parseCrontab();
    const healthMap = new Map<string, CronHealth>();
    for (const e of entries) healthMap.set(e.scriptName, analyzeHealth(e));

    const redundantScripts = this.detectRedundancy(entries);
    const observations: Observation[] = [];

    for (const health of healthMap.values()) {
      const { entry, anomalies, successRate, hoursSinceLastRun } = health;

      // Only emit observations for actual issues
      if (anomalies.length === 0 && !redundantScripts.includes(entry.scriptName)) continue;

      const allAnomalies = [...anomalies];
      if (redundantScripts.includes(entry.scriptName)) allAnomalies.push('redundant_schedule');

      const signal_type = successRate < 0.5 || anomalies.includes('high_error_rate')
        ? 'correction'
        : anomalies.includes('stale_log') || anomalies.includes('empty_log')
          ? 'orphan'
          : 'repeated_trigger';

      observations.push({
        session_id: `wisecron-${entry.scriptName}-${Date.now()}`,
        observed_at: new Date(),
        signal_type,
        verbatim: JSON.stringify({
          script: entry.scriptName,
          criticality: entry.criticality,
          tags: [...entry.tags],
          schedule: entry.schedule,
          anomalies: allAnomalies,
          success_rate: Math.round(successRate * 100),
          hours_since_last_run: hoursSinceLastRun ? Math.round(hoursSinceLastRun) : null,
          error_count_24h: health.errorCount24h,
          log_exists: health.logExists,
        }).slice(0, 500),
        metadata: {
          subject: 'wisecron',
          script: entry.scriptName,
          anomalies: allAnomalies,
          criticality: entry.criticality,
          schedule: entry.schedule,
          success_rate: successRate,
        },
      });
    }

    return observations.filter(o => o.observed_at >= since);
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    if (observations.length === 0) return [];

    const clusters: Cluster[] = [];

    // Group by anomaly type for clustering
    const byAnomaly = new Map<string, Observation[]>();
    for (const obs of observations) {
      const data = JSON.parse(obs.verbatim) as Record<string, unknown>;
      const anomalies = (data['anomalies'] as string[]) ?? [];
      for (const a of anomalies) {
        if (!byAnomaly.has(a)) byAnomaly.set(a, []);
        byAnomaly.get(a)!.push(obs);
      }
    }

    for (const [anomalyType, obs] of byAnomaly) {
      const scripts = obs.map(o => (JSON.parse(o.verbatim) as Record<string, unknown>)['script'] as string);
      const highCrit = obs.some(o => {
        const d = JSON.parse(o.verbatim) as Record<string, unknown>;
        return d['criticality'] === 'critical' || d['criticality'] === 'high';
      });

      clusters.push({
        id: `wisecron-${anomalyType}`,
        subject: 'wisecron',
        observations: obs,
        frequency: obs.length,
        success_rate: highCrit ? 0.2 : 0.5,
        sentiment: highCrit ? 'negative' : 'neutral',
        subjects_touched: scripts,
      });
    }

    return clusters;
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    const anomalyType = cluster.id.replace('wisecron-', '');
    const scripts = cluster.subjects_touched;

    const { title, description, alternatives } = this.buildProposal(anomalyType, scripts, cluster);

    return {
      id: Date.now(),
      cluster_id: cluster.id,
      subject: 'wisecron',
      kind: 'cron_change',
      target_path: 'crontab',
      alternatives: alternatives.map((a, i) => ({
        id: `alt-${i}`,
        label: a.label,
        diff_or_content: a.content,
        tradeoff: a.tradeoff,
      })),
      pattern_signature: `wisecron:${anomalyType}:${scripts.slice(0, 2).join(',')}`,
      created_at: new Date(),
    };
  }

  private buildProposal(
    anomalyType: string,
    scripts: string[],
    cluster: Cluster
  ): { title: string; description: string; alternatives: { label: string; content: string; tradeoff: string }[] } {
    const scriptList = scripts.slice(0, 5).join(', ');

    switch (anomalyType) {
      case 'high_error_rate':
      case 'elevated_error_rate':
        return {
          title: `⚠️ Cron(s) avec taux d'erreur élevé: ${scriptList}`,
          description: `Ces crons génèrent beaucoup d'erreurs. Il faut investiguer ou désactiver temporairement.`,
          alternatives: [
            {
              label: 'Désactiver temporairement (commenter dans crontab)',
              content: `# Commenter les lignes de: ${scriptList}\n# Raison: taux erreur > 50%\n# À réactiver après fix`,
              tradeoff: 'Arrête les erreurs mais perd la fonctionnalité',
            },
            {
              label: 'Ajouter retry avec backoff',
              content: `# Wrapper script: retry 3x avec 60s entre les tentatives\n# for script: ${scriptList}`,
              tradeoff: 'Réduit les faux positifs sans désactiver',
            },
            {
              label: 'Réduire la fréquence pour limiter le bruit',
              content: `# Réduire interval (ex: */5 → */30) pour: ${scriptList}`,
              tradeoff: 'Moins de bruit, mais moins réactif',
            },
          ],
        };

      case 'stale_log':
      case 'empty_log':
        return {
          title: `🔇 Cron(s) silencieux (log inactif): ${scriptList}`,
          description: `Ces crons n'ont pas loggé depuis plus de 3x leur interval prévu. Peut-être crashé ou trop lent.`,
          alternatives: [
            {
              label: 'Vérifier manuellement + restart si OK',
              content: `# Scripts to check:\n${scripts.map(s => `#   tail -100 ${this.logDir}/${s.replace(/\.(py|sh|js|ts|bun)$/, '')}.log`).join('\n')}`,
              tradeoff: 'Diagnostic d\'abord, action après',
            },
            {
              label: 'Ajouter healthcheck (alerte si log > Xh inactif)',
              content: `# Ajouter dans infra-monitor.sh:\n${scripts.map(s => `# check_log_freshness ${s}`).join('\n')}`,
              tradeoff: 'Détection proactive future',
            },
          ],
        };

      case 'schedule_outside_relevance':
        return {
          title: `⏰ Schedule non-optimal: ${scriptList}`,
          description: `Ces crons tournent hors de leur fenêtre de pertinence (ex: cron trading le weekend).`,
          alternatives: [
            {
              label: 'Restreindre aux jours/heures pertinents',
              content: `# Trading crons: ajouter "1-5" pour lun-ven seulement\n# Email crons: ajouter "6-22" pour heures normales\n# Scripts: ${scriptList}`,
              tradeoff: 'Réduit coûts API + charge serveur',
            },
            {
              label: 'Garder le schedule actuel (statut quo)',
              content: '# Aucun changement',
              tradeoff: 'Simplicité mais overhead inutile',
            },
          ],
        };

      case 'redundant_schedule':
        return {
          title: `♻️ Crons redondants détectés: ${scriptList}`,
          description: `Le même script tourne avec plusieurs schedules différents. Potentiellement intentionnel mais à valider.`,
          alternatives: [
            {
              label: 'Garder seulement le cron le plus fréquent',
              content: `# Scripts redondants: ${scriptList}\n# Réviser et supprimer le doublon le moins utile`,
              tradeoff: 'Simplifie la crontab',
            },
            {
              label: 'Confirmer que les deux sont intentionnels (no-op)',
              content: '# Aucun changement — redondance voulue',
              tradeoff: 'Conserve le comportement actuel',
            },
          ],
        };

      case 'no_log_file':
      case 'log_path_missing':
        return {
          title: `📋 Cron(s) sans logging: ${scriptList}`,
          description: `Ces crons critiques/hauts ne loggent pas — impossible de surveiller leur santé.`,
          alternatives: [
            {
              label: `Add log redirection >> ${this.logDir}/[name].log 2>&1`,
              content: `# Modify these crontab lines:\n${scripts.map(s => `#   ${s}`).join('\n')}\n# Append to each line: >> ${this.logDir}/[name].log 2>&1`,
              tradeoff: 'Surveillance possible, léger overhead disque',
            },
          ],
        };

      default:
        return {
          title: `🔍 Anomalie cron: ${anomalyType} — ${scriptList}`,
          description: `Anomalie détectée sur ces crons: ${anomalyType}`,
          alternatives: [
            {
              label: 'Investiguer manuellement',
              content: `# Vérifier: ${scriptList}\n# Anomalie: ${anomalyType}`,
              tradeoff: 'Nécessite intervention manuelle',
            },
          ],
        };
    }
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    const alt = proposal.alternatives.find(a => a.id === alternativeId);
    if (!alt) throw new Error(`Alternative ${alternativeId} not found in proposal ${proposal.id}`);

    const { execSync } = await import('node:child_process');
    const { homedir } = await import('node:os');

    try {
      // Read current crontab
      let currentCrontab = '';
      try {
        currentCrontab = execSync('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });
      } catch {
        currentCrontab = '';
      }

      // Apply the modification based on anomaly type
      let modifiedCrontab = currentCrontab;
      const sig = proposal.pattern_signature || '';

      if (sig.includes('log_path_missing')) {
        // Add log redirection to crons without one
        const targets = sig.split(':')[2]?.split(',') || [];
        for (const target of targets) {
          if (!target || target.startsWith('>')) continue;
          const scriptName = target.trim();
          const logFile = `${this.logDir}/${scriptName.replace(/\.(py|sh|js|ts|bun)$/, '')}.log`;
          // Find lines with this script and add log redirection if missing
          modifiedCrontab = modifiedCrontab
            .split('\n')
            .map(line => {
              if (line.includes(scriptName) && !line.includes('>>')) {
                return `${line} >> ${logFile} 2>&1`;
              }
              return line;
            })
            .join('\n');
        }
      } else if (sig.includes('schedule_outside_relevance')) {
        // Restrict cron to weekdays (Mon-Fri, DOW field 1-5) when its tags
        // mark it as trading-relevant. The proposal alternatives advertise
        // *"restrict to weekdays"*, so we must actually touch the DOW field,
        // not silently rewrite hour/interval and pretend nothing happened
        // for lines whose schedule shape we don't recognize.
        const target = sig.split(':')[2]?.trim() || '';
        let matched = false;
        modifiedCrontab = modifiedCrontab
          .split('\n')
          .map(line => {
            if (!line.includes(target)) return line;
            if (line.trim().startsWith('#')) return line; // skip comment lines
            const parts = line.trim().split(/\s+/);
            if (parts.length < 6) return line; // not a cron line we can parse
            // The 5th cron field is day-of-week. Rewrite "*" to "1-5".
            // Leave non-wildcard DOW alone — operator already has intent.
            if (parts[4] === '*') {
              parts[4] = '1-5';
              matched = true;
              return parts.join(' ');
            }
            return line;
          })
          .join('\n');
        if (!matched) {
          throw new Error(
            `schedule_outside_relevance apply did not match any line for ${target}: ` +
            `either the script name has no entry, the DOW field is already restricted, ` +
            `or the line shape is unparseable. No change written.`,
          );
        }
      } else if (sig.includes('redundant_schedule')) {
        // Keep only the most frequent cron, remove duplicates
        const targets = sig.split(':')[2]?.split(',') || [];
        const linesToRemove = targets.slice(1); // Keep first, remove rest
        modifiedCrontab = modifiedCrontab
          .split('\n')
          .filter(line => {
            for (const t of linesToRemove) {
              if (line.includes(t.trim())) return false;
            }
            return true;
          })
          .join('\n');
      }

      // Write modified crontab via `crontab -` (stdin). Avoids the
      // /tmp/crontab-<ts> symlink-attack vector (predictable path + cat/crontab
      // both follow symlinks on a multi-user host).
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync('crontab', ['-'], { input: modifiedCrontab, encoding: 'utf8' });
      if (result.status !== 0) {
        throw new Error(
          `crontab write failed (exit ${result.status}): ${(result.stderr || '').trim().slice(0, 200)}`,
        );
      }

      return {
        target_path: 'crontab',
        kind: 'cron_change',
        applied_content: modifiedCrontab,
      };
    } catch (err) {
      throw new Error(`Failed to apply cron change: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async validate(patch: Patch): Promise<ValidationResult> {
    // Validate: if patch contains cron syntax, check with `crontab -`
    if (patch.kind !== 'cron_change') {
      return { valid: false, reason: 'Unknown patch kind' };
    }
    return { valid: true };
  }

  /** Drift detection: hash of current crontab */
  currentStateHash(): string {
    try {
      const ct = execSync('crontab -l', { encoding: 'utf8', timeout: 3000 });
      const { createHash } = require('node:crypto');
      return createHash('sha1').update(ct).digest('hex').slice(0, 12);
    } catch {
      return '';
    }
  }
}
