import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { BaseSubject } from '../../skills-tuner/subjects/base.js';
import { sanitizeObservationContent } from '../../skills-tuner/core/security.js';
import type { LLMClient } from '../../skills-tuner/core/llm.js';
import type { Cluster, Observation, Patch, Proposal, UnsignedProposal, ValidationResult } from '../../skills-tuner/core/types.js';
import type { RevertibleSubject } from '../wisecron/types.js';

const MIN_FEEDBACK_COUNT = 3;
const MAX_AVG_RATING_FOR_FLAG = 3;
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/**
 * PromptTemplateSubject — wisecron-managed prompt template tuner (LOW).
 */
export interface PromptTemplateSubjectConfig {
  llm?: LLMClient;
  /** Feedback log path. Default: ~/.config/tuner/template_feedback.jsonl. */
  feedbackLog?: string;
  /** Templates dir. Default: ~/.config/tuner/templates. */
  templatesDir?: string;
  /** Injected feedback reader (tests pass fixtures). */
  feedbackReader?: (path: string, since: Date) => Array<Record<string, unknown>>;
}

export class PromptTemplateSubject extends BaseSubject implements RevertibleSubject {
  readonly name = 'prompt_template';
  readonly risk_tier = 'low' as const;
  readonly auto_merge_default = false;
  readonly supports_creation = false;

  private readonly llm?: LLMClient;
  private readonly feedbackLog: string;
  private readonly templatesDir: string;
  private readonly feedbackReader: (path: string, since: Date) => Array<Record<string, unknown>>;

  constructor(opts: PromptTemplateSubjectConfig = {}) {
    super();
    this.llm = opts.llm;
    this.feedbackLog = expandHome(opts.feedbackLog ?? join(homedir(), '.config', 'tuner', 'template_feedback.jsonl'));
    this.templatesDir = expandHome(opts.templatesDir ?? join(homedir(), '.config', 'tuner', 'templates'));
    this.feedbackReader = opts.feedbackReader ?? defaultFeedbackReader;
  }

  async collectObservations(since: Date): Promise<Observation[]> {
    const entries = this.feedbackReader(this.feedbackLog, since);
    if (entries.length === 0) return [];

    const now = new Date();
    const observations: Observation[] = [];
    for (const e of entries) {
      const templateId = String(e['template_id'] ?? '');
      if (!templateId) continue;
      const rating = Number(e['rating'] ?? 0);
      const comment = sanitizeObservationContent(String(e['comment'] ?? ''), 500);

      observations.push({
        session_id: `template-${templateId}-${now.getTime()}-${observations.length}`,
        observed_at: now,
        signal_type: rating <= 2 ? 'correction' : rating >= 4 ? 'positive_feedback' : 'repeated_trigger',
        verbatim: comment,
        metadata: {
          subject: 'prompt_template',
          template_id: templateId,
          rating,
          comment,
        },
      });
    }
    return observations;
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    if (observations.length === 0) return [];
    const byTemplate = new Map<string, Observation[]>();
    for (const obs of observations) {
      const id = (obs.metadata as Record<string, unknown>)['template_id'] as string;
      if (!byTemplate.has(id)) byTemplate.set(id, []);
      byTemplate.get(id)!.push(obs);
    }

    const clusters: Cluster[] = [];
    for (const [id, obs] of byTemplate) {
      if (obs.length < MIN_FEEDBACK_COUNT) continue;
      const avg = obs.reduce((s, o) => s + Number((o.metadata as Record<string, unknown>)['rating'] ?? 0), 0) / obs.length;
      if (avg >= MAX_AVG_RATING_FOR_FLAG) continue;
      clusters.push({
        id: `prompt_template-${id}`,
        subject: 'prompt_template',
        observations: obs,
        frequency: obs.length,
        success_rate: avg / 5,
        sentiment: 'negative',
        subjects_touched: [id],
      });
    }
    return clusters;
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    const templateId = cluster.subjects_touched[0] ?? cluster.id.replace(/^prompt_template-/, '');
    const path = join(this.templatesDir, `${templateId}.md`);

    let current = '';
    if (existsSync(path)) {
      try { current = readFileSync(path, 'utf8'); } catch { current = ''; }
    }

    const concise = current.split('\n').slice(0, Math.max(5, Math.ceil(current.split('\n').length / 2))).join('\n');
    const empathic = current.replace(/^/, 'You are a warm, helpful assistant.\n\n');
    const structured = current.replace(/^/, '## Goals\n\n').replace(/$/, '\n\n## Output format\n- bullet 1\n- bullet 2\n');

    return {
      id: Date.now(),
      cluster_id: cluster.id,
      subject: 'prompt_template',
      kind: 'patch',
      target_path: path,
      alternatives: [
        { id: 'concise', label: 'Concise rewrite (drop preamble)', diff_or_content: concise, tradeoff: 'Faster reads, may lose nuance.' },
        { id: 'empathic', label: 'Empathic rewrite (warmer tone)', diff_or_content: empathic, tradeoff: 'Better UX, slightly longer.' },
        { id: 'structured', label: 'Structured rewrite (Goals + Output format)', diff_or_content: structured, tradeoff: 'Clearer intent, more boilerplate.' },
      ],
      pattern_signature: `prompt_template:${templateId}:${cluster.observations.length}`,
      created_at: new Date(),
    };
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    this.assertInsideTemplatesDir(proposal.target_path);
    const alt = proposal.alternatives.find(a => a.id === alternativeId);
    if (!alt) throw new Error(`prompt-template-subject.apply: alternative ${alternativeId} not found`);

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
    if (typeof patch.applied_content !== 'string' || patch.applied_content.trim().length === 0) {
      return { valid: false, reason: 'applied_content is empty' };
    }
    try {
      this.assertInsideTemplatesDir(patch.target_path);
    } catch (e) {
      return { valid: false, reason: (e as Error).message };
    }

    // If a prior template exists, ensure no placeholders were silently dropped.
    if (existsSync(patch.target_path)) {
      let original: string;
      try { original = readFileSync(patch.target_path, 'utf8'); } catch { original = ''; }
      const originalPlaceholders = extractPlaceholders(original);
      const newPlaceholders = extractPlaceholders(patch.applied_content);
      const dropped = [...originalPlaceholders].filter(p => !newPlaceholders.has(p));
      if (dropped.length > 0) {
        return { valid: false, reason: `dropped placeholders: ${dropped.join(', ')}` };
      }
    }
    return { valid: true };
  }

  async revert(inversePatch: Patch): Promise<void> {
    this.assertInsideTemplatesDir(inversePatch.target_path);
    writeFileSync(inversePatch.target_path, inversePatch.applied_content, 'utf8');
  }

  private assertInsideTemplatesDir(target: string): void {
    const resolved = resolve(target);
    const root = resolve(this.templatesDir);
    if (resolved !== root && !resolved.startsWith(root + '/')) {
      throw new Error(`target_path outside templatesDir: ${target}`);
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function extractPlaceholders(content: string): Set<string> {
  const set = new Set<string>();
  for (const m of content.matchAll(PLACEHOLDER_RE)) set.add(m[1]!);
  return set;
}

function defaultFeedbackReader(path: string, since: Date): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  let content: string;
  try { content = readFileSync(path, 'utf8'); } catch { return []; }
  const out: Array<Record<string, unknown>> = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj !== 'object' || obj === null) continue;
      const ts = (obj as Record<string, unknown>)['ts'];
      if (ts) {
        const tsDate = new Date(ts as string | number);
        if (tsDate < since) continue;
      }
      out.push(obj as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return out;
}
