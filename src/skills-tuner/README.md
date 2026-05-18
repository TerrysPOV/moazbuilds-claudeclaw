# skills-tuner-ts

**Continuous, human-in-the-loop improvement platform for Claude Code skills — TypeScript port.**

---

## Status

![tests](https://img.shields.io/badge/tests-99%2B%20passing-brightgreen)
![typescript](https://img.shields.io/badge/TypeScript-strict-blue)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

Phase 1–8 complete. All 99+ unit and integration tests pass.

---

## What is this

Skills Tuner watches your Claude Code session logs, detects patterns where your skills
could be improved, and proposes targeted patches — one at a time, with your approval.
It runs on a cron schedule, signs every proposal with HMAC-SHA256, and keeps a full
JSONL audit trail. External ML optimizers (Optuna, custom Python) plug in via a
stdio JSON-RPC adapter without touching the TypeScript core.

---

## Architecture

```
[ Cron 03:00 ]
       │
       ▼
[ TS Engine ] ── HMAC sign ──> [ JSONL audit + proposals ]
       │
       ├── [ Native subjects: SkillsSubject, VoiceSubject, ... ] ── LLM
       │
       └── [ ExternalProcessSubject ] ──stdio JSON-RPC──> [ Python ML / Optuna / ... ]

[ Adapters ]
   ├── CLI (stdout)
   ├── Telegram (inline keyboard, allowedUserIds gate)
   └── PlusEventAdapter (stub for #31)
```

**Core modules**

| Module | Purpose |
|---|---|
| `src/core/engine.ts` | Orchestration: collect → detect → propose → sign → apply |
| `src/core/security.ts` | HMAC-SHA256 signing + audit log |
| `src/storage/proposals.ts` | Append-only JSONL proposal ledger |
| `src/storage/refused.ts` | TTL-gated refusal store |
| `src/git_ops/branches.ts` | Per-proposal git branches + commits |
| `src/subjects/` | SkillsSubject, ExternalProcessSubject |
| `src/adapters/` | CLI, Telegram, Plus event stub |
| `src/cli/index.ts` | Commander CLI (9 commands) |

---

## Install

```bash
# From npm (once published)
npm install -g @skills-tuner/core

# Or run locally with bun
bun add https://github.com/Nibbler1250/skills-tuner-ts
```

---

## Quick start

```bash
# 1. First-run setup — copies tuner skill + creates default config
tuner setup

# 2. Sanity check — verify config, secret, git repo, JSONL files
tuner doctor

# 3. Dry-run — see what would be proposed without writing anything
tuner cron-run --dry --since 24h

# 4. Real run
tuner cron-run --since 7d

# 5. Review pending proposals
tuner pending

# 6. Apply or skip
tuner apply 1 A
tuner skip 2
```

---

## CLI commands

| Command | Arguments | Description |
|---|---|---|
| `doctor` | — | Check config, secret, git repo, session files |
| `cron-run` | `--since <duration>` `--dry` `--subject <name>` | Run full detect+propose cycle |
| `pending` | — | List pending proposal signatures |
| `apply` | `<id> <alt>` | Apply an alternative (creates git branch + commit) |
| `skip` | `<id>` | Refuse a proposal (TTL-gated, won't re-appear for 30 days) |
| `revert` | `<id>` | Revert an applied proposal via `git revert` |
| `feedback` | `<id> <yes\|yes-but\|no>` | Record preference feedback |
| `stats` | — | Show created / applied / refused counts |
| `setup` | — | First-run wizard: init standard paths (~/.claude/skills, etc.) + copy skill + generate config |

Duration format: `30s`, `10m`, `24h`, `7d`.

---

## Subjects

| Subject | Description |
|---|---|
| `skills` | Parses `.md` skill files, detects stale triggers, missing examples, weak descriptions |
| `voice` | Detects repeated phrasing patterns in voice transcripts |
| `external_process` | Spawns any Python/binary over stdio JSON-RPC — plug in Optuna, custom ML, etc. |

---


---

## Where artifacts land

Per-subject defaults resolve to the **standard discovery paths** read by the consuming
runtime — no custom directories, no symlinks. Skills produced by the tuner are visible
to Claude Code and the ClaudeClaw-Plus daemon out of the box.

| Subject | Default `git_repo` | Standard |
|---|---|---|
| `skills` | `~/.claude/skills/` | Anthropic Skills discovery path |
| `wisecron` | `~/.config/systemd/user/` | XDG path for systemd user units |
| `cron` | `~/.config/cron/` | XDG-config sidecar for `crontab -l` snapshot |
| _tuner state_ | `~/.config/tuner/` | proposals.jsonl, refused.jsonl, .secret |

`tuner setup` creates each path, runs `git init`, snapshots `crontab -l` if non-empty,
and installs the `/tuner` skill in Anthropic dir-format (`<name>/SKILL.md`).

`tuner doctor` verifies the configured `git_repo` for each enabled subject matches the
standard path, and warns if it diverges (set `git_repo:` explicitly in `config.yaml` to
opt out of the warning if you have a deliberate non-standard target).

Override any default by setting `subjects.<name>.git_repo` in `~/.config/tuner/config.yaml`.

---

## Claude Code / Plus integration

Skills Tuner ships a `/tuner` skill (copied by `tuner setup`) that hooks into Claude
Code sessions. The `PlusEventAdapter` (see `src/adapters/plus_event.ts`) emits
structured events to the Plus event bus — enabling real-time proposal notifications
inside your Claude Code UI without polling.

---

## Companion skill

The `/tuner` skill installed by `tuner setup` gives you inline commands inside
Claude Code:

```
/tuner pending      — list proposals
/tuner apply 3 B   — apply alternative B for proposal #3
/tuner stats        — quick stats summary
```

---

## Security model

- Every proposal is signed with **HMAC-SHA256** before being persisted.
  `applyProposal` re-verifies the signature — any tamper is detected and rejected.
- The 32-byte secret lives at `~/.config/tuner/.secret` with `0600` permissions.
  `tuner doctor` verifies this on every run.
- The audit log at `~/.config/tuner/audit.jsonl` records every operation:
  `proposal_created`, `apply_attempted`, `apply_success`, `signature_mismatch`,
  `refused`, `reverted`.
- Refused proposals are TTL-gated (default 30 days) and won't resurface unless
  the underlying skill file is edited after the refusal.

---

## Compliance angle

The JSONL audit trail + HMAC signatures provide a lightweight evidence chain
suitable for regulated environments that require change management records for
AI-generated modifications. Every applied change links back to a git commit SHA
and a signed proposal record.

---

## Migrating from the Python implementation

If you have an existing `~/.config/tuner/proposals.jsonl` from the Python `skills-tuner` package, run the one-shot migration script:

1. Stop the Python cron job (`crontab -e`, remove tuner entry)
2. Uninstall the Python package: `pip uninstall skills-tuner`
3. Run the migration (dry-run first):
   ```bash
   bun run migrate -- --dry-run   # preview changes
   bun run migrate                # apply migration
   ```
4. Verify: `tuner doctor` and `tuner stats`

The script backs up the original file to `proposals.jsonl.python-backup-<timestamp>` before writing. All proposals are re-signed with the current HMAC secret.

---

## Per-subject git repositories

Each subject can declare its own git repository in `~/.config/tuner/config.yaml`:

```yaml
# 'skills' subject defaults resolve to the standard Anthropic discovery path
# (~/.claude/skills/) when omitted. Override only for non-standard layouts.

storage:
  # Top-level fallback for any subject without its own git_repo.
  # Subjects with a SUBJECT_STANDARD_PATHS entry resolve to that instead.
  git_repo: ~/.claude/skills

subjects:
  skills:
    enabled: true
    # git_repo defaults to ~/.claude/skills (Anthropic Skills discovery path)
    # scan_dirs defaults to [~/.claude/skills]
    auto_merge: [patch, frontmatter]
  voice:
    enabled: true
    git_repo: ~/.config/voice-config  # explicit, no standard mapping for 'voice' yet
    auto_merge: false
    scan_dirs: [~/.config/voice-config/lexicons]
  trader-ml-hp:
    enabled: true
    git_repo: ~/Projects/momentum_trader_v7  # trader's own repo
    auto_merge: false                         # critical: never auto
    scan_dirs: [~/Projects/momentum_trader_v7/strategies]
```

> Each subject can have its own `git_repo`. If absent, falls back to `storage.git_repo`. This lets you tune skills, voice config, and trader strategies — each in its own git repo with independent rollback.

**Migration from single `storage.git_repo`**: existing configs continue to work — subjects without `git_repo` use the storage default. To benefit from per-subject isolation, add `git_repo:` per subject in `~/.config/tuner/config.yaml`.

---

## Development

```bash
# Install dependencies
bun install

# Run all tests (unit + integration)
bun test

# Type-check without emitting
bun run typecheck

# Build to dist/
bun run build
```

The `src/` tree is pure TypeScript ESM. Tests live in `tests/unit/` and
`tests/integration/`. No test requires a live LLM — all subjects are mocked.

---

## License

MIT


---

## Schedulers (pluggable scheduling layer)

Some TunableSubjects (`wisecron`, future `cron`) need to create and manage
recurring jobs on the host OS. To support Linux + macOS + containers without
hardcoding any one platform, the tuner ships a pluggable `SchedulerBackend`
abstraction.

### Built-in backends

| Backend | Host | Artifact | Notes |
|---|---|---|---|
| `systemd-user` | Linux with systemd-user | `~/.config/systemd/user/<name>.{timer,service}` | Auto-activates via `systemctl --user`. Injects DBUS env for subprocess contexts. |
| `crontab-posix` | Linux/macOS/BSD with `crontab` | line tagged `# wisecron:<name>` in user crontab; mirror in `~/.config/cron/crontab.snapshot` | The active table is root-managed; the sidecar is what we version. |
| `in-process` | any host | none (lives in the tuner process) | Universal fallback for containers / serverless / dev. Rehydrate from `~/.config/tuner/in-process-jobs.json` at startup. |

### Auto-detection

`detectBackend()` probes registered backends in order and returns the first
one that says `detect() === true`. The default order is `systemd-user` →
`crontab-posix` → `in-process`. Override via env:

```bash
WISECRON_BACKEND=crontab-posix tuner compose-job ...
```

### Compose a job from the CLI

```bash
tuner compose-job \
  --name trader-check \
  --description "every 20 minutes on weekdays 9am-4pm Eastern" \
  --command "/home/u/check-trader.sh"
```

The CLI uses the configured LLM to translate the description into the
backend's native schedule grammar (`OnCalendar=` for systemd, 5-field cron
for POSIX). Use `--dry` to render without writing.

### Adding a new backend

Implement `SchedulerBackend` from `src/skills-tuner/schedulers/base.ts`
and register it in `src/skills-tuner/schedulers/registry.ts`. The
`detect()` method must be non-throwing and fast (<500ms). Backends are
expected to be idempotent on `name` (refuse duplicate create) and
to no-op cleanly when `remove()` is called on a missing job.

Out of scope for this iteration (community contributions welcome):
- `LaunchdBackend` for macOS native (`~/Library/LaunchAgents/*.plist`)
- `TaskSchedulerBackend` for Windows (`schtasks` / PowerShell)
- `KubernetesCronJobBackend` for k8s clusters


---

## WiseCron — intelligent cron monitoring

The `wisecron` subject scans the user crontab on each tick, classifies each
entry (criticality + tag set), and proposes targeted changes:

- **log_path_missing** — a cron without a redirect; proposal adds `>> <logDir>/<name>.log 2>&1`
- **stale_log** — the cron has not written its log in N times its expected interval
- **schedule_outside_relevance** — a tagged-trading job runs 24/7 instead of market hours
- **redundant_schedule** — two crons running the same script at different intervals
- **elevated_error_rate** — log shows >50%% error-keyword density in the recent window

`apply()` modifies the crontab in place (text-level edit + `crontab` CLI). Each
apply commits to a `tune/proposal-<id>` audit branch in the git_repo, then
fast-forward-merges into the base branch (master/main).

Configure via `subjects.wisecron` in `~/.config/tuner/config.yaml`:

Risk tier: medium. Auto-merge is disabled by default — operators approve each
proposal explicitly via the chosen UI adapter (Telegram inline buttons, CLI,
or direct `tuner apply <id> <alt>`).
