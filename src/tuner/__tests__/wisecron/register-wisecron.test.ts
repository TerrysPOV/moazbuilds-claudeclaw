import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWisecronSubjects } from '../../wisecron/index.js';
import { Registry } from '../../../skills-tuner/core/registry.js';
import { WisecronSettingsSchema } from '../../wisecron/types.js';

let tmpDir: string;
let warnSpy: { calls: string[]; restore: () => void };

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wisecron-register-'));
  const original = console.warn;
  const calls: string[] = [];
  console.warn = (...args: unknown[]) => {
    calls.push(args.map(a => String(a)).join(' '));
  };
  warnSpy = { calls, restore: () => { console.warn = original; } };
});

afterEach(() => {
  warnSpy.restore();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeSettings() {
  return WisecronSettingsSchema.parse({
    enabled: true,
    db_path: join(tmpDir, 'wisecron.db'),
  });
}

describe('registerWisecronSubjects — healthProbe boot warning', () => {
  it('emits a warning for each high/medium-risk subject without healthProbe', () => {
    const registry = new Registry();
    registerWisecronSubjects(registry, makeSettings());

    // cron (high), hook (high), claude_md (medium), mcp_plugin (medium),
    // model_routing (medium) all currently ship without healthProbe.
    const matchingWarnings = warnSpy.calls.filter(c =>
      /\[tuner\] subject '\w+' \(risk=(high|medium)\) has no healthProbe/.test(c),
    );
    expect(matchingWarnings.length).toBeGreaterThanOrEqual(5);
    expect(matchingWarnings.some(c => /risk=high.*'cron'/.test(c) || /'cron'.*risk=high/.test(c))).toBe(true);
    expect(matchingWarnings.some(c => /'hook'/.test(c))).toBe(true);
  });

  it('does not warn for low-risk subjects', () => {
    const registry = new Registry();
    registerWisecronSubjects(registry, makeSettings());

    // agent, memory, prompt_template are low-risk — no warning expected.
    expect(warnSpy.calls.some(c => /'agent'/.test(c) && /healthProbe/.test(c))).toBe(false);
    expect(warnSpy.calls.some(c => /'memory'/.test(c) && /healthProbe/.test(c))).toBe(false);
    expect(warnSpy.calls.some(c => /'prompt_template'/.test(c) && /healthProbe/.test(c))).toBe(false);
  });

  it('honors disabled subjects (no warning fired for disabled high-risk subject)', () => {
    const registry = new Registry();
    const settings = WisecronSettingsSchema.parse({
      enabled: true,
      db_path: join(tmpDir, 'wisecron.db'),
      subjects: { cron: { enabled: false }, hook: { enabled: false } },
    });
    registerWisecronSubjects(registry, settings);

    expect(warnSpy.calls.some(c => /'cron'/.test(c) && /healthProbe/.test(c))).toBe(false);
    expect(warnSpy.calls.some(c => /'hook'/.test(c) && /healthProbe/.test(c))).toBe(false);
  });

  it('suppresses the warning when subject defines its own healthProbe', () => {
    const registry = new Registry();
    // Spy a subject in flight: monkey-patch CronSubject prototype to add a
    // healthProbe stub via the registry side-channel. Since registerWisecronSubjects
    // owns instantiation, we patch the prototype before calling it.
    const { CronSubject } = require('../../subjects/cron-subject.js');
    const original = CronSubject.prototype.healthProbe;
    CronSubject.prototype.healthProbe = async () => ({ failed: false, errors: [] });
    try {
      registerWisecronSubjects(registry, makeSettings());
      expect(warnSpy.calls.some(c => /'cron'/.test(c) && /healthProbe/.test(c))).toBe(false);
    } finally {
      if (original === undefined) delete CronSubject.prototype.healthProbe;
      else CronSubject.prototype.healthProbe = original;
    }
  });
});
