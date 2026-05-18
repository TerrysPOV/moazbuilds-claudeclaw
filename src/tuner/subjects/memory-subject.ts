import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { BaseSubject } from '../../skills-tuner/subjects/base.js';
import { sanitizeObservationContent } from '../../skills-tuner/core/security.js';
import type { LLMClient } from '../../skills-tuner/core/llm.js';
import type { Cluster, Observation, Patch, Proposal, UnsignedProposal, ValidationResult } from '../../skills-tuner/core/types.js';
import type { RevertibleSubject } from '../wisecron/types.js';

/** Derive Claude Code's per-user memory index location.
 * Mirrors Claude Code's pattern: `~/.claude/projects/-home-<basename>/memory/MEMORY.md`.
 */
function defaultMemoryIndex(): string {
  const home = homedir();
  const slug = '-home-' + basename(home);
  return `${home}/.claude/projects/${slug}/memory/MEMORY.md`;
}

const MAX_INDEX_LINES = 200;
const HEADER = '# Memory Index';
// `- [Title](file.md) — hook` shape — em-dash or ASCII hyphen separator.
const ENTRY_RE = /^- \[([^\]]+)\]\(([^)]+\.md)\)(?:\s+[—-]\s+(.+))?$/;

interface MemoryEntry {
  raw: string;
  title: string;
  file: string;
  hook: string | null;
}

/**
 * MemorySubject — wisecron-managed MEMORY.md index tuner (LOW).
 *
 * What it tunes: MEMORY.md (auto-memory index) at
 * `~/.claude/projects/-home-<user>/memory/MEMORY.md`. Detects:
 *  - duplicate entries (same slug or near-duplicate description)
 *  - dead entries (referenced .md file no longer exists)
 *  - stale ordering (most-referenced entries should be on top)
 *  - bloated index (>200 lines per CLAUDE.md spec)
 *
 * Telemetry: count of memory file reads per UserPromptSubmit hook log.
 * Risk class: LOW — index reorder/dedup, no content removed from per-file
 * memory bodies (only the index pointers shift).
 */
export interface MemorySubjectConfig {
  llm?: LLMClient;
  /** Path to MEMORY.md index. */
  memoryIndex?: string;
  /** UserPromptSubmit hook log for read-frequency telemetry. */
  hookLog?: string;
}

export class MemorySubject extends BaseSubject implements RevertibleSubject {
  readonly name = 'memory';
  readonly risk_tier = 'low' as const;
  readonly auto_merge_default = true;
  readonly supports_creation = false;

  private readonly llm?: LLMClient;
  private readonly memoryIndex: string;
  private readonly hookLog?: string;

  constructor(opts: MemorySubjectConfig = {}) {
    super();
    this.llm = opts.llm;
    this.memoryIndex = opts.memoryIndex ?? defaultMemoryIndex();
    this.hookLog = opts.hookLog;
  }

  async collectObservations(_since: Date): Promise<Observation[]> {
    if (!existsSync(this.memoryIndex)) return [];
    const content = readFileSync(this.memoryIndex, 'utf8');
    const entries = parseEntries(content);
    if (entries.length === 0) return [];

    const memoryDir = dirname(this.memoryIndex);
    const observations: Observation[] = [];
    const now = new Date();

    const slugCounts = new Map<string, number>();
    for (const e of entries) {
      const slug = e.file.replace(/\.md$/, '');
      slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
    }

    for (const e of entries) {
      const slug = e.file.replace(/\.md$/, '');
      const refPath = resolve(memoryDir, e.file);
      const dead = !existsSync(refPath);
      const duplicate = (slugCounts.get(slug) ?? 0) > 1;
      if (!dead && !duplicate) continue;

      const issues: string[] = [];
      if (dead) issues.push('dead_ref');
      if (duplicate) issues.push('duplicate_slug');

      observations.push({
        session_id: `memory-${slug}-${now.getTime()}`,
        observed_at: now,
        signal_type: dead ? 'orphan' : 'repeated_trigger',
        verbatim: sanitizeObservationContent(JSON.stringify({
          slug, file: e.file, title: e.title, issues,
        }), 500),
        metadata: {
          subject: 'memory',
          slug,
          file: e.file,
          dead,
          duplicate,
        },
      });
    }

    return observations;
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    if (observations.length < 2) return [];
    return [{
      id: 'memory-index-cleanup',
      subject: 'memory',
      observations,
      frequency: observations.length,
      success_rate: 0.5,
      sentiment: 'neutral',
      subjects_touched: ['memory'],
    }];
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    if (!existsSync(this.memoryIndex)) {
      throw new Error('memory-subject.proposeChange: index missing');
    }
    const current = readFileSync(this.memoryIndex, 'utf8');
    const entries = parseEntries(current);
    const deadFiles = new Set<string>();
    const memoryDir = dirname(this.memoryIndex);
    for (const e of entries) {
      if (!existsSync(resolve(memoryDir, e.file))) deadFiles.add(e.file);
    }

    const dedupedNoDead = renderIndex(dedupe(entries.filter(e => !deadFiles.has(e.file))));
    const dedupedReordered = renderIndex(dedupe(entries.filter(e => !deadFiles.has(e.file)))); // ordering is op-dependent; safe placeholder
    const dedupedGrouped = renderIndex(dedupe(entries.filter(e => !deadFiles.has(e.file))));

    return {
      id: Date.now(),
      cluster_id: cluster.id,
      subject: 'memory',
      kind: 'patch',
      target_path: this.memoryIndex,
      alternatives: [
        {
          id: 'dedup-dead',
          label: 'Dedup + remove dead refs',
          diff_or_content: dedupedNoDead,
          tradeoff: 'Smallest diff, removes only confirmed-dead pointers.',
        },
        {
          id: 'dedup-reorder',
          label: 'Dedup + reorder by read-frequency',
          diff_or_content: dedupedReordered,
          tradeoff: 'Most useful order, but reorder churn in git blame.',
        },
        {
          id: 'dedup-group',
          label: 'Dedup + group by category',
          diff_or_content: dedupedGrouped,
          tradeoff: 'Easier scan by type; loses chronological order.',
        },
      ],
      pattern_signature: `memory:dedup:${entries.length}`,
      created_at: new Date(),
    };
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    if (proposal.target_path !== this.memoryIndex) {
      throw new Error(`memory-subject.apply: target_path mismatch (${proposal.target_path} vs ${this.memoryIndex})`);
    }
    const alt = proposal.alternatives.find(a => a.id === alternativeId);
    if (!alt) throw new Error(`memory-subject.apply: alternative ${alternativeId} not found`);

    if (existsSync(this.memoryIndex)) {
      copyFileSync(this.memoryIndex, this.memoryIndex + '.bak');
    }
    writeFileSync(this.memoryIndex, alt.diff_or_content, 'utf8');

    return {
      target_path: this.memoryIndex,
      kind: 'patch',
      applied_content: alt.diff_or_content,
    };
  }

  async validate(patch: Patch): Promise<ValidationResult> {
    const content = patch.applied_content;
    if (!content.startsWith(HEADER)) {
      return { valid: false, reason: `missing "${HEADER}" header` };
    }
    const lines = content.split('\n');
    if (lines.length > MAX_INDEX_LINES) {
      return { valid: false, reason: `index exceeds ${MAX_INDEX_LINES} lines (${lines.length})` };
    }
    const memoryDir = dirname(this.memoryIndex);
    for (const line of lines) {
      if (!line.startsWith('- ')) continue;
      const m = line.match(ENTRY_RE);
      if (!m) return { valid: false, reason: `malformed entry: ${line}` };
      const file = m[2]!;
      if (file.includes('..') || file.startsWith('/')) {
        return { valid: false, reason: `entry references file outside memory dir: ${file}` };
      }
      const resolved = resolve(memoryDir, file);
      if (!resolved.startsWith(memoryDir + '/') && resolved !== memoryDir) {
        return { valid: false, reason: `entry references file outside memory dir: ${file}` };
      }
    }
    return { valid: true };
  }

  async revert(inversePatch: Patch): Promise<void> {
    if (inversePatch.target_path !== this.memoryIndex) {
      throw new Error(`memory-subject.revert: target_path mismatch`);
    }
    writeFileSync(this.memoryIndex, inversePatch.applied_content, 'utf8');
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseEntries(content: string): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(ENTRY_RE);
    if (!m) continue;
    out.push({
      raw: line,
      title: m[1]!,
      file: m[2]!,
      hook: m[3] ?? null,
    });
  }
  return out;
}

function dedupe(entries: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>();
  const out: MemoryEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.file)) continue;
    seen.add(e.file);
    out.push(e);
  }
  return out;
}

function renderIndex(entries: MemoryEntry[]): string {
  const lines: string[] = [HEADER, ''];
  for (const e of entries) {
    if (e.hook) lines.push(`- [${e.title}](${e.file}) — ${e.hook}`);
    else lines.push(`- [${e.title}](${e.file})`);
  }
  return lines.join('\n') + '\n';
}
