import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ApplyPipeline } from '../../wisecron/apply-pipeline.js';
import { WisecronStateDB } from '../../wisecron/state-db.js';
import { Registry } from '../../../skills-tuner/core/registry.js';
import { TunableSubject } from '../../../skills-tuner/core/interfaces.js';
import type { RiskTier } from '../../../skills-tuner/core/interfaces.js';
import type {
  Cluster,
  Observation,
  Patch,
  Proposal,
  UnsignedProposal,
  ValidationResult,
} from '../../../skills-tuner/core/types.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

class FakeSubject extends TunableSubject {
  readonly name: string;
  readonly risk_tier: RiskTier;
  applyImpl: (p: Proposal, a: string) => Promise<Patch>;
  validateResult: ValidationResult = { valid: true };
  revertCalls: Patch[] = [];
  hasRevert = true;

  constructor(name: string, risk_tier: RiskTier, opts: { applyImpl?: (p: Proposal, a: string) => Promise<Patch> } = {}) {
    super();
    this.name = name;
    this.risk_tier = risk_tier;
    this.applyImpl = opts.applyImpl ?? (async (p) => ({
      target_path: p.target_path, kind: 'noop_change', applied_content: 'after',
    }));
  }
  async collectObservations(_since: Date): Promise<Observation[]> { return []; }
  async detectProblems(_obs: Observation[]): Promise<Cluster[]> { return []; }
  async proposeChange(_c: Cluster): Promise<UnsignedProposal> {
    throw new Error('not used in pipeline tests');
  }
  async apply(p: Proposal, a: string): Promise<Patch> { return this.applyImpl(p, a); }
  async validate(_p: Patch): Promise<ValidationResult> { return this.validateResult; }
  async revert(inverse: Patch): Promise<void> {
    if (!this.hasRevert) throw new Error('subject.revert disabled for test');
    this.revertCalls.push(inverse);
  }
}

// FakeSubject without revert method on prototype
class FakeSubjectNoRevert extends FakeSubject {
  constructor(name: string, risk_tier: RiskTier) {
    super(name, risk_tier);
    // Delete revert from instance — but TunableSubject base doesn't have it,
    // so we just override to undefined via a property.
    (this as unknown as { revert?: unknown }).revert = undefined;
  }
}

let tmpDir: string;
let db: WisecronStateDB;
let registry: Registry;
let auditEvents: Array<{ event: string; payload: Record<string, unknown> }>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wisecron-pipeline-'));
  db = new WisecronStateDB(join(tmpDir, 'wisecron.db'));
  registry = new Registry();
  auditEvents = [];
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function captureAudit(events: typeof auditEvents) {
  return (event: string, payload: Record<string, unknown>) => {
    events.push({ event, payload });
  };
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 1,
    cluster_id: 'c1',
    subject: 'fake',
    kind: 'noop',
    target_path: join(tmpDir, 'target.txt'),
    pattern_signature: 'sig:1',
    created_at: new Date('2026-01-01T00:00:00Z'),
    alternatives: [{ id: 'a1', label: '', diff_or_content: 'after', tradeoff: '' }],
    signature: 'valid-sig',
    ...overrides,
  };
}

// ── apply ──────────────────────────────────────────────────────────────────

describe('ApplyPipeline — apply', () => {
  it('verifies HMAC on proposal before apply (rejects forged)', async () => {
    const sub = new FakeSubject('fake', 'low');
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => false,
    });
    await expect(pipeline.apply(makeProposal(), 'a1', 'cli'))
      .rejects.toThrow(/signature verification/);
    expect(auditEvents.some(e => e.event === 'wisecron_signature_mismatch')).toBe(true);
    expect(db.listRevisionsBySubject('fake')).toHaveLength(0);
  });

  it('snapshots current target → inverse_patch BEFORE calling subject.apply', async () => {
    const targetPath = join(tmpDir, 'target.txt');
    writeFileSync(targetPath, 'before');
    let valueDuringApply: string | null = null;
    const sub = new FakeSubject('fake', 'low', {
      applyImpl: async (p) => {
        // simulate the subject mutating the file during apply
        writeFileSync(targetPath, 'during');
        valueDuringApply = readFileSync(targetPath, 'utf8');
        return { target_path: p.target_path, kind: 'noop_change', applied_content: 'after' };
      },
    });
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    await pipeline.apply(makeProposal({ target_path: targetPath }), 'a1', 'cli');
    expect(valueDuringApply).toBe('during');
    const revisions = db.listRevisionsBySubject('fake');
    expect(revisions[0]!.inverse_patch.applied_content).toBe('before');
  });

  it('persists forward + inverse patch in rollback_history', async () => {
    const targetPath = join(tmpDir, 'target.txt');
    writeFileSync(targetPath, 'before');
    const sub = new FakeSubject('fake', 'low');
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    const result = await pipeline.apply(makeProposal({ target_path: targetPath }), 'a1', 'cli');
    expect(result.revision.forward_patch.applied_content).toBe('after');
    expect(result.revision.inverse_patch.applied_content).toBe('before');
    expect(result.revision.applied_by).toBe('cli');
  });

  it('emits wisecron_proposal_applied audit event with revision_id (no patch contents)', async () => {
    const sub = new FakeSubject('fake', 'low');
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    await pipeline.apply(makeProposal(), 'a1', 'telegram');
    const ev = auditEvents.find(e => e.event === 'wisecron_proposal_applied');
    expect(ev).toBeDefined();
    expect(typeof ev!.payload['revision_id']).toBe('number');
    expect(ev!.payload).not.toHaveProperty('forward_patch');
    expect(ev!.payload).not.toHaveProperty('applied_content');
  });

  it('returns ApplyOutcome with observation_window_armed=false for low/medium subjects', async () => {
    const low = new FakeSubject('low-sub', 'low');
    const med = new FakeSubject('med-sub', 'medium');
    registry.registerSubject(low);
    registry.registerSubject(med);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    const r1 = await pipeline.apply(makeProposal({ subject: 'low-sub' }), 'a1', 'cli');
    expect(r1.observation_window_armed).toBe(false);
    const r2 = await pipeline.apply(makeProposal({ subject: 'med-sub', id: 2 }), 'a1', 'cli');
    expect(r2.observation_window_armed).toBe(false);
  });

  it('returns ApplyOutcome with observation_window_armed=true for high-risk subjects', async () => {
    const hi = new FakeSubject('hi-sub', 'high');
    registry.registerSubject(hi);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
      observationWindowMs: 1, // keep fire-and-forget probe trivial
    });
    const r = await pipeline.apply(makeProposal({ subject: 'hi-sub' }), 'a1', 'cli');
    expect(r.observation_window_armed).toBe(true);
  });

  it('subject.validate fail → throws + no rollback row inserted', async () => {
    const sub = new FakeSubject('fake', 'low');
    sub.validateResult = { valid: false, reason: 'bad-content' };
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    await expect(pipeline.apply(makeProposal(), 'a1', 'cli')).rejects.toThrow(/bad-content/);
    expect(db.listRevisionsBySubject('fake')).toHaveLength(0);
    expect(auditEvents.some(e => e.event === 'wisecron_validate_failed')).toBe(true);
  });
});

// ── revert ─────────────────────────────────────────────────────────────────

describe('ApplyPipeline — revert', () => {
  it('replays inverse_patch idempotently (apply→revert→state matches pre-apply hash)', async () => {
    const targetPath = join(tmpDir, 'target.txt');
    writeFileSync(targetPath, 'before-state');
    const preHash = createHash('sha256').update('before-state').digest('hex');
    const sub = new FakeSubject('fake', 'low', {
      applyImpl: async (p) => {
        writeFileSync(p.target_path, 'after-state');
        return { target_path: p.target_path, kind: 'noop_change', applied_content: 'after-state' };
      },
    });
    sub.hasRevert = false; // force generic file-write fallback
    (sub as unknown as { revert?: unknown }).revert = undefined;
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    const outcome = await pipeline.apply(makeProposal({ target_path: targetPath }), 'a1', 'cli');
    expect(readFileSync(targetPath, 'utf8')).toBe('after-state');
    await pipeline.revert(outcome.revision.id, 'cli');
    const postHash = createHash('sha256').update(readFileSync(targetPath, 'utf8')).digest('hex');
    expect(postHash).toBe(preHash);
  });

  it('marks rolled_back_at on success', async () => {
    writeFileSync(join(tmpDir, 'target.txt'), 'before');
    const sub = new FakeSubject('fake', 'low');
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    const outcome = await pipeline.apply(makeProposal(), 'a1', 'cli');
    expect(db.getRevision(outcome.revision.id)!.rolled_back_at).toBeNull();
    await pipeline.revert(outcome.revision.id, 'cli');
    expect(db.getRevision(outcome.revision.id)!.rolled_back_at).not.toBeNull();
  });

  it('rejects already-rolled-back revision with clear error', async () => {
    writeFileSync(join(tmpDir, 'target.txt'), 'before');
    const sub = new FakeSubject('fake', 'low');
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    const outcome = await pipeline.apply(makeProposal(), 'a1', 'cli');
    await pipeline.revert(outcome.revision.id, 'cli');
    await expect(pipeline.revert(outcome.revision.id, 'cli'))
      .rejects.toThrow(/already rolled back/);
  });

  it('emits wisecron_rollback audit event referencing original apply event', async () => {
    writeFileSync(join(tmpDir, 'target.txt'), 'before');
    const sub = new FakeSubject('fake', 'low');
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    const outcome = await pipeline.apply(makeProposal(), 'a1', 'cli');
    await pipeline.revert(outcome.revision.id, 'cli');
    const ev = auditEvents.find(e => e.event === 'wisecron_rollback');
    expect(ev).toBeDefined();
    expect(ev!.payload['revision_id']).toBe(outcome.revision.id);
    expect(ev!.payload['proposal_id']).toBe('1');
  });

  it('subject.revert called when subject implements RevertibleSubject', async () => {
    writeFileSync(join(tmpDir, 'target.txt'), 'before');
    const sub = new FakeSubject('fake', 'low');
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    const outcome = await pipeline.apply(makeProposal(), 'a1', 'cli');
    await pipeline.revert(outcome.revision.id, 'cli');
    expect(sub.revertCalls).toHaveLength(1);
    expect(sub.revertCalls[0]!.applied_content).toBe('before');
  });

  it('falls back to generic file-write when subject lacks revert()', async () => {
    const targetPath = join(tmpDir, 'target.txt');
    writeFileSync(targetPath, 'before');
    const sub = new FakeSubjectNoRevert('fake', 'low');
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    const outcome = await pipeline.apply(makeProposal({ target_path: targetPath }), 'a1', 'cli');
    // simulate forward effect by writing "after" to disk
    writeFileSync(targetPath, 'after');
    await pipeline.revert(outcome.revision.id, 'cli');
    expect(readFileSync(targetPath, 'utf8')).toBe('before');
  });
});

// ── observation window (high-risk) ─────────────────────────────────────────

describe('ApplyPipeline — observation window (high-risk)', () => {
  it('CronSubject apply: systemd unit fails within 5 min → auto-revert triggers', async () => {
    writeFileSync(join(tmpDir, 'target.txt'), 'before');
    const sub = new FakeSubject('cron', 'high');
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
      observationWindowMs: 10,
      waitForObservationWindow: true,
      healthProbe: async () => ({ failed: true, errors: ['unit failed'] }),
    });
    const r = await pipeline.apply(makeProposal({ subject: 'cron' }), 'a1', 'cli');
    expect(r.auto_reverted).toBe(true);
    const ev = auditEvents.find(e => e.event === 'wisecron_auto_revert');
    expect(ev).toBeDefined();
  });

  it('CronSubject apply: 5 min pass clean → no auto-revert (change considered final)', async () => {
    writeFileSync(join(tmpDir, 'target.txt'), 'before');
    const sub = new FakeSubject('cron', 'high');
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
      observationWindowMs: 10,
      waitForObservationWindow: true,
      healthProbe: async () => ({ failed: false, errors: [] }),
    });
    const r = await pipeline.apply(makeProposal({ subject: 'cron' }), 'a1', 'cli');
    expect(r.auto_reverted).toBe(false);
    expect(auditEvents.find(e => e.event === 'wisecron_auto_revert')).toBeUndefined();
  });

  it('HookSubject apply: exit_code ≠ 0 in window → auto-revert + audit event wisecron_auto_revert', async () => {
    writeFileSync(join(tmpDir, 'target.txt'), 'before');
    const sub = new FakeSubject('hook', 'high');
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
      observationWindowMs: 10,
      waitForObservationWindow: true,
      healthProbe: async () => ({ failed: true, errors: ['exit_code=2'] }),
    });
    await pipeline.apply(makeProposal({ subject: 'hook' }), 'a1', 'cli');
    const ev = auditEvents.find(e => e.event === 'wisecron_auto_revert');
    expect(ev).toBeDefined();
    expect(ev!.payload['errors']).toContain('exit_code=2');
  });

  it('applied_by recorded as "auto-revert" on observation-window revert', async () => {
    writeFileSync(join(tmpDir, 'target.txt'), 'before');
    const sub = new FakeSubject('cron', 'high');
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
      observationWindowMs: 10,
      waitForObservationWindow: true,
      healthProbe: async () => ({ failed: true, errors: ['boom'] }),
    });
    await pipeline.apply(makeProposal({ subject: 'cron' }), 'a1', 'cli');
    const rollback = auditEvents.find(e => e.event === 'wisecron_rollback');
    expect(rollback).toBeDefined();
    expect(rollback!.payload['applied_by']).toBe('auto-revert');
  });

  it('low/medium subjects: armObservationWindow NOT called (no timer scheduled)', async () => {
    const sub = new FakeSubject('low-sub', 'low');
    registry.registerSubject(sub);
    let probeCalls = 0;
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
      observationWindowMs: 5,
      waitForObservationWindow: true,
      healthProbe: async () => { probeCalls++; return { failed: false, errors: [] }; },
    });
    const r = await pipeline.apply(makeProposal({ subject: 'low-sub' }), 'a1', 'cli');
    expect(r.observation_window_armed).toBe(false);
    // Give any rogue timer a chance to fire
    await new Promise(res => setTimeout(res, 20));
    expect(probeCalls).toBe(0);
  });
});

// ── retention purge ───────────────────────────────────────────────────────

describe('ApplyPipeline — retention purge', () => {
  it('purgeExpired deletes rows older than retention_days', async () => {
    const sub = new FakeSubject('fake', 'low');
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    writeFileSync(join(tmpDir, 'target.txt'), 'before');
    await pipeline.apply(makeProposal(), 'a1', 'cli');
    // Negative retention treats everything as expired (cutoff in the future)
    const purged = await pipeline.purgeExpired(-1);
    expect(purged).toBeGreaterThanOrEqual(1);
  });

  it('purgeExpired keeps rolled_back history within window', async () => {
    const sub = new FakeSubject('fake', 'low');
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    writeFileSync(join(tmpDir, 'target.txt'), 'before');
    const r = await pipeline.apply(makeProposal(), 'a1', 'cli');
    await pipeline.revert(r.revision.id, 'cli');
    // Large retention → keep everything
    const purged = await pipeline.purgeExpired(365);
    expect(purged).toBe(0);
    expect(db.getRevision(r.revision.id)).not.toBeNull();
  });

  it('rollback after retention expired → refused with clear error', async () => {
    const sub = new FakeSubject('fake', 'low');
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    writeFileSync(join(tmpDir, 'target.txt'), 'before');
    const r = await pipeline.apply(makeProposal(), 'a1', 'cli');
    await pipeline.purgeExpired(-1); // wipe history
    await expect(pipeline.revert(r.revision.id, 'cli'))
      .rejects.toThrow(/not found/);
  });
});

// ── concurrency ───────────────────────────────────────────────────────────

describe('ApplyPipeline — concurrency', () => {
  it('two concurrent apply() on same target → second waits or fails clean', async () => {
    writeFileSync(join(tmpDir, 'target.txt'), 'before');
    const order: string[] = [];
    const sub = new FakeSubject('fake', 'low', {
      applyImpl: async (p) => {
        order.push(`start-${p.id}`);
        await new Promise(res => setTimeout(res, 20));
        order.push(`end-${p.id}`);
        return { target_path: p.target_path, kind: 'noop_change', applied_content: `after-${p.id}` };
      },
    });
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    const a = pipeline.apply(makeProposal({ id: 1 }), 'a1', 'cli');
    const b = pipeline.apply(makeProposal({ id: 2 }), 'a1', 'cli');
    await Promise.all([a, b]);
    // Serialised: start-1, end-1, start-2, end-2 (or 2 then 1)
    expect(order).toHaveLength(4);
    expect(order[1]!.startsWith('end-')).toBe(true);
    expect(order[2]!.startsWith('start-')).toBe(true);
    expect(order[1]!.split('-')[1]).toBe(order[0]!.split('-')[1]);
  });

  it('apply mid-revert → revert finishes first, apply runs against reverted state', async () => {
    const targetPath = join(tmpDir, 'target.txt');
    writeFileSync(targetPath, 'before');
    const sub = new FakeSubject('fake', 'low', {
      applyImpl: async (p) => {
        // capture what target_path looked like at the moment apply ran
        const captured = existsSync(p.target_path) ? readFileSync(p.target_path, 'utf8') : '';
        writeFileSync(p.target_path, `after-${p.id}`);
        return { target_path: p.target_path, kind: 'noop_change', applied_content: `after-${p.id}` };
      },
    });
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    const first = await pipeline.apply(makeProposal({ id: 1 }), 'a1', 'cli');
    // Now start revert (writes 'before') and a second apply concurrently
    const revertP = pipeline.revert(first.revision.id, 'cli');
    const secondP = pipeline.apply(makeProposal({ id: 2 }), 'a1', 'cli');
    await Promise.all([revertP, secondP]);
    // After both: file should reflect second apply's after-2 (last write wins
    // through the serial lock — revert ran, then second apply on top).
    expect(readFileSync(targetPath, 'utf8')).toBe('after-2');
  });
});

// ── pure helpers ──────────────────────────────────────────────────────────

describe('ApplyPipeline — pure helpers', () => {
  it('isHighRisk: high → true, critical → true, medium → false, low → false', () => {
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    expect(pipeline.isHighRisk('high')).toBe(true);
    expect(pipeline.isHighRisk('critical')).toBe(true);
    expect(pipeline.isHighRisk('medium')).toBe(false);
    expect(pipeline.isHighRisk('low')).toBe(false);
  });
});

// ── withTargetLock map hygiene ────────────────────────────────────────────

describe('ApplyPipeline — withTargetLock map hygiene', () => {
  function lockMap(p: ApplyPipeline): Map<string, { tail: Promise<unknown>; waiters: number }> {
    return (p as unknown as { locks: Map<string, { tail: Promise<unknown>; waiters: number }> }).locks;
  }

  it('prunes map entry after the last waiter drains', async () => {
    const targetPath = join(tmpDir, 'target.txt');
    writeFileSync(targetPath, 'before');
    const gates: Array<() => void> = [];
    const waits: Array<Promise<void>> = [];
    for (let i = 0; i < 3; i += 1) {
      let resolve!: () => void;
      waits.push(new Promise<void>(r => { resolve = r; }));
      gates.push(resolve);
    }
    const sub = new FakeSubject('fake', 'low', {
      applyImpl: async (p) => {
        await waits[Number(p.id) - 1]!;
        return { target_path: p.target_path, kind: 'noop_change', applied_content: `after-${p.id}` };
      },
    });
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    const p1 = pipeline.apply(makeProposal({ id: 1, target_path: targetPath }), 'a1', 'cli');
    const p2 = pipeline.apply(makeProposal({ id: 2, target_path: targetPath }), 'a1', 'cli');
    const p3 = pipeline.apply(makeProposal({ id: 3, target_path: targetPath }), 'a1', 'cli');
    // Allow the enqueue microtasks to run so all 3 are registered as waiters.
    await Promise.resolve();
    await Promise.resolve();
    expect(lockMap(pipeline).size).toBe(1);
    expect(lockMap(pipeline).get(targetPath)?.waiters).toBe(3);

    gates[0]!(); await p1;
    gates[1]!(); await p2;
    gates[2]!(); await p3;

    expect(lockMap(pipeline).size).toBe(0);
  });

  it('keeps the map entry while waiters are still pending', async () => {
    const targetPath = join(tmpDir, 'target.txt');
    writeFileSync(targetPath, 'before');
    const gates: Array<() => void> = [];
    const waits: Array<Promise<void>> = [];
    for (let i = 0; i < 3; i += 1) {
      let resolve!: () => void;
      waits.push(new Promise<void>(r => { resolve = r; }));
      gates.push(resolve);
    }
    const sub = new FakeSubject('fake', 'low', {
      applyImpl: async (p) => {
        await waits[Number(p.id) - 1]!;
        return { target_path: p.target_path, kind: 'noop_change', applied_content: `after-${p.id}` };
      },
    });
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    const p1 = pipeline.apply(makeProposal({ id: 1, target_path: targetPath }), 'a1', 'cli');
    const p2 = pipeline.apply(makeProposal({ id: 2, target_path: targetPath }), 'a1', 'cli');
    const p3 = pipeline.apply(makeProposal({ id: 3, target_path: targetPath }), 'a1', 'cli');
    await Promise.resolve();
    await Promise.resolve();

    gates[0]!(); await p1;
    gates[1]!(); await p2;
    // Third is still pending — entry must survive with waiters=1.
    expect(lockMap(pipeline).size).toBe(1);
    expect(lockMap(pipeline).get(targetPath)?.waiters).toBe(1);

    gates[2]!(); await p3;
    expect(lockMap(pipeline).size).toBe(0);
  });

  it('prunes per distinct target_path independently', async () => {
    const a = join(tmpDir, 'a.txt');
    const b = join(tmpDir, 'b.txt');
    writeFileSync(a, 'a');
    writeFileSync(b, 'b');
    const sub = new FakeSubject('fake', 'low');
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    await pipeline.apply(makeProposal({ id: 1, target_path: a }), 'a1', 'cli');
    await pipeline.apply(makeProposal({ id: 2, target_path: b }), 'a1', 'cli');
    expect(lockMap(pipeline).size).toBe(0);
  });
});

// ── snapshotInverse routing ───────────────────────────────────────────────

describe('ApplyPipeline — snapshotInverse routing', () => {
  it('routes through subject.snapshotInverse when defined', async () => {
    const targetPath = join(tmpDir, 'target.txt');
    writeFileSync(targetPath, 'disk-content');
    const sub = new FakeSubject('fake', 'low');
    (sub as unknown as { snapshotInverse: (t: string) => Promise<string> })
      .snapshotInverse = async (t: string) => `subject-inverse-for:${t}`;
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    const outcome = await pipeline.apply(makeProposal({ target_path: targetPath }), 'a1', 'cli');
    expect(outcome.revision.inverse_patch.applied_content).toBe(`subject-inverse-for:${targetPath}`);
    // Disk content untouched by the override path:
    expect(outcome.revision.inverse_patch.applied_content).not.toBe('disk-content');
  });

  it('falls back to readTarget when subject does not override snapshotInverse', async () => {
    const targetPath = join(tmpDir, 'target.txt');
    writeFileSync(targetPath, 'disk-content');
    const sub = new FakeSubject('fake', 'low');
    // Confirm no override on prototype or instance
    expect((sub as unknown as { snapshotInverse?: unknown }).snapshotInverse).toBeUndefined();
    registry.registerSubject(sub);
    const pipeline = new ApplyPipeline(registry, db, {
      audit: captureAudit(auditEvents),
      verify: () => true,
    });
    const outcome = await pipeline.apply(makeProposal({ target_path: targetPath }), 'a1', 'cli');
    expect(outcome.revision.inverse_patch.applied_content).toBe('disk-content');
  });
});
