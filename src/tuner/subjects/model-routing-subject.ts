import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BaseSubject } from '../../skills-tuner/subjects/base.js';
import { sanitizeObservationContent } from '../../skills-tuner/core/security.js';
import type { LLMClient } from '../../skills-tuner/core/llm.js';
import type { Cluster, Observation, Patch, Proposal, UnsignedProposal, ValidationResult } from '../../skills-tuner/core/types.js';
import type { RevertibleSubject } from '../wisecron/types.js';

const DEAD_DAYS = 90;
const MISTRIGGER_RATE = 0.3;
const EXPENSIVE_RATIO = 5.0;

interface RoutingStats {
  mode: string;
  keyword: string;
  triggers: number;
  reclassifies: number;
  totalCost: number;
  taskClass: string | null;
  lastTriggerAt: Date | null;
}

/**
 * ModelRoutingSubject — wisecron-managed agentic modes / model-router tuner (MEDIUM).
 */
export interface ModelRoutingSubjectConfig {
  llm?: LLMClient;
  /** Modes config path. Default: ~/.claude/agentic.yaml. */
  modesConfigPath?: string;
  /** Injected dispatch-event reader. */
  dispatchReader?: (since: Date) => Array<Record<string, unknown>>;
}

export class ModelRoutingSubject extends BaseSubject implements RevertibleSubject {
  readonly name = 'model_routing';
  readonly risk_tier = 'medium' as const;
  readonly auto_merge_default = false;
  readonly supports_creation = false;

  private readonly llm?: LLMClient;
  private readonly modesConfigPath: string;
  private readonly dispatchReader: (since: Date) => Array<Record<string, unknown>>;

  constructor(opts: ModelRoutingSubjectConfig = {}) {
    super();
    this.llm = opts.llm;
    this.modesConfigPath = expandHome(opts.modesConfigPath ?? join(homedir(), '.claude', 'agentic.yaml'));
    this.dispatchReader = opts.dispatchReader ?? (() => []);
  }

  async collectObservations(since: Date): Promise<Observation[]> {
    const events = this.dispatchReader(since);
    if (events.length === 0) return [];

    const stats = new Map<string, RoutingStats>();
    for (const ev of events) {
      if (ev['type'] !== 'mode_dispatched') continue;
      const mode = String(ev['mode'] ?? 'unknown');
      const keyword = String(ev['keyword'] ?? '');
      const key = `${mode}::${keyword}`;
      let s = stats.get(key);
      if (!s) {
        s = { mode, keyword, triggers: 0, reclassifies: 0, totalCost: 0, taskClass: null, lastTriggerAt: null };
        stats.set(key, s);
      }
      s.triggers += 1;
      if (ev['reclassified'] === true) s.reclassifies += 1;
      if (typeof ev['cost_usd'] === 'number') s.totalCost += ev['cost_usd'];
      if (typeof ev['task_class'] === 'string') s.taskClass = ev['task_class'];
      const ts = ev['ts'];
      if (typeof ts === 'string' || typeof ts === 'number') {
        const tsDate = new Date(ts);
        if (!s.lastTriggerAt || tsDate > s.lastTriggerAt) s.lastTriggerAt = tsDate;
      }
    }

    const now = new Date();

    // Compute per-task-class minimum avg cost (for "expensive" comparison).
    const minCostByClass = new Map<string, number>();
    for (const s of stats.values()) {
      if (!s.taskClass || s.triggers === 0) continue;
      const avg = s.totalCost / s.triggers;
      const prev = minCostByClass.get(s.taskClass);
      if (prev === undefined || avg < prev) minCostByClass.set(s.taskClass, avg);
    }

    const observations: Observation[] = [];
    for (const s of stats.values()) {
      const reclassifyRate = s.triggers === 0 ? 0 : s.reclassifies / s.triggers;
      const avgCost = s.triggers === 0 ? 0 : s.totalCost / s.triggers;
      const ageDays = s.lastTriggerAt ? (now.getTime() - s.lastTriggerAt.getTime()) / 86_400_000 : Infinity;
      const expensiveBaseline = s.taskClass ? minCostByClass.get(s.taskClass) ?? 0 : 0;
      const expensive = expensiveBaseline > 0 && avgCost > expensiveBaseline * EXPENSIVE_RATIO;

      observations.push({
        session_id: `routing-${s.mode}-${s.keyword}-${now.getTime()}`,
        observed_at: now,
        signal_type: reclassifyRate > MISTRIGGER_RATE ? 'correction' :
                     s.triggers === 0 ? 'orphan' : 'repeated_trigger',
        verbatim: sanitizeObservationContent(JSON.stringify({
          mode: s.mode, keyword: s.keyword,
          triggers: s.triggers,
          reclassify_rate: Math.round(reclassifyRate * 100) / 100,
          avg_cost_usd: Math.round(avgCost * 1e4) / 1e4,
          task_class: s.taskClass,
          age_days: Number.isFinite(ageDays) ? Math.round(ageDays) : null,
          expensive,
        }), 500),
        metadata: {
          subject: 'model_routing',
          mode: s.mode,
          keyword: s.keyword,
          triggers: s.triggers,
          reclassify_rate: reclassifyRate,
          avg_cost_usd: avgCost,
          task_class: s.taskClass,
          age_days: Number.isFinite(ageDays) ? ageDays : null,
          expensive,
        },
      });
    }
    return observations;
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    if (observations.length === 0) return [];

    const dead: Observation[] = [];
    const mistrigger: Observation[] = [];
    const expensive: Observation[] = [];

    for (const obs of observations) {
      const meta = obs.metadata as Record<string, unknown>;
      const triggers = (meta['triggers'] as number) ?? 0;
      const ageDays = meta['age_days'] as number | null;
      const reclassifyRate = (meta['reclassify_rate'] as number) ?? 0;
      const isExpensive = (meta['expensive'] as boolean) ?? false;

      if (triggers === 0 || (ageDays !== null && ageDays > DEAD_DAYS)) dead.push(obs);
      if (reclassifyRate > MISTRIGGER_RATE) mistrigger.push(obs);
      if (isExpensive) expensive.push(obs);
    }

    const clusters: Cluster[] = [];
    if (dead.length > 0) clusters.push(mk('routing-dead-keyword', dead, 0.0, 'neutral'));
    if (mistrigger.length > 0) clusters.push(mk('routing-mistrigger', mistrigger, 0.3, 'negative'));
    if (expensive.length > 0) clusters.push(mk('routing-expensive', expensive, 0.5, 'neutral'));
    return clusters;
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    const firstObs = cluster.observations[0];
    if (!firstObs) throw new Error('model-routing-subject.proposeChange: cluster empty');
    const meta = firstObs.metadata as Record<string, unknown>;
    const mode = meta['mode'] as string;
    const keyword = meta['keyword'] as string;

    let current = '';
    if (existsSync(this.modesConfigPath)) {
      try { current = readFileSync(this.modesConfigPath, 'utf8'); } catch { current = ''; }
    }
    const withoutKeyword = removeKeywordFromYaml(current, mode, keyword);
    const renamedKeyword = renameKeywordInYaml(current, mode, keyword, `${keyword}-specific`);
    const swappedModel = swapModelInYaml(current, mode);

    return {
      id: Date.now(),
      cluster_id: cluster.id,
      subject: 'model_routing',
      kind: 'patch',
      target_path: this.modesConfigPath,
      alternatives: [
        { id: 'remove-keyword', label: `Remove keyword '${keyword}' from mode '${mode}'`, diff_or_content: withoutKeyword, tradeoff: 'Stops mis-trigger; may miss legitimate hits.' },
        { id: 'narrow-keyword', label: `Narrow keyword to '${keyword}-specific'`, diff_or_content: renamedKeyword, tradeoff: 'Keeps mode but reduces collisions.' },
        { id: 'swap-model', label: `Swap mode '${mode}' to cheaper model tier`, diff_or_content: swappedModel, tradeoff: 'Lower cost; may regress quality.' },
      ],
      pattern_signature: `model_routing:${cluster.id}:${mode}:${keyword}`,
      created_at: new Date(),
    };
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    const alt = proposal.alternatives.find(a => a.id === alternativeId);
    if (!alt) throw new Error(`model-routing-subject.apply: alternative ${alternativeId} not found`);

    if (existsSync(proposal.target_path)) {
      copyFileSync(proposal.target_path, proposal.target_path + '.bak');
    }
    writeFileSync(proposal.target_path, alt.diff_or_content, 'utf8');
    return {
      target_path: proposal.target_path,
      kind: 'patch',
      applied_content: alt.diff_or_content,
    };
  }

  async validate(patch: Patch): Promise<ValidationResult> {
    let parsed: unknown;
    try {
      const yaml = await import('js-yaml');
      parsed = yaml.load(patch.applied_content);
    } catch (e) {
      return { valid: false, reason: `not valid YAML: ${(e as Error).message}` };
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { valid: false, reason: 'YAML must be a mapping' };
    }
    const root = parsed as Record<string, unknown>;
    const modes = (root['modes'] ?? root) as Record<string, unknown>;
    if (typeof modes !== 'object' || modes === null) {
      return { valid: false, reason: 'modes section missing or not a mapping' };
    }

    const seenKeywords = new Set<string>();
    for (const [name, def] of Object.entries(modes)) {
      if (typeof def !== 'object' || def === null) continue;
      const kws = (def as Record<string, unknown>)['keywords'];
      if (kws === undefined) continue;
      if (!Array.isArray(kws) || !kws.every(k => typeof k === 'string')) {
        return { valid: false, reason: `mode '${name}'.keywords must be string[]` };
      }
      for (const kw of kws as string[]) {
        if (seenKeywords.has(kw)) {
          return { valid: false, reason: `duplicate keyword '${kw}' across modes` };
        }
        seenKeywords.add(kw);
      }
    }
    return { valid: true };
  }

  async revert(inversePatch: Patch): Promise<void> {
    writeFileSync(inversePatch.target_path, inversePatch.applied_content, 'utf8');
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function mk(id: string, obs: Observation[], successRate: number, sentiment: 'negative' | 'neutral' | 'positive'): Cluster {
  return {
    id,
    subject: 'model_routing',
    observations: obs,
    frequency: obs.length,
    success_rate: successRate,
    sentiment,
    subjects_touched: obs.map(o => `${(o.metadata as Record<string, unknown>)['mode']}::${(o.metadata as Record<string, unknown>)['keyword']}`),
  };
}

// Conservative line-based YAML editors: preserve comments + ordering by
// operating on raw text rather than round-tripping through a parser.

function removeKeywordFromYaml(content: string, mode: string, keyword: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let inMode = false;
  for (const line of lines) {
    if (new RegExp(`^\\s{2,}${escapeRe(mode)}:\\s*$`).test(line) || new RegExp(`^${escapeRe(mode)}:\\s*$`).test(line)) {
      inMode = true;
      out.push(line);
      continue;
    }
    if (inMode && /^\S/.test(line)) inMode = false;
    if (inMode && new RegExp(`^\\s*-\\s+["']?${escapeRe(keyword)}["']?\\s*$`).test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

function renameKeywordInYaml(content: string, mode: string, keyword: string, replacement: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let inMode = false;
  for (const line of lines) {
    if (new RegExp(`^\\s{2,}${escapeRe(mode)}:\\s*$`).test(line) || new RegExp(`^${escapeRe(mode)}:\\s*$`).test(line)) {
      inMode = true;
      out.push(line);
      continue;
    }
    if (inMode && /^\S/.test(line)) inMode = false;
    if (inMode) {
      const m = line.match(new RegExp(`^(\\s*-\\s+)["']?${escapeRe(keyword)}["']?\\s*$`));
      if (m) { out.push(`${m[1]}${replacement}`); continue; }
    }
    out.push(line);
  }
  return out.join('\n');
}

function swapModelInYaml(content: string, mode: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let inMode = false;
  for (const line of lines) {
    if (new RegExp(`^\\s{2,}${escapeRe(mode)}:\\s*$`).test(line) || new RegExp(`^${escapeRe(mode)}:\\s*$`).test(line)) {
      inMode = true;
      out.push(line);
      continue;
    }
    if (inMode && /^\S/.test(line)) inMode = false;
    if (inMode && /^\s*model:\s*/.test(line)) {
      out.push(line.replace(/sonnet/g, 'haiku').replace(/opus/g, 'sonnet'));
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
