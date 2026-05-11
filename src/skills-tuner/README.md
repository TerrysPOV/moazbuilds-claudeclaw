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
| `setup` | — | First-run wizard: copy skill template + generate config |

Duration format: `30s`, `10m`, `24h`, `7d`.

---

## Subjects

| Subject | Description |
|---|---|
| `skills` | Parses `.md` skill files, detects stale triggers, missing examples, weak descriptions |
| `voice` | Detects repeated phrasing patterns in voice transcripts |
| `external_process` | Spawns any Python/binary over stdio JSON-RPC — plug in Optuna, custom ML, etc. |

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
storage:
  git_repo: ~/agent/skills        # default fallback

subjects:
  skills:
    enabled: true
    git_repo: ~/agent/skills      # explicit (matches default here)
    auto_merge: [patch, frontmatter]
    scan_dirs: [~/agent/skills]
  voice:
    enabled: true
    git_repo: ~/agent/voice-config  # different repo for voice
    auto_merge: false
    scan_dirs: [~/agent/voice-config/lexicons]
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
