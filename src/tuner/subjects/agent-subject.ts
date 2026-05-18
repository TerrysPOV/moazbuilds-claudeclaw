import { existsSync, copyFileSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { BaseSubject } from '../../skills-tuner/subjects/base.js';
import { sanitizeObservationContent } from '../../skills-tuner/core/security.js';
import type { LLMClient } from '../../skills-tuner/core/llm.js';
import type { Cluster, Observation, Patch, Proposal, UnsignedProposal, ValidationResult } from '../../skills-tuner/core/types.js';
import type { RevertibleSubject } from '../wisecron/types.js';

const DEAD_AGENT_AGE_DAYS = 180;
const RECLASSIFY_RATE_THRESHOLD = 0.4;
const MIN_DESC_LEN = 30;
const MAX_DESC_LEN = 500;

/**
 * AgentSubject — wisecron-managed sub-agent description tuner (LOW).
 */
export interface AgentInvocationStats {
  /** Total invocations of the agent during the window. */
  invocations: number;
  /** Times the orchestrator reclassified after picking this agent. */
  reclassifies: number;
}

export interface AgentSubjectConfig {
  llm?: LLMClient;
  /** Agents dir. Default: ~/.claude/agents. */
  agentsDir?: string;
  /**
   * Injected stats lookup keyed by agent name. Tests pass a fixture map.
   * Default returns zeros (no invocations).
   */
  statsProvider?: (agentName: string, since: Date) => AgentInvocationStats;
}

export class AgentSubject extends BaseSubject implements RevertibleSubject {
  readonly name = 'agent';
  readonly risk_tier = 'low' as const;
  readonly auto_merge_default = false;
  readonly supports_creation = false;

  private readonly llm?: LLMClient;
  private readonly agentsDir: string;
  private readonly statsProvider: (agentName: string, since: Date) => AgentInvocationStats;

  constructor(opts: AgentSubjectConfig = {}) {
    super();
    this.llm = opts.llm;
    this.agentsDir = expandHome(opts.agentsDir ?? join(homedir(), '.claude', 'agents'));
    this.statsProvider = opts.statsProvider ?? (() => ({ invocations: 0, reclassifies: 0 }));
  }

  async collectObservations(since: Date): Promise<Observation[]> {
    if (!existsSync(this.agentsDir)) return [];
    const files = await this.scanMdFiles(this.agentsDir);
    if (files.length === 0) return [];

    const now = new Date();
    const observations: Observation[] = [];

    for (const file of files) {
      const { frontmatter } = await this.loadFrontmatter(file);
      const name = (frontmatter['name'] as string) ?? basename(file, '.md');
      const description = (frontmatter['description'] as string) ?? '';
      const stats = this.statsProvider(name, since);

      let mtime: Date;
      try { mtime = statSync(file).mtime; } catch { mtime = now; }
      const ageDays = (now.getTime() - mtime.getTime()) / 86_400_000;

      const reclassifyRate = stats.invocations === 0 ? 0 : stats.reclassifies / stats.invocations;
      const dead = stats.invocations === 0 && ageDays > DEAD_AGENT_AGE_DAYS;
      const tooBroad = reclassifyRate > RECLASSIFY_RATE_THRESHOLD;

      if (!dead && !tooBroad) continue;

      observations.push({
        session_id: `agent-${name}-${now.getTime()}`,
        observed_at: now,
        signal_type: dead ? 'orphan' : 'correction',
        verbatim: sanitizeObservationContent(JSON.stringify({
          name,
          description: description.slice(0, 200),
          invocations: stats.invocations,
          reclassifies: stats.reclassifies,
          reclassify_rate: Math.round(reclassifyRate * 100) / 100,
          age_days: Math.round(ageDays),
          dead, too_broad: tooBroad,
        }), 500),
        metadata: {
          subject: 'agent',
          agent: name,
          path: file,
          dead,
          too_broad: tooBroad,
          reclassify_rate: reclassifyRate,
          invocations: stats.invocations,
        },
      });
    }
    return observations;
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    if (observations.length === 0) return [];

    const dead: Observation[] = [];
    const broad: Observation[] = [];
    for (const obs of observations) {
      const meta = obs.metadata as Record<string, unknown>;
      if (meta['dead']) dead.push(obs);
      if (meta['too_broad']) broad.push(obs);
    }
    const clusters: Cluster[] = [];
    if (dead.length > 0) {
      clusters.push({
        id: 'agent-dead',
        subject: 'agent',
        observations: dead,
        frequency: dead.length,
        success_rate: 0.0,
        sentiment: 'neutral',
        subjects_touched: dead.map(o => (o.metadata as Record<string, unknown>)['agent'] as string),
      });
    }
    if (broad.length > 0) {
      clusters.push({
        id: 'agent-too-broad',
        subject: 'agent',
        observations: broad,
        frequency: broad.length,
        success_rate: 0.4,
        sentiment: 'negative',
        subjects_touched: broad.map(o => (o.metadata as Record<string, unknown>)['agent'] as string),
      });
    }
    return clusters;
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    const firstObs = cluster.observations[0];
    if (!firstObs) throw new Error('agent-subject.proposeChange: cluster empty');
    const meta = firstObs.metadata as Record<string, unknown>;
    const name = meta['agent'] as string;
    const path = meta['path'] as string;

    let current = '';
    if (existsSync(path)) {
      try { current = readFileSync(path, 'utf8'); } catch { current = ''; }
    }
    const original = current || `---\nname: ${name}\ndescription: ${name} agent\n---\n`;

    const tightenedDesc = `${name} agent — narrow scope; triggers ONLY on explicit "${name}" mentions or its primary command.`;
    const broadenedDesc = `${name} agent — wide scope; triggers on any request related to ${name} domain or adjacent tasks where ${name} expertise applies.`;

    return {
      id: Date.now(),
      cluster_id: cluster.id,
      subject: 'agent',
      kind: 'patch',
      target_path: path,
      alternatives: [
        { id: 'tighten', label: 'Tighten description (more specific triggers)', diff_or_content: rewriteDescription(original, tightenedDesc), tradeoff: 'Fewer false matches, may miss valid ones.' },
        { id: 'broaden', label: 'Broaden description (capture more triggers)', diff_or_content: rewriteDescription(original, broadenedDesc), tradeoff: 'Catches more cases, risks reclassification.' },
        { id: 'disable', label: 'Disable agent (move to disabled/)', diff_or_content: `---\nname: ${name}\ndescription: DISABLED — moved by wisecron, no triggers.\n---\n`, tradeoff: 'Removes from rotation entirely.' },
      ],
      pattern_signature: `agent:${cluster.id}:${name}`,
      created_at: new Date(),
    };
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    this.assertInsideAgentsDir(proposal.target_path);
    const alt = proposal.alternatives.find(a => a.id === alternativeId);
    if (!alt) throw new Error(`agent-subject.apply: alternative ${alternativeId} not found`);

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
      this.assertInsideAgentsDir(patch.target_path);
    } catch (e) {
      return { valid: false, reason: (e as Error).message };
    }
    const fm = parseFrontmatter(patch.applied_content);
    if (!fm || typeof fm['name'] !== 'string' || typeof fm['description'] !== 'string') {
      return { valid: false, reason: 'frontmatter missing name or description' };
    }
    const descLen = (fm['description'] as string).length;
    if (descLen < MIN_DESC_LEN || descLen > MAX_DESC_LEN) {
      return { valid: false, reason: `description length ${descLen} outside [${MIN_DESC_LEN}, ${MAX_DESC_LEN}]` };
    }
    return { valid: true };
  }

  async revert(inversePatch: Patch): Promise<void> {
    this.assertInsideAgentsDir(inversePatch.target_path);
    writeFileSync(inversePatch.target_path, inversePatch.applied_content, 'utf8');
  }

  private assertInsideAgentsDir(target: string): void {
    const resolved = resolve(target);
    const root = resolve(this.agentsDir);
    if (resolved !== root && !resolved.startsWith(root + '/')) {
      throw new Error(`target_path outside agentsDir: ${target}`);
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  const out: Record<string, unknown> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (m) out[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function rewriteDescription(content: string, newDescription: string): string {
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)([\s\S]*)$/);
  if (!fmMatch) {
    return `---\nname: agent\ndescription: ${newDescription}\n---\n`;
  }
  const [, open, body, close, rest] = fmMatch;
  let replaced = false;
  const newBody = body!.split(/\r?\n/).map(line => {
    if (line.startsWith('description:')) {
      replaced = true;
      return `description: ${newDescription}`;
    }
    return line;
  }).join('\n');
  const finalBody = replaced ? newBody : newBody + `\ndescription: ${newDescription}`;
  return `${open}${finalBody}${close}${rest}`;
}
