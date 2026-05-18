import { existsSync, copyFileSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BaseSubject } from '../../skills-tuner/subjects/base.js';
import { sanitizeObservationContent } from '../../skills-tuner/core/security.js';
import type { LLMClient } from '../../skills-tuner/core/llm.js';
import type { Cluster, Observation, Patch, Proposal, UnsignedProposal, ValidationResult } from '../../skills-tuner/core/types.js';
import type { RevertibleSubject } from '../wisecron/types.js';

const STALE_DAYS = 180;
const IMPORT_RE = /^@(\S+)/gm;

/**
 * ClaudeMdSubject — wisecron-managed CLAUDE.md per-project tuner (MEDIUM).
 *
 * Detects broken @-imports, stale sections (mtime > 180d), and proposes
 * fix/consolidate/trim alternatives. Targets are constrained to the
 * configured projectRoots to prevent path traversal at apply time.
 */
export interface ClaudeMdSubjectConfig {
  llm?: LLMClient;
  /** Project roots to scan. Default: ['~/agent', '~/Projects']. */
  projectRoots?: string[];
}

export class ClaudeMdSubject extends BaseSubject implements RevertibleSubject {
  readonly name = 'claude_md';
  readonly risk_tier = 'medium' as const;
  readonly auto_merge_default = false;
  readonly supports_creation = false;

  private readonly llm?: LLMClient;
  private readonly projectRoots: string[];

  constructor(opts: ClaudeMdSubjectConfig = {}) {
    super();
    this.llm = opts.llm;
    const roots = opts.projectRoots ?? ['~/agent', '~/Projects'];
    this.projectRoots = roots.map(r => resolve(expandHome(r)));
  }

  async collectObservations(_since: Date): Promise<Observation[]> {
    const observations: Observation[] = [];
    const now = new Date();

    for (const root of this.projectRoots) {
      if (!existsSync(root)) continue;
      const files = findClaudeMdFiles(root);
      for (const file of files) {
        let content: string;
        let mtime: Date;
        try {
          content = readFileSync(file, 'utf8');
          mtime = statSync(file).mtime;
        } catch {
          continue;
        }
        const broken = brokenImports(content, dirname(file));
        const ageDays = (now.getTime() - mtime.getTime()) / 86_400_000;
        const staleSections = ageDays > STALE_DAYS
          ? countSections(content)
          : 0;

        if (broken.length === 0 && staleSections < 2) continue;

        observations.push({
          session_id: `claude_md-${file}-${now.getTime()}`,
          observed_at: now,
          signal_type: broken.length > 0 ? 'correction' : 'orphan',
          verbatim: sanitizeObservationContent(JSON.stringify({
            file,
            broken_imports: broken,
            stale_sections: staleSections,
            age_days: Math.round(ageDays),
          }), 500),
          metadata: {
            subject: 'claude_md',
            file,
            broken_imports: broken,
            broken_count: broken.length,
            stale_sections: staleSections,
          },
        });
      }
    }
    return observations;
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    if (observations.length === 0) return [];
    const clusters: Cluster[] = [];
    for (const obs of observations) {
      const meta = obs.metadata as Record<string, unknown>;
      const brokenCount = (meta['broken_count'] as number | undefined) ?? 0;
      const staleSections = (meta['stale_sections'] as number | undefined) ?? 0;
      if (brokenCount < 1 && staleSections < 2) continue;
      clusters.push({
        id: `claude_md-${(meta['file'] as string).replace(/[^a-zA-Z0-9_-]+/g, '_')}`,
        subject: 'claude_md',
        observations: [obs],
        frequency: 1,
        success_rate: brokenCount > 0 ? 0.2 : 0.5,
        sentiment: brokenCount > 0 ? 'negative' : 'neutral',
        subjects_touched: [meta['file'] as string],
      });
    }
    return clusters;
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    const firstObs = cluster.observations[0];
    if (!firstObs) throw new Error('claude-md-subject.proposeChange: cluster empty');
    const file = (firstObs.metadata as Record<string, unknown>)['file'] as string;
    const brokenImports = (firstObs.metadata as Record<string, unknown>)['broken_imports'] as string[] ?? [];

    let current = '';
    if (existsSync(file)) {
      try { current = readFileSync(file, 'utf8'); } catch { current = ''; }
    }

    const fixed = current.split('\n').filter(line => {
      const m = line.match(/^@(\S+)/);
      if (!m) return true;
      return !brokenImports.includes(m[1]!);
    }).join('\n');

    const trimmed = current.split(/\n## /).slice(0, 5).join('\n## '); // keep first ~5 sections

    return {
      id: Date.now(),
      cluster_id: cluster.id,
      subject: 'claude_md',
      kind: 'patch',
      target_path: file,
      alternatives: [
        { id: 'fix-imports', label: 'Remove broken @-imports', diff_or_content: fixed, tradeoff: 'Quickest fix; consolidation deferred.' },
        { id: 'consolidate', label: 'Consolidate nested CLAUDE.md content', diff_or_content: fixed, tradeoff: 'Single-source clarity; bigger diff.' },
        { id: 'trim', label: 'Trim stale sections', diff_or_content: trimmed, tradeoff: 'Smaller file; some context lost.' },
      ],
      pattern_signature: `claude_md:${cluster.id}`,
      created_at: new Date(),
    };
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    this.assertInsideProjectRoots(proposal.target_path);
    const alt = proposal.alternatives.find(a => a.id === alternativeId);
    if (!alt) throw new Error(`claude-md-subject.apply: alternative ${alternativeId} not found`);

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
    if (typeof patch.applied_content !== 'string') {
      return { valid: false, reason: 'applied_content not a string' };
    }
    try {
      this.assertInsideProjectRoots(patch.target_path);
    } catch (e) {
      return { valid: false, reason: (e as Error).message };
    }
    const baseDir = dirname(patch.target_path);
    const escaping = escapingImports(patch.applied_content, baseDir, this.projectRoots);
    if (escaping.length > 0) {
      return { valid: false, reason: `@-imports escape projectRoots: ${escaping.join(', ')}` };
    }
    const unresolved = brokenImports(patch.applied_content, baseDir);
    if (unresolved.length > 0) {
      return { valid: false, reason: `unresolvable @-imports: ${unresolved.join(', ')}` };
    }
    return { valid: true };
  }

  async revert(inversePatch: Patch): Promise<void> {
    this.assertInsideProjectRoots(inversePatch.target_path);
    const bak = inversePatch.target_path + '.bak';
    if (existsSync(bak)) {
      copyFileSync(bak, inversePatch.target_path);
    } else {
      writeFileSync(inversePatch.target_path, inversePatch.applied_content, 'utf8');
    }
  }

  private assertInsideProjectRoots(target: string): void {
    const resolved = resolve(target);
    for (const root of this.projectRoots) {
      if (resolved === root || resolved.startsWith(root + '/')) return;
    }
    throw new Error(`target_path outside projectRoots: ${target}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function findClaudeMdFiles(root: string): string[] {
  const out: string[] = [];
  walk(root, out, 0);
  return out;
}

function walk(dir: string, out: string[], depth: number): void {
  if (depth > 5) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (e.isFile() && e.name === 'CLAUDE.md') out.push(full);
  }
}

function brokenImports(content: string, baseDir: string): string[] {
  const broken: string[] = [];
  for (const m of content.matchAll(IMPORT_RE)) {
    const ref = m[1]!;
    const target = ref.startsWith('~/') ? join(homedir(), ref.slice(2)) : resolve(baseDir, ref);
    if (!existsSync(target)) broken.push(ref);
  }
  return broken;
}

function escapingImports(content: string, baseDir: string, projectRoots: string[]): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(IMPORT_RE)) {
    const ref = m[1]!;
    // `~/foo` imports resolve against os.homedir() and are only flagged as
    // escapes when the resolved path lies outside the operator's configured
    // projectRoots — so `@~/agent/x.md` is OK with `~/agent` in roots, while
    // `@~/x.md` with non-home roots is flagged.
    const target = ref.startsWith('~/') ? join(homedir(), ref.slice(2)) : resolve(baseDir, ref);
    const inside = projectRoots.some(root => target === root || target.startsWith(root + '/'));
    if (!inside) out.push(ref);
  }
  return out;
}

function countSections(content: string): number {
  let count = 0;
  for (const line of content.split('\n')) {
    if (/^#{1,3}\s/.test(line)) count += 1;
  }
  return count;
}
