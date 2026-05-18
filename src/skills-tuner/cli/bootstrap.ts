import { homedir } from 'node:os';
import { Engine } from '../core/engine.js';
import { Registry } from '../core/registry.js';
import { ProposalsStore, DEFAULT_PROPOSALS_PATH } from '../storage/proposals.js';
import { RefusedStore, DEFAULT_REFUSED_PATH } from '../storage/refused.js';
import { BranchManager } from '../git_ops/branches.js';
import { SkillsSubject, type SkillOverride } from '../subjects/skills.js';
import { WiseCronSubject } from '../subjects/wisecron.js';
import type { TunerConfig } from '../core/config.js';

export interface EngineBundle {
  engine: Engine;
  registry: Registry;
  proposals: ProposalsStore;
  refused: RefusedStore;
  branches: BranchManager;
}

/**
 * Build a fully wired Engine with native subjects registered from config.
 *
 * Without this, CLI commands instantiate an empty Registry and runCycle()
 * sees zero subjects — no proposals, no drift detection. Every CLI command
 * that needs an Engine MUST go through this function.
 */
export function bootstrapEngine(config: TunerConfig): EngineBundle {
  const registry = new Registry();
  const proposals = new ProposalsStore(config.storage.proposals_jsonl ?? DEFAULT_PROPOSALS_PATH);
  const refused = new RefusedStore(config.storage.refused_jsonl ?? DEFAULT_REFUSED_PATH);
  const gitRepo = config.storage.git_repo;
  if (!gitRepo) throw new Error('storage.git_repo must be set in config');
  const branches = new BranchManager(gitRepo);
  const engine = new Engine(config, registry, proposals, refused, branches);

  registerNativeSubjects(registry, config);

  return { engine, registry, proposals, refused, branches };
}

function registerNativeSubjects(registry: Registry, config: TunerConfig): void {
  const skillsCfg = config.subjects['skills'];
  if (skillsCfg && skillsCfg.enabled !== false) {
    const scanDirs = (skillsCfg.scan_dirs ?? []).map(d => d.replace(/^~/, homedir()));
    const overrides = (skillsCfg.overrides ?? {}) as Record<string, SkillOverride>;
    const language = config.proposer?.language_preference ?? 'en';
    registry.registerSubject(new SkillsSubject({ scanDirs, overrides, language }));
  }

  // wisecron: monitors crontab and proposes targeted changes (log redirection,
  // schedule restriction, dead-cron removal). Operators tweak behavior via
  // subjects.wisecron.overrides in config.yaml — see WiseCronSubjectConfig.
  const wisecronCfg = config.subjects['wisecron'];
  if (wisecronCfg && wisecronCfg.enabled !== false) {
    const overrides = (wisecronCfg.overrides ?? {}) as { log_dir?: string };
    registry.registerSubject(
      new WiseCronSubject(overrides.log_dir ? { logDir: overrides.log_dir } : {}),
    );
  }
}
