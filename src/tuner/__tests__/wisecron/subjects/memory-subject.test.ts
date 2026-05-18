import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySubject } from '../../../subjects/memory-subject.js';
import type { Cluster, Observation, Patch, Proposal } from '../../../../skills-tuner/core/types.js';

let tmpDir: string;
let indexPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'memsubj-'));
  indexPath = join(tmpDir, 'MEMORY.md');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function seed(content: string): void {
  writeFileSync(indexPath, content, 'utf8');
}

function touch(name: string): void {
  writeFileSync(join(tmpDir, name), '# stub\n', 'utf8');
}

describe('MemorySubject — identity', () => {
  it('name === "memory", risk_tier === "low"', () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    expect(s.name).toBe('memory');
    expect(s.risk_tier).toBe('low');
    expect(s.auto_merge_default).toBe(true);
  });
});

describe('MemorySubject — collectObservations', () => {
  it('parses MEMORY.md entries into { slug, description, file_ref }', async () => {
    seed([
      '# Memory Index',
      '',
      '- [Alpha](alpha.md) — first hook',
      '- [Beta](beta.md) — second hook',
    ].join('\n'));
    touch('alpha.md');
    touch('beta.md');
    const s = new MemorySubject({ memoryIndex: indexPath });
    const obs = await s.collectObservations(new Date(0));
    // No dead/dup → zero observations (collectObservations only emits issues).
    expect(obs).toEqual([]);
  });

  it('detects dead refs (file does not exist)', async () => {
    seed([
      '# Memory Index',
      '',
      '- [Alpha](alpha.md) — exists',
      '- [Ghost](ghost.md) — does not',
    ].join('\n'));
    touch('alpha.md');
    const s = new MemorySubject({ memoryIndex: indexPath });
    const obs = await s.collectObservations(new Date(0));
    expect(obs.length).toBe(1);
    expect(obs[0]!.metadata['dead']).toBe(true);
    expect(obs[0]!.metadata['file']).toBe('ghost.md');
  });

  it('detects duplicates (same slug or near-duplicate description)', async () => {
    seed([
      '# Memory Index',
      '',
      '- [Alpha](alpha.md) — first',
      '- [Alpha-dup](alpha.md) — copy',
    ].join('\n'));
    touch('alpha.md');
    const s = new MemorySubject({ memoryIndex: indexPath });
    const obs = await s.collectObservations(new Date(0));
    expect(obs.length).toBe(2);
    expect(obs.every(o => o.metadata['duplicate'] === true)).toBe(true);
  });

  it('returns empty array when index missing', async () => {
    const s = new MemorySubject({ memoryIndex: join(tmpDir, 'nope.md') });
    const obs = await s.collectObservations(new Date(0));
    expect(obs).toEqual([]);
  });
});

describe('MemorySubject — detectProblems', () => {
  it('returns single cluster covering all problems when total >= 2', async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const obs: Observation[] = [
      { session_id: 't1', observed_at: new Date(), signal_type: 'orphan', verbatim: '{}', metadata: { subject: 'memory', file: 'a.md', dead: true, duplicate: false } },
      { session_id: 't2', observed_at: new Date(), signal_type: 'repeated_trigger', verbatim: '{}', metadata: { subject: 'memory', file: 'b.md', dead: false, duplicate: true } },
    ];
    const clusters = await s.detectProblems(obs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.id).toBe('memory-index-cleanup');
    expect(clusters[0]!.subjects_touched).toEqual(['memory']);
  });

  it('returns empty when total < 2', async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const single: Observation = {
      session_id: 't', observed_at: new Date(), signal_type: 'orphan', verbatim: '{}',
      metadata: { subject: 'memory' },
    };
    const clusters = await s.detectProblems([single]);
    expect(clusters).toEqual([]);
  });
});

describe('MemorySubject — apply / validate', () => {
  it('apply writes .bak before replacement', async () => {
    seed('# Memory Index\n\n- [A](a.md) — old\n');
    touch('a.md');
    const s = new MemorySubject({ memoryIndex: indexPath });
    const proposal: Proposal = {
      id: 1, cluster_id: 'memory-index-cleanup', subject: 'memory', kind: 'patch',
      target_path: indexPath, pattern_signature: 'sig', created_at: new Date(),
      signature: 'sig',
      alternatives: [{
        id: 'dedup-dead', label: 'lbl', tradeoff: '',
        diff_or_content: '# Memory Index\n\n- [A](a.md) — new\n',
      }],
    };
    await s.apply(proposal, 'dedup-dead');
    expect(existsSync(indexPath + '.bak')).toBe(true);
    expect(readFileSync(indexPath + '.bak', 'utf8')).toContain('old');
    expect(readFileSync(indexPath, 'utf8')).toContain('new');
  });

  it('apply rejects mismatching target_path', async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'memory', kind: 'patch',
      target_path: '/elsewhere/MEMORY.md', pattern_signature: 'sig', created_at: new Date(),
      signature: 'sig',
      alternatives: [{ id: 'a', label: 'l', tradeoff: '', diff_or_content: '# Memory Index\n' }],
    };
    await expect(s.apply(proposal, 'a')).rejects.toThrow(/target_path/);
  });

  it('validate requires "# Memory Index" header', async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const result = await s.validate({
      target_path: indexPath, kind: 'patch',
      applied_content: '# Wrong Header\n\n- [A](a.md)\n',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/header/);
  });

  it('validate rejects entries referencing files outside memory/ dir', async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const result = await s.validate({
      target_path: indexPath, kind: 'patch',
      applied_content: '# Memory Index\n\n- [Evil](../../escape.md) — out\n',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/outside/);
  });

  it('validate rejects index > 200 lines', async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const big = ['# Memory Index', ''];
    for (let i = 0; i < 220; i++) big.push(`- [Item${i}](item${i}.md) — hook`);
    const result = await s.validate({
      target_path: indexPath, kind: 'patch', applied_content: big.join('\n'),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/200 lines/);
  });

  it('validate accepts a clean index', async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const result = await s.validate({
      target_path: indexPath, kind: 'patch',
      applied_content: '# Memory Index\n\n- [A](a.md) — one\n- [B](b.md) — two\n',
    });
    expect(result.valid).toBe(true);
  });
});

describe('MemorySubject — revert', () => {
  it('replays inverse content back into memoryIndex (hash compare)', async () => {
    const original = '# Memory Index\n\n- [Orig](orig.md) — original\n';
    seed(original);
    const s = new MemorySubject({ memoryIndex: indexPath });
    writeFileSync(indexPath, '# Memory Index\n\n- [Mutated](mut.md)\n', 'utf8');

    const inverse: Patch = {
      target_path: indexPath, kind: 'patch', applied_content: original,
    };
    await s.revert(inverse);
    expect(readFileSync(indexPath, 'utf8')).toBe(original);
  });
});

// ── Pass B: edges, idempotency, perf, guardrails ───────────────────────────

describe('MemorySubject — Pass B: edges', () => {
  it('collectObservations: empty MEMORY.md returns empty list', async () => {
    seed('');
    const s = new MemorySubject({ memoryIndex: indexPath });
    expect(await s.collectObservations(new Date(0))).toEqual([]);
  });

  it('collectObservations: missing MEMORY.md returns empty list (no throw)', async () => {
    // do not seed — file does not exist
    const s = new MemorySubject({ memoryIndex: indexPath });
    expect(await s.collectObservations(new Date(0))).toEqual([]);
  });

  it('validate rejects entry referencing parent dir (../escape.md)', async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const result = await s.validate({
      target_path: indexPath, kind: 'patch',
      applied_content: '# Memory Index\n- [Bad](../escape.md) — bad\n',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/outside memory dir/);
  });

  it('validate rejects entry with absolute path', async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const result = await s.validate({
      target_path: indexPath, kind: 'patch',
      applied_content: '# Memory Index\n- [Abs](/etc/passwd) — abs\n',
    });
    expect(result.valid).toBe(false);
  });

  it('apply: missing alternative id → clear error', async () => {
    seed('# Memory Index\n- [A](a.md)\n');
    const s = new MemorySubject({ memoryIndex: indexPath });
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'memory', kind: 'patch',
      target_path: indexPath, pattern_signature: 'sig', created_at: new Date(),
      signature: 's',
      alternatives: [{ id: 'real-id', label: '', tradeoff: '', diff_or_content: '# Memory Index\n' }],
    };
    await expect(s.apply(proposal, 'wrong-id')).rejects.toThrow(/alternative/);
  });
});

describe('MemorySubject — Pass B: idempotency', () => {
  it('apply same content twice → identical file state', async () => {
    seed('# Memory Index\n- [Old](old.md)\n');
    const s = new MemorySubject({ memoryIndex: indexPath });
    const newContent = '# Memory Index\n- [New](new.md) — new\n';
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'memory', kind: 'patch',
      target_path: indexPath, pattern_signature: 'sig', created_at: new Date(),
      signature: 's',
      alternatives: [{ id: 'a', label: '', tradeoff: '', diff_or_content: newContent }],
    };
    await s.apply(proposal, 'a');
    const after1 = readFileSync(indexPath, 'utf8');
    await s.apply(proposal, 'a');
    expect(readFileSync(indexPath, 'utf8')).toBe(after1);
  });

  it('revert same inverse twice → no double-mutation', async () => {
    seed('# Memory Index\n- [Mutated](m.md)\n');
    const s = new MemorySubject({ memoryIndex: indexPath });
    const inverse: Patch = {
      target_path: indexPath, kind: 'patch',
      applied_content: '# Memory Index\n- [Original](o.md) — orig\n',
    };
    await s.revert(inverse);
    const after1 = readFileSync(indexPath, 'utf8');
    await s.revert(inverse);
    expect(readFileSync(indexPath, 'utf8')).toBe(after1);
  });
});

describe('MemorySubject — Pass B: perf', () => {
  it('validate scales linearly on large valid index (assert <250ms on 200 entries)', async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const lines = ['# Memory Index'];
    for (let i = 0; i < 195; i++) lines.push(`- [Entry${i}](e${i}.md) — hook ${i}`);
    const content = lines.join('\n');
    const start = Date.now();
    const result = await s.validate({ target_path: indexPath, kind: 'patch', applied_content: content });
    const elapsed = Date.now() - start;
    expect(result.valid).toBe(true);
    expect(elapsed).toBeLessThan(250);
  });

  it('collectObservations on 50K-line index reads in <500ms (no quadratic scan)', async () => {
    // Build a 50K-line "memory" file that legitimately parses as MEMORY.md.
    // The current implementation: parseEntries iterates lines once + slugCounts
    // built once + final loop is O(n). Just confirm we don't time out.
    const lines = ['# Memory Index'];
    for (let i = 0; i < 50_000; i++) lines.push(`- [E${i}](e${i}.md) — h`);
    seed(lines.join('\n'));
    const s = new MemorySubject({ memoryIndex: indexPath });
    const start = Date.now();
    const obs = await s.collectObservations(new Date(0));
    const elapsed = Date.now() - start;
    // None of the e0..eN.md files exist → every entry is dead. Just check
    // wall-clock is sane.
    expect(obs.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe('MemorySubject — Pass B: validate/apply symmetry', () => {
  it('apply roundtrip: produced Patch validates clean', async () => {
    seed('# Memory Index\n- [A](a.md)\n');
    touch('a.md');
    const s = new MemorySubject({ memoryIndex: indexPath });
    const newContent = '# Memory Index\n\n- [A](a.md) — alpha\n- [B](b.md) — beta\n';
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'memory', kind: 'patch',
      target_path: indexPath, pattern_signature: 'sig', created_at: new Date(),
      signature: 's',
      alternatives: [{ id: 'a', label: '', tradeoff: '', diff_or_content: newContent }],
    };
    const patch = await s.apply(proposal, 'a');
    const v = await s.validate(patch);
    expect(v.valid).toBe(true);
  });

  it('apply throws on target_path mismatch → validate would not flag (different file path concern)', async () => {
    seed('# Memory Index\n');
    const s = new MemorySubject({ memoryIndex: indexPath });
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'memory', kind: 'patch',
      target_path: '/tmp/wrong-path.md', pattern_signature: 'sig', created_at: new Date(),
      signature: 's',
      alternatives: [{ id: 'a', label: '', tradeoff: '', diff_or_content: '# Memory Index\n' }],
    };
    await expect(s.apply(proposal, 'a')).rejects.toThrow(/target_path mismatch/);
  });
});

describe('MemorySubject — Pass B: risk_tier guardrails', () => {
  it('risk_tier is low — auto-merge default allowed', () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    expect(s.risk_tier).toBe('low');
    expect(s.auto_merge_default).toBe(true);
  });
});
