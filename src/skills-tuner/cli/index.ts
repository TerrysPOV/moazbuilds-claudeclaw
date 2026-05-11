#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const program = new Command();
program
  .name('tuner')
  .description('Skills Tuner — continuous improvement platform')
  .version('0.1.0');

// ── doctor ─────────────────────────────────────────────────────────────────────────────
program
  .command('doctor')
  .description('Detect environment and check dependencies')
  .action(async () => {
    const home = homedir();
    const configPath = join(home, '.config', 'tuner', 'config.yaml');
    const secretPath = join(home, '.config', 'tuner', '.secret');
    let allOk = true;

    function check(label: string, ok: boolean, detail?: string) {
      const icon = ok ? '✅' : '❌';
      console.log(`${icon} ${label}${detail ? ': ' + detail : ''}`);
      if (!ok) allOk = false;
    }

    // 1. Config file exists + parses
    const cfgExists = existsSync(configPath);
    check('Config file exists', cfgExists, configPath);

    let config: any = null;
    if (cfgExists) {
      try {
        const { loadConfig } = await import('../core/config.js');
        config = loadConfig(configPath);
        check('Config parses', true);
      } catch (e: unknown) {
        check('Config parses', false, e instanceof Error ? e.message : String(e));
      }
    }

    // 2. storage.git_repo exists + is a git repo
    const gitRepo = config?.storage?.git_repo;
    if (gitRepo) {
      const repoExists = existsSync(gitRepo);
      check('storage.git_repo exists', repoExists, gitRepo);
      if (repoExists) {
        const isGit = existsSync(join(gitRepo, '.git'));
        check('storage.git_repo is a git repo', isGit);
      }
    } else {
      check('storage.git_repo configured', false, 'not set in config');
    }

    // 3. .secret exists + 32 bytes + 0600 perms
    const secretExists = existsSync(secretPath);
    check('Secret file exists', secretExists, secretPath);
    if (secretExists) {
      const st = statSync(secretPath);
      check('Secret is 32 bytes', st.size === 32, `${st.size} bytes`);
      const mode = st.mode & 0o777;
      check('Secret perms are 0600', mode === 0o600, `0${mode.toString(8)}`);
    }

    // 4. Session JSONL files found
    const projectsDir = join(home, '.claude', 'projects');
    if (existsSync(projectsDir)) {
      const jsonlFiles = readdirSync(projectsDir, { recursive: true })
        .filter((f: unknown): f is string => typeof f === 'string' && f.endsWith('.jsonl'));
      check('Session JSONL files found', jsonlFiles.length > 0, `${jsonlFiles.length} files`);
    } else {
      check('~/.claude/projects exists', false);
    }

    // 5. Each enabled subject scan_dirs exist
    if (config?.subjects) {
      for (const [name, subj] of Object.entries(config.subjects as Record<string, any>)) {
        if (!subj?.enabled) continue;
        const dirs: string[] = subj.scan_dirs || [];
        for (const d of dirs) {
          const expanded = d.replace('~', home);
          check(`Subject ${name} scan_dir exists`, existsSync(expanded), expanded);
        }
      }
    }

    console.log(allOk ? '\n✅ All checks passed' : '\n⚠️  Some checks failed');
  });

// ── cron-run ──────────────────────────────────────────────────────────────────────────
program
  .command('cron-run')
  .description('Run detection + proposal cycle')
  .option('--since <duration>', 'time window (e.g. 24h, 7d)', '24h')
  .option('--dry', 'no apply, just show what would be proposed')
  .option('--subject <name>', 'run only this subject')
  .action(async (opts) => {
    const { loadConfig } = await import('../core/config.js');
    const { Engine } = await import('../core/engine.js');
    const { Registry } = await import('../core/registry.js');
    const { ProposalsStore, DEFAULT_PROPOSALS_PATH } = await import('../storage/proposals.js');
    const { RefusedStore, DEFAULT_REFUSED_PATH } = await import('../storage/refused.js');
    const { BranchManager } = await import('../git_ops/branches.js');

    const config = loadConfig();
    const registry = new Registry();
    const proposals = new ProposalsStore(config.storage.proposals_jsonl ?? DEFAULT_PROPOSALS_PATH);
    const refused = new RefusedStore(config.storage.refused_jsonl ?? DEFAULT_REFUSED_PATH);
    const gitRepo = config.storage.git_repo;
    if (!gitRepo) throw new Error('storage.git_repo must be set in config');
    const branches = new BranchManager(gitRepo);
    const engine = new Engine(config, registry, proposals, refused, branches);

    const sinceMs = parseDuration(opts.since);
    const since = new Date(Date.now() - sinceMs);

    console.log(`Running cycle since=${opts.since} dry=${!!opts.dry}`);
    const result = await engine.runCycle({ since, subjectName: opts.subject, dryRun: opts.dry });
    console.log(`Proposed: ${result.proposed}  Auto-applied: ${result.autoApplied}`);
  });

// ── pending ───────────────────────────────────────────────────────────────────────────
program
  .command('pending')
  .description('List pending proposals')
  .action(async () => {
    const { loadConfig } = await import('../core/config.js');
    const { ProposalsStore, DEFAULT_PROPOSALS_PATH } = await import('../storage/proposals.js');

    const config = loadConfig();
    const proposals = new ProposalsStore(config.storage.proposals_jsonl ?? DEFAULT_PROPOSALS_PATH);
    const sigs = proposals.pendingSignatures({});
    if (sigs.size === 0) {
      console.log('No pending proposals.');
      return;
    }
    console.log(`${sigs.size} pending proposal(s):`);
    for (const sig of sigs) {
      console.log(`  ${sig}`);
    }
  });

// ── apply ─────────────────────────────────────────────────────────────────────────────
program
  .command('apply <id> <alt>')
  .description('Apply alternative (alt = alternative ID)')
  .action(async (id: string, alt: string) => {
    const { loadConfig } = await import('../core/config.js');
    const { Engine } = await import('../core/engine.js');
    const { Registry } = await import('../core/registry.js');
    const { ProposalsStore, DEFAULT_PROPOSALS_PATH } = await import('../storage/proposals.js');
    const { RefusedStore, DEFAULT_REFUSED_PATH } = await import('../storage/refused.js');
    const { BranchManager } = await import('../git_ops/branches.js');

    const config = loadConfig();
    const registry = new Registry();
    const proposals = new ProposalsStore(config.storage.proposals_jsonl ?? DEFAULT_PROPOSALS_PATH);
    const refused = new RefusedStore(config.storage.refused_jsonl ?? DEFAULT_REFUSED_PATH);
    const gitRepo = config.storage.git_repo;
    if (!gitRepo) throw new Error('storage.git_repo must be set in config');
    const branches = new BranchManager(gitRepo);
    const engine = new Engine(config, registry, proposals, refused, branches);

    const proposalId = parseInt(id, 10);
    if (isNaN(proposalId)) { console.error('id must be a number'); process.exit(1); }
    await engine.applyProposal(proposalId, alt);
    console.log(`✅ Applied proposal ${id} alternative ${alt}`);
  });

// ── skip ──────────────────────────────────────────────────────────────────────────────
program
  .command('skip <id>')
  .description('Skip (refuse) a proposal')
  .action(async (id: string) => {
    const { loadConfig } = await import('../core/config.js');
    const { Engine } = await import('../core/engine.js');
    const { Registry } = await import('../core/registry.js');
    const { ProposalsStore, DEFAULT_PROPOSALS_PATH } = await import('../storage/proposals.js');
    const { RefusedStore, DEFAULT_REFUSED_PATH } = await import('../storage/refused.js');
    const { BranchManager } = await import('../git_ops/branches.js');

    const config = loadConfig();
    const registry = new Registry();
    const proposals = new ProposalsStore(config.storage.proposals_jsonl ?? DEFAULT_PROPOSALS_PATH);
    const refused = new RefusedStore(config.storage.refused_jsonl ?? DEFAULT_REFUSED_PATH);
    const gitRepo = config.storage.git_repo;
    if (!gitRepo) throw new Error('storage.git_repo must be set in config');
    const branches = new BranchManager(gitRepo);
    const engine = new Engine(config, registry, proposals, refused, branches);

    const proposalId = parseInt(id, 10);
    if (isNaN(proposalId)) { console.error('id must be a number'); process.exit(1); }
    await engine.refuseProposal(proposalId);
    console.log(`⏭️  Skipped proposal ${id}`);
  });

// ── revert ────────────────────────────────────────────────────────────────────────────
program
  .command('revert <id>')
  .description('Revert an applied proposal')
  .action(async (id: string) => {
    const { loadConfig } = await import('../core/config.js');
    const { Engine } = await import('../core/engine.js');
    const { Registry } = await import('../core/registry.js');
    const { ProposalsStore, DEFAULT_PROPOSALS_PATH } = await import('../storage/proposals.js');
    const { RefusedStore, DEFAULT_REFUSED_PATH } = await import('../storage/refused.js');
    const { BranchManager } = await import('../git_ops/branches.js');

    const config = loadConfig();
    const registry = new Registry();
    const proposals = new ProposalsStore(config.storage.proposals_jsonl ?? DEFAULT_PROPOSALS_PATH);
    const refused = new RefusedStore(config.storage.refused_jsonl ?? DEFAULT_REFUSED_PATH);
    const gitRepo = config.storage.git_repo;
    if (!gitRepo) throw new Error('storage.git_repo must be set in config');
    const branches = new BranchManager(gitRepo);
    const engine = new Engine(config, registry, proposals, refused, branches);

    const proposalId = parseInt(id, 10);
    if (isNaN(proposalId)) { console.error('id must be a number'); process.exit(1); }
    await engine.revertProposal(proposalId);
    console.log(`↩️  Reverted proposal ${id}`);
  });

// ── feedback ──────────────────────────────────────────────────────────────────────────
program
  .command('feedback <id> <preferred>')
  .description('Record feedback (yes|yes-but|no)')
  .action(async (id: string, preferred: string) => {
    if (!['yes', 'yes-but', 'no'].includes(preferred)) {
      console.error('preferred must be one of: yes, yes-but, no');
      process.exit(1);
    }
    const { loadConfig } = await import('../core/config.js');
    const { ProposalsStore, DEFAULT_PROPOSALS_PATH } = await import('../storage/proposals.js');
    const { RefusedStore, DEFAULT_REFUSED_PATH } = await import('../storage/refused.js');

    const config = loadConfig();
    const store = new ProposalsStore(config.storage.proposals_jsonl ?? DEFAULT_PROPOSALS_PATH);
    const all = store.readAll();
    const proposalId = parseInt(id, 10);
    if (isNaN(proposalId)) { console.error('id must be a number'); process.exit(1); }
    const record = all.find(r => r?.proposal?.id === proposalId);
    if (!record) { console.error(`Proposal #${id} not found`); process.exit(1); }
    const { auditLog } = await import('../core/security.js');
    if (preferred === 'no') {
      const refused = new RefusedStore(config.storage.refused_jsonl ?? DEFAULT_REFUSED_PATH);
      refused.add(record.proposal.pattern_signature, record.proposal.subject, `feedback:${preferred}`);
      store.append({ proposal: record.proposal, event: 'refused', ts: new Date().toISOString() });
    }
    auditLog('feedback_recorded', { proposal_id: proposalId, preferred });
    console.log(`📝 Feedback recorded: proposal ${id} → ${preferred}`);
  });

// ── stats ─────────────────────────────────────────────────────────────────────────────
program
  .command('stats')
  .description('Show proposal statistics')
  .action(async () => {
    const { loadConfig } = await import('../core/config.js');
    const { ProposalsStore, DEFAULT_PROPOSALS_PATH } = await import('../storage/proposals.js');

    const config = loadConfig();
    const store = new ProposalsStore(config.storage.proposals_jsonl ?? DEFAULT_PROPOSALS_PATH);
    const all = store.readAll();

    const counts = { created: 0, applied: 0, refused: 0 };
    for (const r of all) {
      if (r.event in counts) counts[r.event as keyof typeof counts]++;
    }

    console.log('Proposal statistics:');
    console.log(`  Total records : ${all.length}`);
    console.log(`  Created       : ${counts.created}`);
    console.log(`  Applied       : ${counts.applied}`);
    console.log(`  Refused       : ${counts.refused}`);
  });

// ── setup ─────────────────────────────────────────────────────────────────────────────
program
  .command('setup')
  .description('First-run wizard — copies /tuner skill, generates config')
  .action(async () => {
    const home = homedir();
    const skillsDir = join(home, '.claude', 'skills');
    const targetSkill = join(skillsDir, 'tuner.md');

    if (!existsSync(targetSkill)) {
      const { fileURLToPath } = await import('node:url');
      const __dirname = resolve(fileURLToPath(import.meta.url), '..');
      // Resolve template across contexts: skills-tuner-ts standalone (templates/skills/) OR
      // Plus integration context (src/skills-tuner-templates/)
      const candidates = [
        join(__dirname, '..', '..', 'templates', 'skills', 'tuner.md'),
        join(__dirname, '..', '..', '..', 'templates', 'skills', 'tuner.md'),
        join(__dirname, '..', '..', '..', 'skills-tuner-templates', 'tuner.md'),
        join(__dirname, '..', '..', 'skills-tuner-templates', 'tuner.md'),
      ];
      const templateSrc = candidates.find(p => existsSync(p)) ?? candidates[0]!;
      if (existsSync(templateSrc)) {
        const { mkdirSync, copyFileSync } = await import('node:fs');
        mkdirSync(skillsDir, { recursive: true });
        copyFileSync(templateSrc, targetSkill);
        console.log(`✅ Copied tuner skill to ${targetSkill}`);
      } else {
        console.warn(`⚠️  Template not found at ${templateSrc} — skipping skill copy`);
      }
    } else {
      console.log(`ℹ️  Skill already exists: ${targetSkill}`);
    }

    const configDir = join(home, '.config', 'tuner');
    const configPath = join(configDir, 'config.yaml');
    if (!existsSync(configPath)) {
      const { writeDefaultConfig } = await import('../core/config.js');
      writeDefaultConfig(configPath);
      console.log(`✅ Created default config at ${configPath}`);
    } else {
      console.log(`ℹ️  Config already exists: ${configPath}`);
    }

    console.log('\nRun /tuner inside Claude Code to start the wizard');
  });

// ── helpers ───────────────────────────────────────────────────────────────────────────
function parseDuration(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) return 24 * 60 * 60 * 1000;
  const n = parseInt(m[1] as string, 10);
  switch (m[2]) {
    case 's': return n * 1000;
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}

program.parseAsync(process.argv).catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
