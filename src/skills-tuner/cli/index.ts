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

    // 2b. Per-subject git_repo alignment with standard discovery paths (issue #52)
    if (config) {
      const { subjectConfig, isStandardPath, SUBJECT_STANDARD_PATHS } =
        await import('../core/config.js');
      for (const name of Object.keys(SUBJECT_STANDARD_PATHS)) {
        const sub = subjectConfig(config, name);
        if (!sub.enabled) continue;
        const standard = SUBJECT_STANDARD_PATHS[name]?.git_repo;
        if (sub.git_repo && standard) {
          const aligned = isStandardPath(name, sub.git_repo);
          if (aligned) {
            check(`Subject ${name} git_repo on standard path`, true, sub.git_repo);
          } else {
            check(
              `Subject ${name} git_repo on standard path`,
              false,
              `${sub.git_repo} ≠ ${standard} — run 'tuner setup' to align or override intentionally`,
            );
          }
        }
      }
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
    const { bootstrapEngine } = await import('./bootstrap.js');
    const config = loadConfig();
    const { engine, proposals } = bootstrapEngine(config);

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
    const { bootstrapEngine } = await import('./bootstrap.js');
    const config = loadConfig();
    const { engine, proposals } = bootstrapEngine(config);

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
    const { bootstrapEngine } = await import('./bootstrap.js');
    const config = loadConfig();
    const { engine, proposals } = bootstrapEngine(config);

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
    const { bootstrapEngine } = await import('./bootstrap.js');
    const config = loadConfig();
    const { engine, proposals } = bootstrapEngine(config);

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
  .description('First-run wizard — initializes standard discovery paths, copies /tuner skill, generates config')
  .action(async () => {
    const home = homedir();
    const { mkdirSync, copyFileSync, writeFileSync } = await import('node:fs');
    const { execSync } = await import('node:child_process');
    const {
      DEFAULT_SKILLS_DIR,
      DEFAULT_SYSTEMD_USER_DIR,
      DEFAULT_CRONTAB_DIR,
    } = await import('../core/config.js');

    function ensureGitRepo(dir: string, label: string, initFn?: () => void): void {
      mkdirSync(dir, { recursive: true });
      if (initFn) initFn();
      if (!existsSync(join(dir, '.git'))) {
        try {
          execSync('git init', { cwd: dir, stdio: 'pipe' });
          // Commit only if there is content to track (avoids empty-repo first commit).
          const entries = readdirSync(dir).filter(f => f !== '.git');
          if (entries.length > 0) {
            execSync('git add -A', { cwd: dir, stdio: 'pipe' });
            execSync(
              `git -c user.name=tuner -c user.email=tuner@localhost commit -m "init: ${label} tracker"`,
              { cwd: dir, stdio: 'pipe' },
            );
          }
          console.log(`✅ Initialized git repo: ${dir}`);
        } catch (e: unknown) {
          console.warn(
            `⚠️  Could not init git repo at ${dir}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      } else {
        console.log(`ℹ️  Already a git repo: ${dir}`);
      }
    }

    // 1. Skills standard dir (~/.claude/skills/) — Anthropic Skills discovery path.
    ensureGitRepo(DEFAULT_SKILLS_DIR, 'tuned skills');

    // 2. systemd user units (~/.config/systemd/user/) — only if dir already populated,
    //    otherwise skip silently (systems without systemd or empty installs).
    if (existsSync(DEFAULT_SYSTEMD_USER_DIR)) {
      const units = readdirSync(DEFAULT_SYSTEMD_USER_DIR).filter(f =>
        f.endsWith('.service') || f.endsWith('.timer'),
      );
      if (units.length > 0) {
        ensureGitRepo(DEFAULT_SYSTEMD_USER_DIR, 'systemd user units (wisecron target)');
      } else {
        console.log(`ℹ️  Skipping ${DEFAULT_SYSTEMD_USER_DIR} — no unit files`);
      }
    } else {
      console.log(`ℹ️  Skipping ${DEFAULT_SYSTEMD_USER_DIR} — directory absent`);
    }

    // 3. POSIX crontab sidecar (~/.config/cron/) — snapshot only if user has a crontab.
    ensureGitRepo(DEFAULT_CRONTAB_DIR, 'user crontab snapshot', () => {
      const snapshotPath = join(DEFAULT_CRONTAB_DIR, 'crontab.snapshot');
      if (existsSync(snapshotPath)) return;
      try {
        const out = execSync('crontab -l', { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
        writeFileSync(snapshotPath, out, 'utf8');
        console.log(`✅ Snapshotted crontab → ${snapshotPath}`);
      } catch {
        // No crontab or crontab not installed — write empty placeholder so git repo has content.
        writeFileSync(
          snapshotPath,
          '# No active crontab when this snapshot was created.\n# Re-run `tuner setup` after adding entries.\n',
          'utf8',
        );
      }
    });

    // 4. Tuner skill — install as Anthropic dir-format (<name>/SKILL.md), not flat .md.
    const skillDir = join(DEFAULT_SKILLS_DIR, 'tuner');
    const targetSkill = join(skillDir, 'SKILL.md');
    if (!existsSync(targetSkill)) {
      const { fileURLToPath } = await import('node:url');
      const __dirname = resolve(fileURLToPath(import.meta.url), '..');
      const candidates = [
        join(__dirname, '..', '..', 'templates', 'skills', 'tuner.md'),
        join(__dirname, '..', '..', '..', 'templates', 'skills', 'tuner.md'),
        join(__dirname, '..', '..', '..', 'skills-tuner-templates', 'tuner.md'),
        join(__dirname, '..', '..', 'skills-tuner-templates', 'tuner.md'),
      ];
      const templateSrc = candidates.find(p => existsSync(p)) ?? candidates[0]!;
      if (existsSync(templateSrc)) {
        mkdirSync(skillDir, { recursive: true });
        copyFileSync(templateSrc, targetSkill);
        console.log(`✅ Installed tuner skill → ${targetSkill}`);
      } else {
        console.warn(`⚠️  Template not found at ${templateSrc} — skipping skill copy`);
      }
    } else {
      console.log(`ℹ️  Tuner skill already installed: ${targetSkill}`);
    }

    // 5. Tuner config (~/.config/tuner/config.yaml).
    const configDir = join(home, '.config', 'tuner');
    const configPath = join(configDir, 'config.yaml');
    if (!existsSync(configPath)) {
      const { writeDefaultConfig } = await import('../core/config.js');
      writeDefaultConfig(configPath);
      console.log(`✅ Created default config: ${configPath}`);
    } else {
      console.log(`ℹ️  Config already exists: ${configPath}`);
    }

    // 6. Final summary — show where things live.
    console.log('\n📍 Tracked paths:');
    console.log(`   skills    → ${DEFAULT_SKILLS_DIR}`);
    console.log(`   wisecron  → ${DEFAULT_SYSTEMD_USER_DIR}`);
    console.log(`   cron      → ${DEFAULT_CRONTAB_DIR}`);
    console.log(`   config    → ${configPath}`);
    console.log("\nRun 'tuner doctor' to verify, or invoke /tuner inside Claude Code.");
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

// ── compose-job ───────────────────────────────────────────────────────────────────────
program
  .command('compose-job')
  .description('Create a scheduled job from a natural-language description, using the auto-detected SchedulerBackend')
  .requiredOption('--name <name>', 'job name (lowercase, hyphens, max 63 chars)')
  .requiredOption('--description <text>', 'schedule in natural language')
  .requiredOption('--command <cmd>', 'shell command to run on each tick')
  .option('--backend <name>', 'force a backend: systemd-user | crontab-posix | in-process')
  .option('--dry', 'render without writing')
  .action(async (opts: { name: string; description: string; command: string; backend?: string; dry?: boolean }) => {
    const { detectBackend } = await import('../schedulers/registry.js');
    const { loadConfig } = await import('../core/config.js');
    const { makeLLMClient } = await import('../core/llm.js');

    if (opts.backend) {
      // detectBackend() caches its result; reset before honoring the explicit
      // backend so a subsequent call with a different backend is not silently ignored.
      const { resetBackendRegistry } = await import('../schedulers/registry.js');
      resetBackendRegistry();
      process.env['WISECRON_BACKEND'] = opts.backend;
    }
    const backend = await detectBackend();
    const isSystemd = backend.name === 'systemd-user';

    let llm;
    try { llm = makeLLMClient(loadConfig()); }
    catch (e) { console.error('LLM unavailable:', e instanceof Error ? e.message : String(e)); process.exit(1); }

    const system = isSystemd
      ? "You convert short human descriptions of a recurring schedule into a single systemd OnCalendar= clause. Output ONLY the OnCalendar value — no prefix, no quotes, no explanation. Examples:\n  'every 15 minutes' -> *:0/15\n  'every day at 7am' -> *-*-* 07:00:00\n  'every weekday at 9:30am Eastern' -> Mon..Fri *-*-* 13:30:00 UTC\nConvert timezone abbreviations to UTC and append ' UTC'."
      : "You convert short human descriptions of a recurring schedule into a single POSIX cron expression (5 fields: min h dom mon dow). Output ONLY the 5 fields separated by single spaces — no prefix, no quotes, no explanation. Examples:\n  'every 15 minutes' -> */15 * * * *\n  'every day at 7am' -> 0 7 * * *\n  'every weekday at 9:30am Eastern' -> 30 13 * * 1-5\nConvert timezone abbreviations to UTC.";

    const raw = await llm.call('intent_classifier', system, [{ role: 'user', content: opts.description }], 100);
    const schedule = raw.trim().split('\n')[0]?.trim() ?? '';
    if (!schedule) { console.error('LLM returned empty schedule'); process.exit(1); }

    const spec = { name: opts.name, description: opts.description, schedule, command: opts.command };

    if (opts.dry) {
      const rendered = backend.render(spec);
      console.log(`Backend: ${backend.name}`);
      console.log(`Schedule: ${schedule}`);
      console.log(`Summary: ${rendered.summary}`);
      for (const [path, content] of Object.entries(rendered.files)) {
        console.log(`\n--- ${path} ---\n${content}`);
      }
      return;
    }

    const result = await backend.create(spec);
    console.log(`✅ Created job '${opts.name}' via ${backend.name}`);
    console.log(`   schedule: ${schedule}`);
    if (result.artifactPath) console.log(`   artifact: ${result.artifactPath}`);
    const repo = backend.gitRepoPath();
    if (repo) console.log(`   git_repo: ${repo} (commit it with your usual workflow)`);
  });

program.parseAsync(process.argv).catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
