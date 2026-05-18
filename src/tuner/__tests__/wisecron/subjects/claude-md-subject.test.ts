import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeMdSubject } from '../../../subjects/claude-md-subject.js';
import type { Cluster, Observation, Patch, Proposal } from '../../../../skills-tuner/core/types.js';

let tmpRoot: string;
let projectA: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cmdsubj-'));
  projectA = join(tmpRoot, 'projectA');
  mkdirSync(projectA, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeClaudeMd(dir: string, content: string): string {
  const path = join(dir, 'CLAUDE.md');
  writeFileSync(path, content, 'utf8');
  return path;
}

function ageMtime(path: string, daysAgo: number): void {
  const t = Date.now() / 1000 - daysAgo * 86_400;
  utimesSync(path, t, t);
}

describe('ClaudeMdSubject — identity', () => {
  it('name === "claude_md", risk_tier === "medium"', () => {
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    expect(s.name).toBe('claude_md');
    expect(s.risk_tier).toBe('medium');
  });
});

describe('ClaudeMdSubject — collectObservations', () => {
  it('walks projectRoots for CLAUDE.md files', async () => {
    writeClaudeMd(projectA, '@./missing.md\nbody\n');
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    const obs = await s.collectObservations(new Date(0));
    expect(obs.length).toBe(1);
    expect((obs[0]!.metadata['file'] as string)).toContain('projectA');
  });

  it('detects broken @-imports (target file missing)', async () => {
    writeClaudeMd(projectA, '@./does-not-exist.md\ntext\n');
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    const obs = await s.collectObservations(new Date(0));
    expect(obs[0]!.metadata['broken_count']).toBe(1);
  });

  it('flags stale sections (mtime > 180d, no nested updates)', async () => {
    const path = writeClaudeMd(projectA, '# Section A\nbody\n## Section B\nmore\n## Section C\n');
    ageMtime(path, 200);
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    const obs = await s.collectObservations(new Date(0));
    expect(obs.length).toBe(1);
    expect((obs[0]!.metadata['stale_sections'] as number)).toBeGreaterThanOrEqual(2);
  });

  it('returns empty when no issues found', async () => {
    writeFileSync(join(projectA, 'present.md'), '# x');
    writeClaudeMd(projectA, '@./present.md\nfresh content\n');
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    const obs = await s.collectObservations(new Date(0));
    expect(obs).toEqual([]);
  });
});

describe('ClaudeMdSubject — detectProblems', () => {
  it('cluster per file with >=1 broken import OR >=2 stale sections', async () => {
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    const obs: Observation[] = [{
      session_id: 't', observed_at: new Date(), signal_type: 'correction', verbatim: '{}',
      metadata: { subject: 'claude_md', file: join(projectA, 'CLAUDE.md'), broken_count: 1, stale_sections: 0 },
    }];
    const clusters = await s.detectProblems(obs);
    expect(clusters.length).toBe(1);
    expect(clusters[0]!.subjects_touched[0]).toContain('CLAUDE.md');
  });

  it('returns empty when below threshold', async () => {
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    const obs: Observation[] = [{
      session_id: 't', observed_at: new Date(), signal_type: 'correction', verbatim: '{}',
      metadata: { subject: 'claude_md', file: join(projectA, 'CLAUDE.md'), broken_count: 0, stale_sections: 1 },
    }];
    expect(await s.detectProblems(obs)).toEqual([]);
  });
});

describe('ClaudeMdSubject — apply / revert', () => {
  it('apply writes .bak before content replacement', async () => {
    const path = writeClaudeMd(projectA, '# old content\n');
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'claude_md', kind: 'patch',
      target_path: path, pattern_signature: 'sig', created_at: new Date(),
      signature: 'sig',
      alternatives: [{ id: 'fix-imports', label: 'l', tradeoff: '', diff_or_content: '# new content\n' }],
    };
    await s.apply(proposal, 'fix-imports');
    expect(existsSync(path + '.bak')).toBe(true);
    expect(readFileSync(path + '.bak', 'utf8')).toContain('old');
    expect(readFileSync(path, 'utf8')).toContain('new');
  });

  it('rejects target_path outside projectRoots (path traversal)', async () => {
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    const evil = join(tmpRoot, 'escape.md');
    writeFileSync(evil, '# evil\n');
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'claude_md', kind: 'patch',
      target_path: evil, pattern_signature: 'sig', created_at: new Date(),
      signature: 'sig',
      alternatives: [{ id: 'a', label: 'l', tradeoff: '', diff_or_content: '# x\n' }],
    };
    await expect(s.apply(proposal, 'a')).rejects.toThrow(/projectRoots/);
  });

  it('revert restores prior content (hash compare via .bak)', async () => {
    const path = writeClaudeMd(projectA, '# pristine\n');
    copyAsBak(path);
    writeFileSync(path, '# mutated\n');
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    const inverse: Patch = {
      target_path: path, kind: 'patch', applied_content: 'unused-because-bak-wins',
    };
    await s.revert(inverse);
    expect(readFileSync(path, 'utf8')).toBe('# pristine\n');
  });
});

function copyAsBak(path: string): void {
  writeFileSync(path + '.bak', readFileSync(path));
}

describe('ClaudeMdSubject — validate', () => {
  it('rejects content with unresolvable @-imports', async () => {
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    const path = join(projectA, 'CLAUDE.md');
    const result = await s.validate({
      target_path: path, kind: 'patch',
      applied_content: '@./nope.md\nbody\n',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/unresolvable|@-imports/);
  });

  it('accepts content with all imports resolvable', async () => {
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    const path = join(projectA, 'CLAUDE.md');
    writeFileSync(join(projectA, 'present.md'), '# y');
    const result = await s.validate({
      target_path: path, kind: 'patch',
      applied_content: '@./present.md\nbody\n',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects target_path outside projectRoots', async () => {
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    const result = await s.validate({
      target_path: '/tmp/escape.md', kind: 'patch', applied_content: '# x\n',
    });
    expect(result.valid).toBe(false);
  });
});

// ── Pass B: edges, idempotency, guardrails ─────────────────────────────────

describe('ClaudeMdSubject — Pass B: edges', () => {
  it('collectObservations: missing projectRoot returns empty list', async () => {
    const s = new ClaudeMdSubject({ projectRoots: [join(tmpRoot, 'nonexistent')] });
    expect(await s.collectObservations(new Date(0))).toEqual([]);
  });

  it('apply: missing alternative id → clear error', async () => {
    const path = writeClaudeMd(projectA, '# Hi\n');
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'claude_md', kind: 'patch',
      target_path: path, pattern_signature: 'sig', created_at: new Date(),
      signature: 's',
      alternatives: [{ id: 'real', label: '', tradeoff: '', diff_or_content: '# New\n' }],
    };
    await expect(s.apply(proposal, 'wrong')).rejects.toThrow(/alternative/);
  });

  it('validate: malformed @-import (path traversal) is flagged', async () => {
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    const path = join(projectA, 'CLAUDE.md');
    const result = await s.validate({
      target_path: path, kind: 'patch',
      applied_content: '@../../../../etc/passwd\nbody\n',
    });
    expect(result.valid).toBe(false);
  });
});

describe('ClaudeMdSubject — Pass B: idempotency', () => {
  it('apply same alt twice → identical file content', async () => {
    const path = writeClaudeMd(projectA, '# Old\n');
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'claude_md', kind: 'patch',
      target_path: path, pattern_signature: 'sig', created_at: new Date(),
      signature: 's',
      alternatives: [{ id: 'a', label: '', tradeoff: '', diff_or_content: '# New body\n' }],
    };
    await s.apply(proposal, 'a');
    const after1 = readFileSync(path, 'utf8');
    await s.apply(proposal, 'a');
    expect(readFileSync(path, 'utf8')).toBe(after1);
  });

  it('revert same inverse twice → no double-mutation', async () => {
    const path = writeClaudeMd(projectA, '# Mutated\n');
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    const inverse: Patch = {
      target_path: path, kind: 'patch', applied_content: '# Original\n',
    };
    await s.revert(inverse);
    const after1 = readFileSync(path, 'utf8');
    await s.revert(inverse);
    expect(readFileSync(path, 'utf8')).toBe(after1);
  });
});

describe('ClaudeMdSubject — Pass B: validate/apply symmetry', () => {
  it('validate flags what apply refuses (target outside projectRoots)', async () => {
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    const evilPath = join(tmpRoot, 'escape.md');
    const v = await s.validate({
      target_path: evilPath, kind: 'patch', applied_content: '# x\n',
    });
    expect(v.valid).toBe(false);
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'claude_md', kind: 'patch',
      target_path: evilPath, pattern_signature: 'sig', created_at: new Date(),
      signature: 's',
      alternatives: [{ id: 'a', label: '', tradeoff: '', diff_or_content: '# y' }],
    };
    await expect(s.apply(proposal, 'a')).rejects.toThrow(/projectRoots/);
  });
});

describe('ClaudeMdSubject — Pass B: risk_tier guardrails', () => {
  it('risk_tier is medium — observation window NOT armed in ApplyPipeline', () => {
    const s = new ClaudeMdSubject({ projectRoots: [projectA] });
    expect(s.risk_tier).toBe('medium');
    expect(s.auto_merge_default).toBe(false);
  });
});
