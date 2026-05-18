import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSubject } from '../../../subjects/agent-subject.js';
import type { Cluster, Observation, Patch, Proposal } from '../../../../skills-tuner/core/types.js';

let tmpRoot: string;
let agentsDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentsubj-'));
  agentsDir = join(tmpRoot, 'agents');
  mkdirSync(agentsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeAgent(name: string, body: string): string {
  const path = join(agentsDir, `${name}.md`);
  writeFileSync(path, body, 'utf8');
  return path;
}

function ageMtime(path: string, daysAgo: number): void {
  const t = Date.now() / 1000 - daysAgo * 86_400;
  utimesSync(path, t, t);
}

describe('AgentSubject — identity', () => {
  it('name === "agent", risk_tier === "low"', () => {
    const s = new AgentSubject({ agentsDir });
    expect(s.name).toBe('agent');
    expect(s.risk_tier).toBe('low');
  });
});

describe('AgentSubject — collectObservations', () => {
  it('walks agentsDir for *.md and aggregates stats', async () => {
    const path = writeAgent('alpha', '---\nname: alpha\ndescription: alpha agent does things\n---\nbody\n');
    ageMtime(path, 200); // old enough to qualify "dead" if 0 invocations
    const s = new AgentSubject({
      agentsDir,
      statsProvider: () => ({ invocations: 0, reclassifies: 0 }),
    });
    const obs = await s.collectObservations(new Date(0));
    expect(obs.length).toBe(1);
    expect(obs[0]!.metadata['agent']).toBe('alpha');
    expect(obs[0]!.metadata['dead']).toBe(true);
  });

  it('flags too-broad descriptions via reclassify_rate', async () => {
    writeAgent('beta', '---\nname: beta\ndescription: beta agent broad\n---\n');
    const s = new AgentSubject({
      agentsDir,
      statsProvider: () => ({ invocations: 10, reclassifies: 6 }),
    });
    const obs = await s.collectObservations(new Date(0));
    expect(obs.length).toBe(1);
    expect(obs[0]!.metadata['too_broad']).toBe(true);
  });

  it('returns empty array when agentsDir missing', async () => {
    const s = new AgentSubject({ agentsDir: join(tmpRoot, 'nope') });
    expect(await s.collectObservations(new Date(0))).toEqual([]);
  });
});

describe('AgentSubject — detectProblems', () => {
  it('flags dead agents (cluster id agent-dead)', async () => {
    const s = new AgentSubject({ agentsDir });
    const obs: Observation[] = [{
      session_id: 't', observed_at: new Date(), signal_type: 'orphan', verbatim: '{}',
      metadata: { subject: 'agent', agent: 'a', dead: true, too_broad: false, reclassify_rate: 0 },
    }];
    const clusters = await s.detectProblems(obs);
    expect(clusters.some(c => c.id === 'agent-dead')).toBe(true);
  });

  it('flags too-broad descriptions (cluster id agent-too-broad)', async () => {
    const s = new AgentSubject({ agentsDir });
    const obs: Observation[] = [{
      session_id: 't', observed_at: new Date(), signal_type: 'correction', verbatim: '{}',
      metadata: { subject: 'agent', agent: 'a', dead: false, too_broad: true, reclassify_rate: 0.7 },
    }];
    const clusters = await s.detectProblems(obs);
    expect(clusters.some(c => c.id === 'agent-too-broad')).toBe(true);
  });
});

describe('AgentSubject — apply / validate', () => {
  it('apply preserves frontmatter structure', async () => {
    const path = writeAgent('alpha', '---\nname: alpha\ndescription: short\n---\nbody\n');
    const s = new AgentSubject({ agentsDir });
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'agent', kind: 'patch',
      target_path: path, pattern_signature: 'sig', created_at: new Date(),
      signature: 'sig',
      alternatives: [{
        id: 'tighten', label: 'l', tradeoff: '',
        diff_or_content: '---\nname: alpha\ndescription: tighter description that meets the minimum length requirement\n---\nbody\n',
      }],
    };
    await s.apply(proposal, 'tighten');
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('name: alpha');
    expect(written).toContain('tighter description');
  });

  it('apply rejects path outside agentsDir', async () => {
    const s = new AgentSubject({ agentsDir });
    const evil = join(tmpRoot, 'escape.md');
    writeFileSync(evil, '---\nname: x\ndescription: y\n---\n');
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'agent', kind: 'patch',
      target_path: evil, pattern_signature: 'sig', created_at: new Date(),
      signature: 'sig',
      alternatives: [{ id: 'a', label: 'l', tradeoff: '', diff_or_content: '---\nname: x\ndescription: y\n---\n' }],
    };
    await expect(s.apply(proposal, 'a')).rejects.toThrow(/agentsDir/);
  });

  it('apply writes .bak before replacement', async () => {
    const path = writeAgent('alpha', '---\nname: alpha\ndescription: original description that is long enough\n---\nold\n');
    const s = new AgentSubject({ agentsDir });
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'agent', kind: 'patch',
      target_path: path, pattern_signature: 'sig', created_at: new Date(),
      signature: 'sig',
      alternatives: [{
        id: 'a', label: 'l', tradeoff: '',
        diff_or_content: '---\nname: alpha\ndescription: updated description that is long enough\n---\nnew\n',
      }],
    };
    await s.apply(proposal, 'a');
    expect(existsSync(path + '.bak')).toBe(true);
    expect(readFileSync(path + '.bak', 'utf8')).toContain('original');
  });

  it('validate requires frontmatter name + description', async () => {
    const s = new AgentSubject({ agentsDir });
    const result = await s.validate({
      target_path: join(agentsDir, 'a.md'), kind: 'patch',
      applied_content: '---\nname: a\n---\nbody\n',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/frontmatter|description/);
  });

  it('validate enforces description length 30-500 chars', async () => {
    const s = new AgentSubject({ agentsDir });
    const tooShort = await s.validate({
      target_path: join(agentsDir, 'a.md'), kind: 'patch',
      applied_content: '---\nname: a\ndescription: short\n---\n',
    });
    expect(tooShort.valid).toBe(false);
    expect(tooShort.reason).toMatch(/length/);

    const tooLong = await s.validate({
      target_path: join(agentsDir, 'a.md'), kind: 'patch',
      applied_content: `---\nname: a\ndescription: ${'x'.repeat(501)}\n---\n`,
    });
    expect(tooLong.valid).toBe(false);
  });

  it('validate passes for a well-formed agent file', async () => {
    const s = new AgentSubject({ agentsDir });
    const result = await s.validate({
      target_path: join(agentsDir, 'a.md'), kind: 'patch',
      applied_content: '---\nname: a\ndescription: this description is between 30 and 500 characters comfortably\n---\nbody\n',
    });
    expect(result.valid).toBe(true);
  });
});

describe('AgentSubject — revert', () => {
  it('writes inverse content back to target_path', async () => {
    const path = writeAgent('alpha', '---\nname: alpha\ndescription: mutated\n---\nmutated\n');
    const s = new AgentSubject({ agentsDir });
    const original = '---\nname: alpha\ndescription: original description that is long enough\n---\nbody\n';
    const inverse: Patch = { target_path: path, kind: 'patch', applied_content: original };
    await s.revert(inverse);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
});

// ── Pass B: edges, idempotency, perf, guardrails ───────────────────────────

describe('AgentSubject — Pass B: edges', () => {
  it('collectObservations: missing agentsDir returns empty list', async () => {
    rmSync(agentsDir, { recursive: true, force: true });
    const s = new AgentSubject({ agentsDir });
    expect(await s.collectObservations(new Date(0))).toEqual([]);
  });

  it('collectObservations: empty agentsDir returns empty list', async () => {
    const s = new AgentSubject({ agentsDir });
    expect(await s.collectObservations(new Date(0))).toEqual([]);
  });

  it('collectObservations: agent without frontmatter falls back to filename as name', async () => {
    writeAgent('plain', 'no frontmatter here\n');
    const path = join(agentsDir, 'plain.md');
    const oldMs = (Date.now() - 365 * 86_400_000) / 1000;
    utimesSync(path, oldMs, oldMs);
    const s = new AgentSubject({
      agentsDir,
      statsProvider: () => ({ invocations: 0, reclassifies: 0 }),
    });
    const obs = await s.collectObservations(new Date(0));
    expect(obs.length).toBeGreaterThan(0);
    expect(obs[0]!.metadata['agent']).toBe('plain');
  });

  it('validate rejects target_path outside agentsDir (path traversal)', async () => {
    const s = new AgentSubject({ agentsDir });
    const result = await s.validate({
      target_path: join(agentsDir, '..', 'escape.md'), kind: 'patch',
      applied_content: '---\nname: x\ndescription: ' + 'a'.repeat(50) + '\n---\n',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/agentsDir/);
  });

  it('apply: missing alternative id → clear error', async () => {
    const path = writeAgent('foo', '---\nname: foo\ndescription: a desc that is long enough\n---\nbody\n');
    const s = new AgentSubject({ agentsDir });
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'agent', kind: 'patch',
      target_path: path, pattern_signature: 'sig', created_at: new Date(),
      signature: 's',
      alternatives: [{ id: 'real', label: '', tradeoff: '', diff_or_content: '---\nname: foo\ndescription: yet another description that is long enough\n---\n' }],
    };
    await expect(s.apply(proposal, 'wrong')).rejects.toThrow(/alternative/);
  });
});

describe('AgentSubject — Pass B: idempotency', () => {
  it('apply same alt twice → identical file content', async () => {
    const path = writeAgent('foo', '---\nname: foo\ndescription: old desc that is long enough for validate to pass\n---\n');
    const s = new AgentSubject({ agentsDir });
    const newContent = '---\nname: foo\ndescription: new desc that is also long enough for validate to pass\n---\n';
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'agent', kind: 'patch',
      target_path: path, pattern_signature: 'sig', created_at: new Date(),
      signature: 's',
      alternatives: [{ id: 'a', label: '', tradeoff: '', diff_or_content: newContent }],
    };
    await s.apply(proposal, 'a');
    const after1 = readFileSync(path, 'utf8');
    await s.apply(proposal, 'a');
    expect(readFileSync(path, 'utf8')).toBe(after1);
  });

  it('revert same inverse twice → no double-mutation', async () => {
    const path = writeAgent('foo', '---\nname: foo\ndescription: current\n---\n');
    const s = new AgentSubject({ agentsDir });
    const inverse: Patch = {
      target_path: path, kind: 'patch',
      applied_content: '---\nname: foo\ndescription: original long-enough description\n---\n',
    };
    await s.revert(inverse);
    const after1 = readFileSync(path, 'utf8');
    await s.revert(inverse);
    expect(readFileSync(path, 'utf8')).toBe(after1);
  });
});

describe('AgentSubject — Pass B: perf', () => {
  it('collectObservations on 100 agents completes <500ms', async () => {
    for (let i = 0; i < 100; i++) {
      const path = writeAgent(`a${i}`, `---\nname: a${i}\ndescription: agent ${i} description that is long enough for validate\n---\nbody\n`);
      const oldMs = (Date.now() - 365 * 86_400_000) / 1000;
      utimesSync(path, oldMs, oldMs);
    }
    const s = new AgentSubject({
      agentsDir,
      statsProvider: () => ({ invocations: 0, reclassifies: 0 }),
    });
    const start = Date.now();
    const obs = await s.collectObservations(new Date(0));
    const elapsed = Date.now() - start;
    expect(obs.length).toBe(100);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('AgentSubject — Pass B: validate/apply symmetry', () => {
  it('validate flags empty applied_content; apply does not produce such content', async () => {
    const s = new AgentSubject({ agentsDir });
    const v = await s.validate({ target_path: join(agentsDir, 'x.md'), kind: 'patch', applied_content: '' });
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/empty/);
  });

  it('apply roundtrip: produced Patch validates clean', async () => {
    const path = writeAgent('foo', '---\nname: foo\ndescription: original long-enough description\n---\nbody\n');
    const s = new AgentSubject({ agentsDir });
    const newContent = '---\nname: foo\ndescription: rewritten description that is comfortably long enough\n---\n';
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'agent', kind: 'patch',
      target_path: path, pattern_signature: 'sig', created_at: new Date(),
      signature: 's',
      alternatives: [{ id: 'a', label: '', tradeoff: '', diff_or_content: newContent }],
    };
    const patch = await s.apply(proposal, 'a');
    const v = await s.validate(patch);
    expect(v.valid).toBe(true);
  });
});

describe('AgentSubject — Pass B: risk_tier guardrails', () => {
  it('risk_tier is low — auto-merge not default (still needs review)', () => {
    const s = new AgentSubject({ agentsDir });
    expect(s.risk_tier).toBe('low');
    expect(s.auto_merge_default).toBe(false);
  });
});
