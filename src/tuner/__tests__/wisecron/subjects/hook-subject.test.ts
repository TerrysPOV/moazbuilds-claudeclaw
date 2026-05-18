import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookSubject } from '../../../subjects/hook-subject.js';
import type { Cluster, Observation, Patch, Proposal } from '../../../../skills-tuner/core/types.js';

let tmpRoot: string;
let hooksDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'hooksubj-'));
  hooksDir = join(tmpRoot, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('HookSubject — identity', () => {
  it('name === "hook", risk_tier === "high"', () => {
    const s = new HookSubject({ hooksDir });
    expect(s.name).toBe('hook');
    expect(s.risk_tier).toBe('high');
    expect(s.auto_merge_default).toBe(false);
  });
});

describe('HookSubject — collectObservations', () => {
  it('parses log entries for exit_code + duration_ms', async () => {
    const s = new HookSubject({
      hooksDir,
      logReader: () => [
        { hook: 'fast.sh', exitCode: 0, durationMs: 100, eventType: 'UserPromptSubmit', timestamp: new Date() },
        { hook: 'fast.sh', exitCode: 0, durationMs: 110, eventType: 'UserPromptSubmit', timestamp: new Date() },
        { hook: 'broken.sh', exitCode: 1, durationMs: 200, eventType: 'UserPromptSubmit', timestamp: new Date() },
      ],
    });
    const obs = await s.collectObservations(new Date(0));
    // fast.sh has no crash, no slow → 0 observations. broken.sh has 1 crash → 1.
    expect(obs.length).toBe(1);
    expect(obs[0]!.metadata['hook']).toBe('broken.sh');
  });

  it('emits Observation per slow run (>5s p95)', async () => {
    const s = new HookSubject({
      hooksDir,
      logReader: () => Array.from({ length: 20 }, (_, i) => ({
        hook: 'slow.sh', exitCode: 0,
        durationMs: i < 18 ? 100 : 7_000,
        eventType: 'UserPromptSubmit', timestamp: new Date(),
      })),
    });
    const obs = await s.collectObservations(new Date(0));
    expect(obs.length).toBe(1);
    expect(obs[0]!.metadata['p95_duration_ms']).toBeGreaterThan(5_000);
  });

  it('returns empty array when log reader returns nothing', async () => {
    const s = new HookSubject({ hooksDir, logReader: () => [] });
    expect(await s.collectObservations(new Date(0))).toEqual([]);
  });
});

describe('HookSubject — detectProblems', () => {
  it('flags hook with crash_rate > 0.2', async () => {
    const s = new HookSubject({ hooksDir });
    const obs: Observation[] = [{
      session_id: 't', observed_at: new Date(), signal_type: 'correction', verbatim: '{}',
      metadata: { subject: 'hook', hook: 'h.sh', crash_rate: 0.8, p95_duration_ms: 100 },
    }];
    const clusters = await s.detectProblems(obs);
    expect(clusters.some(c => c.id === 'hook-crashing')).toBe(true);
  });

  it('flags hook with p95_duration > 5000ms', async () => {
    const s = new HookSubject({ hooksDir });
    const obs: Observation[] = [{
      session_id: 't', observed_at: new Date(), signal_type: 'repeated_trigger', verbatim: '{}',
      metadata: { subject: 'hook', hook: 'h.sh', crash_rate: 0, p95_duration_ms: 8_000 },
    }];
    const clusters = await s.detectProblems(obs);
    expect(clusters.some(c => c.id === 'hook-slow')).toBe(true);
  });

  it('returns empty when observations array empty', async () => {
    const s = new HookSubject({ hooksDir });
    expect(await s.detectProblems([])).toEqual([]);
  });
});

describe('HookSubject — apply', () => {
  it('preserves executable bit (chmod 0o755 after write)', async () => {
    const target = join(hooksDir, 'h.sh');
    writeFileSync(target, '#!/bin/sh\necho old\n', 'utf8');
    chmodSync(target, 0o644);
    const s = new HookSubject({ hooksDir });
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'hook', kind: 'patch',
      target_path: target, pattern_signature: 'sig', created_at: new Date(),
      signature: 'sig',
      alternatives: [{ id: 'a', label: 'l', tradeoff: '', diff_or_content: '#!/bin/sh\necho new\n' }],
    };
    await s.apply(proposal, 'a');
    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(0o755);
    expect(readFileSync(target, 'utf8')).toContain('new');
  });

  it('rejects target_path outside hooksDir', async () => {
    const s = new HookSubject({ hooksDir });
    const evil = join(tmpRoot, 'escape.sh');
    writeFileSync(evil, '#!/bin/sh\n');
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'hook', kind: 'patch',
      target_path: evil, pattern_signature: 'sig', created_at: new Date(),
      signature: 'sig',
      alternatives: [{ id: 'a', label: 'l', tradeoff: '', diff_or_content: '#!/bin/sh\n' }],
    };
    await expect(s.apply(proposal, 'a')).rejects.toThrow(/hooksDir/);
  });

  it('writes .bak before replacement', async () => {
    const target = join(hooksDir, 'h.sh');
    writeFileSync(target, '#!/bin/sh\necho old\n', 'utf8');
    const s = new HookSubject({ hooksDir });
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'hook', kind: 'patch',
      target_path: target, pattern_signature: 'sig', created_at: new Date(),
      signature: 'sig',
      alternatives: [{ id: 'a', label: 'l', tradeoff: '', diff_or_content: '#!/bin/sh\necho new\n' }],
    };
    await s.apply(proposal, 'a');
    expect(existsSync(target + '.bak')).toBe(true);
    expect(readFileSync(target + '.bak', 'utf8')).toContain('old');
  });
});

describe('HookSubject — validate', () => {
  it('runs shellcheck -n on applied_content when available', async () => {
    const calls: string[] = [];
    const s = new HookSubject({
      hooksDir,
      shellcheckRunner: (content) => { calls.push(content); return { ok: false, message: 'mock failure' }; },
    });
    const result = await s.validate({
      target_path: join(hooksDir, 'h.sh'), kind: 'patch',
      applied_content: '#!/bin/sh\necho hi\n',
    });
    expect(calls.length).toBe(1);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/shellcheck/);
  });

  it('passes when shellcheck unavailable (returns null)', async () => {
    const s = new HookSubject({ hooksDir, shellcheckRunner: () => null });
    const result = await s.validate({
      target_path: join(hooksDir, 'h.sh'), kind: 'patch',
      applied_content: '#!/bin/sh\necho hi\n',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects empty applied_content', async () => {
    const s = new HookSubject({ hooksDir, shellcheckRunner: () => null });
    const result = await s.validate({
      target_path: join(hooksDir, 'h.sh'), kind: 'patch',
      applied_content: '   ',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/empty/);
  });

  it('rejects target_path outside hooksDir', async () => {
    const s = new HookSubject({ hooksDir, shellcheckRunner: () => null });
    const result = await s.validate({
      target_path: '/tmp/escape.sh', kind: 'patch', applied_content: '#!/bin/sh\necho ok\n',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/hooksDir/);
  });
});

describe('HookSubject — revert', () => {
  it('restores prior content with executable bit intact', async () => {
    const target = join(hooksDir, 'h.sh');
    writeFileSync(target, '#!/bin/sh\necho mutated\n', 'utf8');
    chmodSync(target, 0o644);
    const s = new HookSubject({ hooksDir });
    const inverse: Patch = {
      target_path: target, kind: 'patch', applied_content: '#!/bin/sh\necho original\n',
    };
    await s.revert(inverse);
    expect(readFileSync(target, 'utf8')).toBe('#!/bin/sh\necho original\n');
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });

  it('prefers .bak restoration when present', async () => {
    const target = join(hooksDir, 'h.sh');
    writeFileSync(target, '#!/bin/sh\necho mutated\n', 'utf8');
    writeFileSync(target + '.bak', '#!/bin/sh\necho exact-pre-bytes\n', 'utf8');
    const s = new HookSubject({ hooksDir });
    const inverse: Patch = {
      target_path: target, kind: 'patch',
      applied_content: '#!/bin/sh\necho would-be-ignored\n',
    };
    await s.revert(inverse);
    expect(readFileSync(target, 'utf8')).toContain('exact-pre-bytes');
  });
});

// ── Pass B: edges, idempotency, guardrails ─────────────────────────────────

describe('HookSubject — Pass B: edges', () => {
  it('apply: relative target path resolves and stays inside hooksDir check', async () => {
    const s = new HookSubject({ hooksDir });
    // Resolve to "../escape.sh" — must still be rejected
    const target = join(hooksDir, '..', 'escape.sh');
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'hook', kind: 'patch',
      target_path: target, pattern_signature: 'sig', created_at: new Date(),
      signature: 's',
      alternatives: [{ id: 'a', label: '', tradeoff: '', diff_or_content: '#!/bin/sh\n' }],
    };
    await expect(s.apply(proposal, 'a')).rejects.toThrow(/hooksDir/);
  });

  it('apply: missing alternative id → clear error', async () => {
    const target = join(hooksDir, 'h.sh');
    writeFileSync(target, '#!/bin/sh\n');
    const s = new HookSubject({ hooksDir });
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'hook', kind: 'patch',
      target_path: target, pattern_signature: 'sig', created_at: new Date(),
      signature: 's',
      alternatives: [{ id: 'real-id', label: '', tradeoff: '', diff_or_content: '#!/bin/sh\n' }],
    };
    await expect(s.apply(proposal, 'wrong-id')).rejects.toThrow(/alternative/);
  });

  it('apply on file that did not exist before: no .bak created (and revert still works)', async () => {
    const target = join(hooksDir, 'fresh.sh');
    expect(existsSync(target)).toBe(false);
    const s = new HookSubject({ hooksDir });
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'hook', kind: 'patch',
      target_path: target, pattern_signature: 'sig', created_at: new Date(),
      signature: 's',
      alternatives: [{ id: 'a', label: '', tradeoff: '', diff_or_content: '#!/bin/sh\necho new\n' }],
    };
    await s.apply(proposal, 'a');
    expect(existsSync(target + '.bak')).toBe(false);
    expect(readFileSync(target, 'utf8')).toContain('new');
  });
});

describe('HookSubject — Pass B: idempotency', () => {
  it('apply same content twice → same final file content (idempotent)', async () => {
    const target = join(hooksDir, 'h.sh');
    writeFileSync(target, '#!/bin/sh\necho old\n');
    const s = new HookSubject({ hooksDir });
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'hook', kind: 'patch',
      target_path: target, pattern_signature: 'sig', created_at: new Date(),
      signature: 's',
      alternatives: [{ id: 'a', label: '', tradeoff: '', diff_or_content: '#!/bin/sh\necho new\n' }],
    };
    await s.apply(proposal, 'a');
    const after1 = readFileSync(target, 'utf8');
    await s.apply(proposal, 'a');
    const after2 = readFileSync(target, 'utf8');
    expect(after2).toBe(after1);
  });

  it('revert same inverse twice → same final state (no error, no double-mutation)', async () => {
    const target = join(hooksDir, 'h.sh');
    writeFileSync(target, '#!/bin/sh\necho mutated\n');
    const s = new HookSubject({ hooksDir });
    const inverse: Patch = {
      target_path: target, kind: 'patch', applied_content: '#!/bin/sh\necho original\n',
    };
    await s.revert(inverse);
    const after1 = readFileSync(target, 'utf8');
    await s.revert(inverse);
    const after2 = readFileSync(target, 'utf8');
    expect(after2).toBe(after1);
  });
});

describe('HookSubject — Pass B: validate/apply symmetry', () => {
  it('validate rejects what apply would refuse: target outside hooksDir', async () => {
    const s = new HookSubject({ hooksDir, shellcheckRunner: () => null });
    const evilPath = join(tmpRoot, 'escape.sh');
    const v = await s.validate({
      target_path: evilPath, kind: 'patch', applied_content: '#!/bin/sh\necho hi\n',
    });
    expect(v.valid).toBe(false);
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'hook', kind: 'patch',
      target_path: evilPath, pattern_signature: 'sig', created_at: new Date(),
      signature: 's',
      alternatives: [{ id: 'a', label: '', tradeoff: '', diff_or_content: '#!/bin/sh\n' }],
    };
    await expect(s.apply(proposal, 'a')).rejects.toThrow(/hooksDir/);
  });

  it('apply roundtrip: forward patch then validate(patch) returns valid', async () => {
    const target = join(hooksDir, 'h.sh');
    writeFileSync(target, '#!/bin/sh\necho old\n');
    const s = new HookSubject({ hooksDir, shellcheckRunner: () => null });
    const proposal: Proposal = {
      id: 1, cluster_id: 'c', subject: 'hook', kind: 'patch',
      target_path: target, pattern_signature: 'sig', created_at: new Date(),
      signature: 's',
      alternatives: [{ id: 'a', label: '', tradeoff: '', diff_or_content: '#!/bin/sh\necho new\n' }],
    };
    const patch = await s.apply(proposal, 'a');
    const v = await s.validate(patch);
    expect(v.valid).toBe(true);
  });
});

describe('HookSubject — Pass B: risk_tier guardrails', () => {
  it('risk_tier is high — observation window gated on this in ApplyPipeline', () => {
    const s = new HookSubject({ hooksDir });
    expect(s.risk_tier).toBe('high');
  });
});

describe('HookSubject — snapshotInverse', () => {
  it('returns the current disk content for an existing hook', async () => {
    const target = join(hooksDir, 'user_prompt.sh');
    writeFileSync(target, '#!/bin/sh\necho hello\n');
    const s = new HookSubject({ hooksDir });
    const content = await s.snapshotInverse(target);
    expect(content).toBe('#!/bin/sh\necho hello\n');
  });

  it('returns empty string when the hook file does not yet exist', async () => {
    const target = join(hooksDir, 'never_created.sh');
    const s = new HookSubject({ hooksDir });
    const content = await s.snapshotInverse(target);
    expect(content).toBe('');
  });

  it('rejects targets outside hooksDir', async () => {
    const s = new HookSubject({ hooksDir });
    await expect(s.snapshotInverse('/etc/passwd')).rejects.toThrow(/outside hooksDir/);
  });
});
