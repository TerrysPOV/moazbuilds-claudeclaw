<p align="center">
  <img src="images/claudeclaw-banner.svg" alt="ClaudeClaw Banner" />
</p>
<p align="center">
  <img src="images/claudeclaw-wordmark.png" alt="ClaudeClaw Wordmark" />
</p>

<p align="center">
  <img src="https://awesome.re/badge.svg" alt="Awesome" />
  <a href="https://github.com/moazbuilds/ClaudeClaw/stargazers">
    <img src="https://img.shields.io/github/stars/moazbuilds/ClaudeClaw?style=flat-square&color=f59e0b" alt="GitHub Stars" />
  </a>
  <a href="https://github.com/moazbuilds/ClaudeClaw">
    <img src="https://img.shields.io/static/v1?label=downloads&message=~15k%20every%2014%20days&color=2da44e&style=flat-square" alt="Downloads ~15k every 14 days" />
  </a>
  <a href="https://github.com/moazbuilds/ClaudeClaw/commits/master">
    <img src="https://img.shields.io/github/last-commit/moazbuilds/ClaudeClaw?style=flat-square&color=0ea5e9" alt="Last Commit" />
  </a>
  <a href="https://github.com/moazbuilds/ClaudeClaw/graphs/contributors">
    <img src="https://img.shields.io/github/contributors/moazbuilds/ClaudeClaw?style=flat-square&color=a855f7" alt="Contributors" />
  </a>
  <a href="https://x.com/moazbuilds">
    <img src="https://img.shields.io/badge/X-%40moazbuilds-000000?style=flat-square&logo=x" alt="X @moazbuilds" />
  </a>
</p>

<p align="center"><b>A lightweight, open-source OpenClaw version built into your Claude Code.</b></p>

ClaudeClaw turns your Claude Code into a personal assistant that never sleeps. It runs as a background daemon, executing tasks on a schedule, responding to messages on Telegram and Discord, transcribing voice commands, and integrating with any service you need.

> Note: Please don't use ClaudeClaw for hacking any bank system or doing any illegal activities. Thank you.

## Why ClaudeClaw?

| Category | ClaudeClaw | OpenClaw |
| --- | --- | --- |
| Anthropic Will Come After You | No | Yes |
| API Overhead | Directly uses your Claude Code subscription | Nightmare |
| Setup & Installation | ~5 minutes | Nightmare |
| Deployment | Install Claude Code on any device or VPS and run | Nightmare |
| Isolation Model | Folder-based and isolated as needed | Global by default (security nightmare) |
| Reliability | Simple reliable system for agents | Bugs nightmare |
| Feature Scope | Lightweight features you actually use | 600k+ LOC nightmare |
| Security | Average Claude Code usage | Nightmare |
| Cost Efficiency | Efficient usage | Nightmare |
| Memory | Uses Claude internal memory system + `CLAUDE.md` | Nightmare |

## Getting Started in 5 Minutes

```bash
claude plugin marketplace add moazbuilds/claudeclaw
claude plugin install claudeclaw
```
Then open a Claude Code session and run:
```
/claudeclaw:start
```
The setup wizard walks you through model, heartbeat, Telegram, Discord, and security, then your daemon is live with a web dashboard.

## v2.0 Milestone Complete ✓

**All phases complete** — ClaudeClaw v2.0 is fully verified with:
- **574 tests passing (99.5% pass rate)**
- **Security hardening applied** (rate limiting, file size limits, CSRF protection, log injection prevention)
- **Code simplification** applied across core modules

### Contributor Note: Plugin Version Metadata

If you change shipped plugin files under `src/`, `commands/`, `prompts/`, or `.claude-plugin/`, the plugin metadata version may also need to be bumped so Claude Code and marketplace consumers detect the update correctly.

Helpers:

```bash
bun run bump:plugin-version
bun run bump:marketplace-version
```

Docs-only and other non-shipped changes do not require these bumps.

## What Would Be Built Next?

> **Mega Post:** Help shape the next ClaudeClaw features.
> Vote, suggest ideas, and discuss priorities in **[this post](https://github.com/moazbuilds/ClaudeClaw/issues/14)**.

<p align="center">
  <a href="https://github.com/moazbuilds/ClaudeClaw/issues/14">
    <img src="https://img.shields.io/badge/Roadmap-Mega%20Post-blue?style=for-the-badge&logo=github" alt="Roadmap Mega Post" />
  </a>
</p>

## Features

### Automation
- **Heartbeat:** Periodic check-ins with configurable intervals, quiet hours, and editable prompts.
- **Cron Jobs:** Timezone-aware schedules for repeating or one-time tasks with reliable execution.

### Communication
- **Telegram:** Text, image, and voice support.
- **Discord:** DMs, server mentions/replies, slash commands, voice messages, and image attachments.
- **Time Awareness:** Message time prefixes help the agent understand delays and daily patterns.

### Multi-Session Threads (Discord)
- **Independent Thread Sessions:** Each Discord thread gets its own Claude CLI session, fully isolated from the main channel.
- **Parallel Processing:** Thread conversations run concurrently — messages in different threads don't block each other.
- **Auto-Create:** First message in a new thread automatically bootstraps a fresh session. No setup needed.
- **Session Cleanup:** Thread sessions are automatically cleaned up when threads are deleted or archived.
- **Backward Compatible:** DMs and main channel messages continue using the global session.

See [docs/MULTI_SESSION.md](docs/MULTI_SESSION.md) for technical details.

### Reliability and Control
- **GLM Fallback:** Automatically continue with GLM models if your primary limit is reached.
- **Web Dashboard:** Manage jobs, monitor runs, and inspect logs in real time.
- **Security Levels:** Four access levels from read-only to full system access.
- **Model Selection:** Switch models based on your workload.

## Architecture

### Core Modules

```
src/
├── event-log.ts          # Append-only event log with daily rotation
├── event-processor.ts    # Event dispatch and processing
├── retry-queue.ts        # Retry handling with exponential backoff
├── dead-letter-queue.ts  # Failed event DLQ
├── replay.ts             # Event replay capability
├── gateway/              # Session mapping and routing layer
│   ├── index.ts          # Gateway orchestrator
│   ├── session-map.ts    # Per-channel+thread session isolation
│   ├── normalizer.ts     # Unified event schema
│   └── resume.ts         # Session resume logic
├── policy/               # Policy engine
│   ├── engine.ts         # Rule evaluation
│   ├── channel-policies.ts  # Per-channel overrides
│   ├── skill-overlays.ts    # Skill-specific constraints
│   ├── approval-queue.ts     # Durable approval workflow
│   └── audit-log.ts          # Audit trail
├── governance/            # Cost and model governance
│   ├── usage-tracker.ts   # Per-invocation usage records
│   ├── budget-engine.ts   # Budget evaluation (warn/degrade/block)
│   ├── model-router.ts    # Governance-aware routing
│   ├── watchdog.ts        # Runaway detection
│   ├── telemetry.ts       # Governance metrics
│   └── client.ts          # Unified GovernanceClient interface
├── orchestrator/          # Task orchestration
│   ├── task-graph.ts      # Graph validation and sorting
│   ├── workflow-state.ts  # Crash-safe state persistence
│   ├── executor.ts        # Task execution
│   ├── resumable-jobs.ts  # Job scheduling
│   ├── governance-adapter.ts  # Governance bridge
│   └── telemetry.ts        # Orchestration metrics
├── escalation/            # Human escalation
│   ├── pause.ts           # Pause/resume modes
│   ├── handoff.ts         # Structured handoff packages
│   ├── notifications.ts    # 7 notification types
│   ├── triggers.ts        # Policy-driven escalation
│   └── status.ts          # Status aggregation
├── commands/              # Channel adapters
│   ├── telegram.ts        # Telegram integration
│   └── discord.ts         # Discord integration
├── adapters/              # Additional channel adapters (scaffolds)
│   ├── slack/             # Slack adapter (future)
│   ├── teams/             # Teams adapter (future)
│   ├── email/             # Email adapter (future)
│   └── github/            # GitHub adapter (future)
└── ui/                    # Web dashboard
```

### Data Storage

All state stored in `.claude/claudeclaw/`:
```
.claude/claudeclaw/
├── event-log/           # Append-only event log (rotated daily)
├── retry-queue.json     # Retry queue state
├── dlq.jsonl           # Dead letter queue
├── session-map.json     # Channel→session mappings
├── audit-log.jsonl      # Policy decision audit trail
├── usage/               # Per-session usage accounting
├── workflows/           # Persisted workflow state
├── paused.json          # Pause state flag
├── jobs/                # Scheduled job definitions
└── logs/                # Run logs
```

## Configuration

### Settings File

ClaudeClaw stores settings in `.claude/claudeclaw/settings.json`:

```json
{
  "model": "claude-sonnet-4-20250514",
  "api": "https://api.anthropic.com",
  "fallback": {
    "model": "claude-3-5-haiku-20241022",
    "api": "https://api.anthropic.com"
  },
  "agentic": {
    "enabled": true,
    "defaultMode": "implementation",
    "modes": [
      {
        "name": "planning",
        "model": "claude-opus-4-20250514",
        "keywords": ["plan", "design", "architect", "strategy"]
      },
      {
        "name": "implementation",
        "model": "claude-sonnet-4-20250514",
        "keywords": ["implement", "code", "write", "create", "build"]
      }
    ]
  },
  "timezone": "America/New_York",
  "timezoneOffsetMinutes": -240,
  "heartbeat": {
    "enabled": true,
    "interval": 15,
    "prompt": "How's everything going?",
    "excludeWindows": [],
    "forwardToTelegram": true
  },
  "telegram": {
    "token": "123456:ABC-DEF...",
    "allowedUserIds": [123456789]
  },
  "discord": {
    "token": "ABC123...",
    "allowedUserIds": ["123456789012345678"],
    "listenChannels": []
  },
  "security": {
    "level": "moderate",
    "allowedTools": [],
    "disallowedTools": []
  },
  "web": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 4632
  },
  "stt": {
    "baseUrl": "",
    "model": ""
  }
}
```

### Security Levels

| Level | Description |
|-------|-------------|
| `locked` | Only allow explicitly listed tools |
| `strict` | Allow all tools except dangerous ones |
| `moderate` | Allow most tools with some restrictions |
| `unrestricted` | Full access (not recommended) |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `USE_GATEWAY` | Enable gateway layer for event routing | `false` |
| `USE_GATEWAY_TELEGRAM` | Route Telegram through gateway | `false` |
| `USE_GATEWAY_DISCORD` | Route Discord through gateway | `false` |

### Feature Flags

Gateway routing is controlled by environment variables:
```bash
# Enable gateway for all events
USE_GATEWAY=true

# Enable gateway only for specific channels
USE_GATEWAY_TELEGRAM=true
USE_GATEWAY_DISCORD=true
```

## Security Features

### Rate Limiting
- **Telegram:** 30 messages/minute per user
- **Discord:** 30 messages/minute per user
- In-memory tracking with automatic cleanup

### File Upload Protection
- **25MB maximum** file size for all attachments
- Prevents disk exhaustion attacks

### Filename Sanitization
- Removes null bytes, path traversal sequences (`../`), and unsafe characters
- Prevents path traversal attacks

### CSRF Protection
- Token validation on all web UI state-changing endpoints:
  - `/api/settings/heartbeat`
  - `/api/jobs/quick`
  - `/api/chat`
- Tokens expire after 1 hour

### Log Injection Prevention
- All user-controlled fields sanitized before logging
- Prevents log forgery attacks

## Development

### Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test src/__tests__/gateway/index.test.ts

# Run with coverage
bun test --coverage
```

**Test Suite Status:** 574/577 tests passing (99.5%)

### Project Structure

```
moazbuilds-claudeclaw/
├── src/
│   ├── __tests__/           # Test files (co-located with source)
│   ├── commands/            # Telegram, Discord adapters
│   ├── gateway/             # Session mapping layer
│   ├── policy/              # Policy engine
│   ├── governance/          # Cost + model governance
│   ├── orchestrator/        # Task graph + workflow
│   ├── escalation/          # Human escalation
│   ├── adapters/            # Additional channel adapters
│   └── ui/                  # Web dashboard
├── .planning/               # GSD planning artifacts
├── .claude-plugin/          # Claude Code plugin manifest
├── package.json
├── tsconfig.json
└── bun.lock
```

### Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | **Bun** | Fast startup, native TypeScript, ESM-first |
| Package Manager | **Bun** | Native workspace, fast installs |
| Language | **TypeScript** | Type safety, IDE support |
| Module System | **ESM** | Native async, tree-shaking |
| Persistence | **Flat JSON/JSONL** | Zero dependencies, human-readable |
| Test Runner | **Bun test** | Built-in, fast, Jest-compatible |

### Key Design Decisions

1. **Flat files over database** — Zero external dependencies, easy backup/restore
2. **Bun over Node.js** — Faster startup, native TypeScript
3. **ESM over CommonJS** — Tree-shaking, top-level await
4. **Additive only** — No breaking changes to existing modules

## FAQ

<details open>
  <summary><strong>Can ClaudeClaw do &lt;something&gt;?</strong></summary>
  <p>
    If Claude Code can do it, ClaudeClaw can do it too. ClaudeClaw adds cron jobs,
    heartbeats, and Telegram/Discord bridges on top. You can also give your ClaudeClaw new
    skills and teach it custom workflows.
  </p>
</details>

<details open>
  <summary><strong>Is this project breaking Anthropic ToS?</strong></summary>
  <p>
    No. ClaudeClaw is local usage inside the Claude Code ecosystem. It wraps Claude Code
    directly and does not require third-party OAuth outside that flow.
    If you build your own scripts to do the same thing, it would be the same.
  </p>
</details>

<details open>
  <summary><strong>Will Anthropic sue you for building ClaudeClaw?</strong></summary>
  <p>
    I hope not.
  </p>
</details>

<details open>
  <summary><strong>Are you ready to change this project name?</strong></summary>
  <p>
    If it bothers Anthropic, I might rename it to OpenClawd. Not sure yet.
  </p>
</details>

## Screenshots

### Claude Code Folder-Based Status Bar
![Claude Code folder-based status bar](images/bar.png)

### Cool UI to Manage and Check Your ClaudeClaw
![Cool UI to manage and check your ClaudeClaw](images/dashboard.png)

## Contributors

Thanks for helping make ClaudeClaw better.

<a href="https://github.com/moazbuilds/ClaudeClaw/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=moazbuilds/ClaudeClaw" />
</a>
