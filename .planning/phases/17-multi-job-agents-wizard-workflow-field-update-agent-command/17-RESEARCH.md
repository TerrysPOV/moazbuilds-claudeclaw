# Phase 17: Multi-job agents, wizard workflow field, update-agent command — Research

**Researched:** 2026-04-06
**Domain:** ClaudeClaw agent runtime extension (existing Bun/TypeScript codebase)
**Confidence:** HIGH (existing codebase fully read; no new external libraries; all changes are additive extensions of Phase 16)

## Summary

Phase 17 extends the freshly shipped Phase 16 agent system. The four headline changes — multi-job per agent, wizard `Workflow` field, `/claudeclaw:update-agent` command, broader NL→cron parser — are all **strictly additive** modifications to five existing files plus two new skill files. There is no new module, no new dependency, no new architecture. The most non-trivial work is (a) the runtime job-discovery shim that scans `agents/*/jobs/*.md` in addition to the flat `.claude/claudeclaw/jobs/` directory and (b) the auto-migration that moves a Phase 16 single-job file (`.claude/claudeclaw/jobs/<name>.md`) into `agents/<name>/jobs/default.md` on first daemon start.

The current `parseScheduleToCron` (`src/agents.ts:98-156`) already handles 9 presets. Phase 17 needs ~5 more regex branches (every day at <time>, twice daily, every N hours, every Monday at <time>, midnight/noon/morning aliases). The current Phase 16 wizard (`skills/create-agent/SKILL.md`) collapses "operational instructions" into the schedule answer — Phase 17 splits this into two distinct fields (Workflow → SOUL.md/CLAUDE.md, Schedule → cron only) and adds a "scheduled tasks loop" so users can register N jobs in one wizard run.

The hardest invariant to honor: `/claudeclaw:update-agent` MUST NEVER touch `agents/<name>/MEMORY.md`. Memory accumulates per-agent state across runs and is gitignored locally — overwriting it would erase the agent's accumulated context. The update-agent command must do selective field updates against IDENTITY.md / SOUL.md / CLAUDE.md / job files only.

**Primary recommendation:** Treat Phase 17 as four parallel, independent tracks (data model + runtime, parser broadening, wizard restructure, update command) wired together by a small migration shim. Single Bun/TypeScript stack, no new deps, TDD where test infra exists (`agents.test.ts`, `sessions.test.ts`), integration verification for `jobs.ts`/runtime via full-suite delta diffs.

<phase_requirements>
## Phase Requirements

The roadmap entry for Phase 17 doesn't carry pre-assigned REQ-IDs — they should be derived during `/gsd:plan-phase 17`. Suggested derivation from the ROADMAP scope block:

| Suggested ID | Description | Research Support |
|----|-------------|-----------------|
| AGENT-MULTI-01 | Agents own a `jobs/` subdirectory with N job files (label, cron, enabled, optional model, trigger prompt) | §3 Job File Format; §4 Runtime Job Discovery |
| AGENT-MULTI-02 | Deleting an agent deletes all of that agent's jobs | §6 Update-Agent Command (delete-agent op) |
| WIZARD-01 | Wizard captures `Workflow` as a dedicated multi-line field, separate from cron schedule, written into SOUL.md / CLAUDE.md | §5 Wizard Restructure |
| WIZARD-02 | Wizard supports a "scheduled tasks loop" — user adds N jobs (label + cron + trigger prompt), each producing one file under `agents/<name>/jobs/<label>.md` | §5 Wizard Restructure |
| WIZARD-03 | Wizard captures optional `model` field (default / opus / haiku) per job and writes it into job frontmatter | §3 Job File Format |
| CRON-01 | NL→cron parser handles `every day at 7pm`, `every weekday at 9am`, `twice daily`, `hourly`, `every Monday`, plus existing presets | §2 NL→Cron Parser Broadening |
| UPDATE-01 | New `/claudeclaw:update-agent` skill: lists agents, loads current config, offers menu (workflow / personality / add-job / edit-job / remove-job / discord / model / delete-agent) | §6 Update-Agent Command |
| UPDATE-02 | Update-agent command MUST NEVER read, write, or delete `agents/<name>/MEMORY.md` | §6 Update-Agent Command — Invariants |
| RUNTIME-01 | Cron loop in `src/commands/start.ts` discovers jobs from BOTH `.claude/claudeclaw/jobs/*.md` AND `agents/*/jobs/*.md`, fires fresh session per job with `agentName=<dir>` | §4 Runtime Job Discovery |
| DISCORD-01 | Job completion forwarding (`forwardToDiscord` / `forwardToTelegram` in `start.ts`) labels output with the job's label, not just the agent name | §7 Discord/Telegram Labelling |
| MIGRATE-01 | On daemon startup, Phase 16 single-job agents (those with a matching `.claude/claudeclaw/jobs/<agentName>.md` whose frontmatter has `agent: <name>`) auto-migrate to `agents/<name>/jobs/default.md`. Idempotent. Original file deleted only after successful copy + parse | §8 Backwards-Compat Migration |
| MIGRATE-02 | Standalone non-agent jobs (no `agent:` field in frontmatter) keep working unchanged in their flat dir | §4 Runtime Job Discovery |
</phase_requirements>

## Standard Stack

### Core (already in project — no new deps)
| Library / File | Version | Purpose | Why Standard |
|---|---|---|---|
| `bun` | (Bun runtime, see project) | Test runner, file I/O (`Bun.file`, `Bun.write`), single-file scripts | Project-wide standard, used by every test in `src/__tests__/` |
| `bun:test` | (built-in) | Unit / integration tests for new agent + parser code | Already used by `src/__tests__/agents.test.ts` and `sessions.test.ts` |
| `fs/promises` | Node built-in | `mkdir`, `readdir`, `writeFile`, `rename`, `unlink`, `stat` | Used throughout `src/agents.ts`, `src/sessions.ts` |
| `path` | Node built-in | `join` | Used throughout |
| `src/cron.ts` (`cronMatches`, `nextCronMatch`) | in-tree | Validate generated cron strings | Already used by `parseScheduleToCron` for raw cron passthrough |
| `src/memory.ts` (`ensureMemoryFile`, `loadMemory`, `getMemoryPath`) | in-tree | Memory is already agent-aware — Phase 17 only needs to NOT touch it during update-agent | Phase 16 finished |

### Supporting (existing files Phase 17 modifies)
| File | Purpose | Phase 17 Change |
|---|---|---|
| `src/agents.ts` | Agent scaffolding, NL→cron, validation | Add multi-job helpers (`addJob`, `updateJob`, `removeJob`, `listAgentJobs`, `migrateLegacyJob`), broaden `parseScheduleToCron`, new `updateAgent` selective-field helpers, refactor `createAgent` to write `jobs/default.md` instead of legacy flat path |
| `src/jobs.ts` | Frontmatter parser, `loadJobs()` | Extend `loadJobs()` to also scan `agents/*/jobs/*.md`; parse new `label`, `enabled`, `model` frontmatter fields |
| `src/commands/start.ts` | Daemon entry, cron tick loop | Call new migration shim once on startup; pass job label to forward functions |
| `skills/create-agent/SKILL.md` | Wizard | Restructure question flow: add Workflow field, jobs loop, optional model |
| `skills/update-agent/SKILL.md` | NEW | Update wizard with menu-driven selective updates |

### No new dependencies — by policy
Per `16-CONTEXT.md` Claude's Discretion: "keep dependencies minimal, prefer hand-rolled if feasible". Phase 17 inherits this constraint. The NL→cron parser stays hand-rolled.

**Installation:** None. Existing `package.json` is unchanged.

## User Constraints (no CONTEXT.md exists yet)

No `17-CONTEXT.md` was found. The roadmap entry in `.planning/ROADMAP.md` (lines 356-377) and `.planning/STATE.md` (lines 261-262) are the only locked sources. Constraints below are derived verbatim from the ROADMAP scope block and from the inherited Phase 16 conventions (no new deps, additive changes, TDD where test infra exists).

If `/gsd:discuss-phase 17` is run later, that CONTEXT.md will supersede this section and the planner should re-read it.

### Locked (from ROADMAP)
1. Agents own a `jobs/` subdirectory: `agents/<name>/jobs/<label>.md`
2. Job frontmatter: `cron`, `label`, `enabled`, optional `model` + trigger-prompt body
3. Delete agent → delete all its jobs
4. Wizard adds dedicated multi-line `Workflow` field, separate from cron schedule
5. Wizard supports N scheduled tasks per agent, each with label + cron + trigger prompt
6. Optional `model` field per job (default / opus / haiku)
7. Schedule field becomes cron-only — no operational detail mixed in
8. NL→cron parser handles `every day at 7pm`, `every weekday at 9am`, `twice daily`, `hourly`, `every Monday`, etc.
9. New `/claudeclaw:update-agent` command exists with menu-driven selective updates
10. **Invariant:** update-agent must NEVER touch `MEMORY.md`
11. Runtime cron loop scans `agents/*/jobs/*.md` AND existing flat dir
12. Each job fires a fresh session with `agentName=<name>` + that job's trigger prompt
13. Agent's base SOUL/CLAUDE.md loads as system context for every job
14. Discord/Telegram labelling includes the job label (not just agent name)
15. Phase 16 single-job agents auto-migrate to `agents/<name>/jobs/default.md` on first load
16. Standalone non-agent jobs keep working unchanged

### Inherited from Phase 16 (still in force)
- No new runtime dependencies (hand-rolled parser, `bun:test`)
- Strictly additive changes — existing non-agent code paths must stay untouched
- Session cache collision: agent sessions bypass module-level `current` cache (`src/sessions.ts:30-44`)
- TDD-RED → GREEN where test infra exists; integration-only code (runner.ts, start.ts) can skip TDD-RED
- All file paths resolved via `process.cwd()` at call time, not at module load (lazy cwd resolution pattern)
- Test isolation via `tst-` / `test-` prefixed agent names + cleanup, not chdir hacks

### Out of scope (Deferred)
- Suzy's Google Drive → Obsidian vault output path migration. This is a runtime config change on the Suzy agent itself, not a code change. Reg's `digest-scan` job docs SHOULD reference `$VAULT_PATH/POVIEW.AI/Clippings` once the Suzy-side migration lands. **Phase 17 only documents the new path; it does not modify Suzy.**
- Per-agent serial queue. The runner's `queue` variable (`src/runner.ts:71`) remains global. Agent jobs may serialize against the main session — acceptable for this phase per Phase 16 research §5.
- Agent-specific Discord channel routing (still metadata-only in CLAUDE.md, as in Phase 16)
- Web-dashboard agent listing UI
- Agent templates / marketplace
- Multi-agent conversations

## Architecture Patterns

### Recommended Project Structure (after Phase 17)

```
agents/
└── <name>/                  # one per agent
    ├── IDENTITY.md          # role + name (existing — Phase 16)
    ├── SOUL.md              # personality + Workflow field (NEW: Workflow appended)
    ├── CLAUDE.md            # discord channels, data sources (existing)
    ├── MEMORY.md            # agent state (existing — NEVER touched by update-agent)
    ├── session.json         # runtime session id (existing, gitignored)
    ├── .gitignore           # session.json, MEMORY.md (existing)
    └── jobs/                # NEW Phase 17
        ├── default.md       # auto-migrated from Phase 16 single job
        ├── digest-scan.md   # additional jobs scaffolded by wizard or update
        └── <label>.md       # one file per scheduled task

.claude/claudeclaw/jobs/     # legacy flat dir — STILL SUPPORTED
└── <non-agent-job>.md       # standalone jobs without agent: field keep working
```

### Pattern 1: Lazy CWD Resolution (mandatory — inherited from Phase 16)
**What:** Resolve `process.cwd()` inside small helper functions, never at module top level.
**When to use:** Any new function in `src/agents.ts` or `src/jobs.ts` that touches the filesystem.
**Example:**
```typescript
// Source: src/agents.ts:16-26 (existing pattern Phase 17 must follow)
function projectDir(): string { return process.cwd(); }
function agentsDir(): string { return join(projectDir(), "agents"); }
// NEW for Phase 17:
function agentJobsDir(name: string): string { return join(agentsDir(), name, "jobs"); }
```
**Why:** Tests use temp prefixes and rely on `process.cwd()` being live. Module-level constants captured at import time would freeze the path and break test isolation. `src/jobs.ts` currently has `const JOBS_DIR = join(process.cwd(), …)` (line 4) — this is acceptable because the daemon never chdirs, BUT new Phase 17 helpers should use lazy resolution to keep `agents.test.ts`-style isolation possible.

### Pattern 2: Strict Frontmatter Parsing (extend, don't rewrite)
**What:** Add new optional fields to job frontmatter parser by following the exact `notify:` / `agent:` pattern at `src/jobs.ts:46-58`.
**Example:**
```typescript
// Source: src/jobs.ts:55-58 (current agent: parsing — mirror this for label, enabled, model)
const labelLine = lines.find((l) => l.startsWith("label:"));
const labelRaw = labelLine ? parseFrontmatterValue(labelLine.replace("label:", "")) : "";
const label = labelRaw || name;  // fallback: use file basename as label

const enabledLine = lines.find((l) => l.startsWith("enabled:"));
const enabledRaw = enabledLine ? parseFrontmatterValue(enabledLine.replace("enabled:", "")).toLowerCase() : "";
const enabled = enabledRaw === "false" || enabledRaw === "no" ? false : true; // default true

const modelLine = lines.find((l) => l.startsWith("model:"));
const modelRaw = modelLine ? parseFrontmatterValue(modelLine.replace("model:", "")) : "";
const model = modelRaw || undefined; // undefined → use settings default
```

**Anti-pattern:** Do NOT introduce a YAML library to parse frontmatter "properly". The existing `parseFrontmatterValue` regex pattern handles every existing job and agent file. New fields just append more `lines.find(...)` calls.

### Pattern 3: Additive Job Discovery (don't replace `loadJobs()`)
**What:** Extend `loadJobs()` (`src/jobs.ts:62-78`) to scan a second source after the existing one. Standalone jobs keep working; agent jobs are concatenated.
**Example:**
```typescript
// Source: src/jobs.ts:62-78 (current implementation — extend after it)
export async function loadJobs(): Promise<Job[]> {
  const jobs: Job[] = [];
  // 1. Existing flat dir scan (UNCHANGED)
  let files: string[];
  try { files = await readdir(JOBS_DIR); } catch { return jobs; }
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const content = await Bun.file(join(JOBS_DIR, file)).text();
    const job = parseJobFile(file.replace(/\.md$/, ""), content);
    if (job) jobs.push(job);
  }

  // 2. NEW Phase 17: scan agents/*/jobs/*.md
  const agentsRoot = join(process.cwd(), "agents");
  let agentDirs: string[];
  try { agentDirs = await readdir(agentsRoot); } catch { return jobs; }
  for (const agentName of agentDirs) {
    const jobsDir = join(agentsRoot, agentName, "jobs");
    let jobFiles: string[];
    try { jobFiles = await readdir(jobsDir); } catch { continue; }
    for (const file of jobFiles) {
      if (!file.endsWith(".md")) continue;
      const content = await Bun.file(join(jobsDir, file)).text();
      // Synthesize a unique job name to avoid collisions with flat-dir jobs
      const label = file.replace(/\.md$/, "");
      const job = parseJobFile(`${agentName}/${label}`, content);
      if (job) {
        // Force agent association based on directory location
        job.agent = agentName;
        // Preserve label separately for Discord/Telegram forwarding
        (job as any).label = label;
        jobs.push(job);
      }
    }
  }
  return jobs;
}
```

**Note:** The synthesized name `agentName/label` keeps log lines and `state.json` job entries unique. The `label` field is needed by Discord/Telegram forwarding to print "Reg: digest-scan complete" instead of "Reg: reg/digest-scan complete".

### Pattern 4: Agent-Aware Migration Shim (run-once, idempotent)
**What:** On daemon startup, `start.ts` calls `migrateLegacyAgentJobs()` exactly once before `loadJobs()`. The shim lists `.claude/claudeclaw/jobs/*.md`, checks each frontmatter for `agent: <name>`, and if found AND `agents/<name>/jobs/default.md` does NOT already exist, copies the file there and deletes the original.
**Example:**
```typescript
// Source: NEW helper in src/agents.ts (or new src/migrations.ts)
export async function migrateLegacyAgentJobs(): Promise<{ migrated: string[]; skipped: string[] }> {
  const legacyDir = join(process.cwd(), ".claude", "claudeclaw", "jobs");
  const result = { migrated: [] as string[], skipped: [] as string[] };
  let files: string[];
  try { files = await readdir(legacyDir); } catch { return result; }
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const legacyPath = join(legacyDir, file);
    const content = await Bun.file(legacyPath).text();
    // Cheap check: does frontmatter contain `agent: <name>`?
    const m = content.match(/^---[\s\S]*?\nagent:\s*(\S+)\s*\n[\s\S]*?---/);
    if (!m) { result.skipped.push(file); continue; }
    const agentName = m[1].replace(/["']/g, "");
    const targetDir = join(process.cwd(), "agents", agentName, "jobs");
    const targetPath = join(targetDir, "default.md");
    if (existsSync(targetPath)) { result.skipped.push(file); continue; } // already migrated
    if (!existsSync(join(process.cwd(), "agents", agentName))) { result.skipped.push(file); continue; } // agent dir gone
    await mkdir(targetDir, { recursive: true });
    // Rewrite frontmatter to add label: default (and strip the now-implicit agent: field)
    const migrated = content
      .replace(/^agent:\s*\S+\s*\n/m, "")
      .replace(/^---\s*\n/, "---\nlabel: default\n");
    await writeFile(targetPath, migrated, "utf8");
    await unlink(legacyPath);
    result.migrated.push(`${agentName}/default`);
  }
  return result;
}
```
**Where it's called:** `src/commands/start.ts` line ~315, immediately before `const jobs = await loadJobs();`. Log the result if non-empty: `console.log(\`[migration] moved \${migrated.length} agent jobs to agents/<name>/jobs/default.md\`)`.

**Idempotent:** Running twice is safe — the second run finds `default.md` already exists and skips.

### Pattern 5: Selective-Field Update (update-agent invariant)
**What:** `updateAgent(name, patch)` accepts a typed patch with only the fields the user changed, rewrites only the file(s) those fields touch, and explicitly excludes MEMORY.md from any read or write path.
**Example:**
```typescript
// Source: NEW helper in src/agents.ts
export interface AgentUpdatePatch {
  workflow?: string;        // → SOUL.md (new section)
  personality?: string;     // → SOUL.md (replaces ## Personality block)
  discordChannels?: string[]; // → CLAUDE.md
  dataSources?: string;     // → CLAUDE.md
  // jobs are managed via separate add/edit/remove helpers
}

export async function updateAgent(name: string, patch: AgentUpdatePatch): Promise<void> {
  const ctx = await loadAgent(name);
  // INVARIANT: never read or write ctx.memoryPath
  if (patch.workflow !== undefined || patch.personality !== undefined) {
    const soul = await Bun.file(ctx.soulPath).text();
    const next = applySoulPatch(soul, patch);  // pure string transform, see below
    await writeFile(ctx.soulPath, next, "utf8");
  }
  if (patch.discordChannels !== undefined || patch.dataSources !== undefined) {
    const claudeMd = await Bun.file(ctx.claudeMdPath).text();
    const next = applyClaudeMdPatch(claudeMd, patch);
    await writeFile(ctx.claudeMdPath, next, "utf8");
  }
}

export async function addJob(agentName: string, label: string, cron: string, trigger: string, model?: string): Promise<void> { /* ... */ }
export async function updateJob(agentName: string, label: string, patch: { cron?: string; trigger?: string; enabled?: boolean; model?: string }): Promise<void> { /* ... */ }
export async function removeJob(agentName: string, label: string): Promise<void> { /* unlink agents/<name>/jobs/<label>.md */ }
export async function deleteAgent(name: string): Promise<void> {
  // Recursive delete of agents/<name>/. Includes jobs/. Also deletes MEMORY.md (delete-agent is the ONE exception to the never-touch-memory rule, since the whole agent is going away).
}
```

**Section markers in SOUL.md:** Phase 16's `renderSoul` (`src/agents.ts:176-195`) writes `## Personality` and `## Core Truths`. Phase 17 adds `## Workflow`. To make patching reliable, mark each section so `applySoulPatch` can find and replace it surgically. Recommended marker:
```markdown
## Workflow
<!-- claudeclaw:workflow:start -->
[user content]
<!-- claudeclaw:workflow:end -->
```
This mirrors the `<!-- claudeclaw:managed:start -->` block in `CLAUDE.md` (`/Users/terrenceyodaiken/claude-workspace/moazbuilds-claudeclaw/CLAUDE.md:1`) and the existing skill-managed-block convention.

### Anti-Patterns to Avoid
- **Rewriting `loadJobs()` from scratch** — extend it. Phase 16 added the `agent` field by adding 3 lines; Phase 17 should follow suit.
- **Touching `MEMORY.md` from update-agent** — even reading it, even via `loadAgent` returning a path. The update-agent code path must contain zero references to `memoryPath`. Add a unit test that asserts `agents/<name>/MEMORY.md` mtime is unchanged after every update-agent operation.
- **Caching agent jobs in a module-level variable** — `loadJobs()` is called every 30s by the hot-reload loop in `start.ts:629`. Each call must re-scan disk so wizard-added jobs appear without daemon restart.
- **Replacing `parseScheduleToCron` with a library** — explicitly forbidden by inherited Phase 16 constraint. Add regex branches.
- **Using a YAML parser for frontmatter** — `parseFrontmatterValue` is sufficient and matches every other file in the project.
- **Generating job filenames from arbitrary user labels without sanitization** — labels become filenames. Apply the same kebab-case validation as agent names: `^[a-z]([a-z0-9-]*[a-z0-9])?$`. Reject `../`, spaces, capitals, etc.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| Frontmatter parsing | A new YAML library import | Existing `parseFrontmatterValue` + `lines.find(l => l.startsWith(...))` in `src/jobs.ts:15-17` | Project-wide convention; every file already uses this; introducing a YAML lib violates the "no new deps" constraint |
| Cron validation | A new cron library | Existing `cronMatches` from `src/cron.ts` | Already used by `parseScheduleToCron` for raw passthrough; trusted across the codebase |
| Memory I/O | Re-implementing memory file management | Existing `ensureMemoryFile`, `loadMemory`, `getMemoryPath` from `src/memory.ts` (already agent-aware) | Already done in Phase 16; only need to NOT call these from update-agent paths |
| Session management | Re-implementing per-agent session logic | Existing `getSession(agentName)`, `createSession(sessionId, agentName)` from `src/sessions.ts` | Already done in Phase 16 plan 02; multi-job agents reuse the same agent session per agent — all jobs for one agent share `agents/<name>/session.json` |
| Recursive directory delete | Hand-rolled rm-rf | `fs/promises` `rm(path, { recursive: true, force: true })` | Standard Node API, available in Bun; needed by `deleteAgent` |
| Discord forwarding | A separate per-job notifier | Existing `forwardToDiscord(label, result)` and `forwardToTelegram(label, result)` in `start.ts:514-536` | These already accept a `label` parameter — Phase 17 just needs to pass `job.label || job.name` instead of `job.name` |

**Key insight:** Phase 17 is a refactor + extension exercise on top of complete Phase 16 infrastructure. The "don't hand-roll" list is mostly "don't re-do Phase 16's work" — every primitive Phase 17 needs already exists.

## NL→Cron Parser Broadening

The current `parseScheduleToCron` (`src/agents.ts:98-156`) handles 9 presets. Phase 17 needs to broaden it to cover the ROADMAP-listed inputs. Concrete additions (each is a new regex branch added to the existing function):

| Input | Cron | New regex branch | Implementation |
|---|---|---|---|
| `every day at 7pm` (already works via `daily at <time>` branch — VERIFY by adding a test) | `0 19 * * *` | existing `^(?:daily|every day)\s+at\s+(.+)$` (line 138) | Currently this branch DOES match; Phase 16 fails it because `parseHour("7pm")` returns 19. Test may have been missing — add explicit test case. |
| `twice daily` | `0 9,21 * * *` | new `^twice\s+daily$` | Hard-code 9am/9pm or document the choice; Reg/Suzy use this idiom |
| `every N hours` | `0 */N * * *` | new `^every\s+(\d+)\s+hours?$` | Validate `1 ≤ N ≤ 23` |
| `noon` / `daily at noon` | `0 12 * * *` | extend `parseHour` to recognize `noon` → 12, `midnight` → 0 | Single helper change |
| `morning` (default 9am) / `evening` (default 6pm) / `night` (default 10pm) | `0 9 * * *` etc | extend `parseHour` with named-time aliases | Document the chosen defaults in inline comments |
| `every monday at 9am` (already works via `every <dayname> at <time>` — VERIFY) | `0 9 * * 1` | existing line 146 regex | Already works, add test |
| `every weekday at 9am` (already works) | `0 9 * * 1-5` | existing line 129 regex | Already works, add test |
| `every weekend` | `0 0 * * 0,6` | new `^every\s+weekend(?:s)?$` | Maps Sat+Sun |
| `every 15 minutes` (already works) | `*/15 * * * *` | existing line 121 regex | Already works |
| Raw cron passthrough | (as-is) | existing `RAW_CRON_RE` line 71 | Already works |

**Hand-rolled insight:** The existing parser is a single function with sequential branches. Each new pattern is one regex + one return. Total LOC change: ~30 lines. No new helpers needed except expanding `parseHour` to recognize `noon`, `midnight`, `morning`, etc.

**Pitfall flagged by ROADMAP:** "NL→cron parser fix (`every day at 7pm`)" — this implies the user hit a bug. Reading the current code, `parseHour("7pm")` returns 19 correctly (line 91-92 adds 12). So either the bug is in a related pattern (e.g. user said "every day at 7 pm" with a space, which the regex `(am|pm)?` does handle) or the user said "at 7" without am/pm (returns hour 7 not 19). **Action: add tests for every variant in the user's likely vocabulary including edge cases like `7 pm`, `7:00pm`, `7:30 PM`, `at 7 in the evening`.**

## Wizard Restructure (`skills/create-agent/SKILL.md`)

Current wizard (Phase 16, `skills/create-agent/SKILL.md` lines 18-66) asks 6 sequential questions: name, role, personality, schedule, discord channels, data sources. Phase 17 restructures:

### New question flow
1. **Name** (unchanged; validate via `validateAgentName`)
2. **Role** (unchanged; one line for IDENTITY.md)
3. **Personality** (unchanged; free text for SOUL.md `## Personality` section)
4. **Workflow** (NEW; multi-line) — "How does this agent operate? What are their guidelines, style, do's and don'ts? (multi-line ok)" Becomes SOUL.md `## Workflow` block (with managed markers).
5. **Discord channels** (unchanged; comma-separated)
6. **Data sources** (unchanged; free text)
7. **Scheduled tasks** (NEW LOOP):
   - "Want to add a scheduled task? (y/n)" — if no, scaffold and exit.
   - If yes:
     - "Label for this task? (kebab-case, e.g. `digest-scan`, `morning-brief`)"
     - "When? (NL like `every weekday at 9am`, raw cron, or `none`)" → validate via `parseScheduleToCron`
     - "Trigger prompt? (what should the agent do when this fires? multi-line ok)"
     - "Model? (default / opus / haiku — press enter for default)"
   - After each task: "Add another task? (y/n)" → loop or exit.
8. **Scaffold** — call `createAgent({...})` then for each captured task call `addJob(name, label, cron, trigger, model)`.

### Invocation pattern (mirrors current SKILL.md line 74-76)
```bash
bun -e "import {createAgent, addJob} from './src/agents'; const ctx = await createAgent({name:'NAME',role:'ROLE',personality:'PERSONALITY',workflow:'WORKFLOW',discordChannels:[...],dataSources:'SOURCES'}); for (const j of JOBS) { await addJob(ctx.name, j.label, j.cron, j.trigger, j.model); } console.log(JSON.stringify(ctx, null, 2));"
```

For multi-line content, the existing skill suggests writing to a temp JSON file — same recommendation applies here, especially for Workflow and trigger prompts which are multi-line.

### Removed
- The old single `schedule` question is gone. Schedule now lives only inside the per-job loop.
- The old default-prompt pattern (`opts.defaultPrompt ?? "Run your scheduled task per IDENTITY.md."` at `src/agents.ts:272`) is removed — every job MUST have an explicit trigger prompt collected by the wizard.

## Update-Agent Command (`skills/update-agent/SKILL.md`)

NEW skill file. Mirror the conversational vibe of `create-agent`. Menu-driven rather than sequential.

### Skill structure
```markdown
---
name: update-agent
description: Use when the user wants to modify an existing agent — change personality, workflow, add or edit a scheduled job, update Discord channels, swap model, or delete the agent. Trigger phrases include "update an agent", "edit agent", "modify agent", "change agent", "/claudeclaw:update-agent", "add a job to <agent>", "delete agent <name>".
---
```

### Flow
1. **List agents** — `bun -e "import {listAgents} from './src/agents'; console.log((await listAgents()).join('\n'));"`
2. **Pick agent** — user selects by name (or pass as `$ARGUMENTS`)
3. **Show current state** — print summary (workflow snippet, jobs list with labels + cron, discord channels)
4. **Menu** (one selection at a time):
   - `1. Workflow` — re-prompt full workflow text, replace SOUL.md `## Workflow` block
   - `2. Personality` — re-prompt personality, replace SOUL.md `## Personality` block
   - `3. Add job` — collect label, cron, trigger, model → `addJob(...)`
   - `4. Edit job` — show jobs list, pick one, prompt for new cron/trigger/model/enabled → `updateJob(...)`
   - `5. Remove job` — show jobs list, pick one, confirm → `removeJob(...)`
   - `6. Discord channels` — re-prompt comma-separated list → patch CLAUDE.md
   - `7. Data sources` — re-prompt → patch CLAUDE.md
   - `8. Delete agent` — confirm with name re-typing → `deleteAgent(name)` (this IS allowed to remove MEMORY.md because the agent is going away)
   - `9. Done` — exit
5. **Loop** until user picks Done.

### Invariants (must be enforced in code, not just docs)
- **NEVER read `agents/<name>/MEMORY.md`** during any operation except `deleteAgent`.
- **NEVER write `agents/<name>/MEMORY.md`** during any operation except `deleteAgent`.
- **NEVER touch `agents/<name>/session.json`** during any operation except `deleteAgent`.
- **Delete-agent confirmation:** require the user to re-type the agent name as a guard against typos.
- **All edits are file rewrites, not in-place edits.** Read entire file → string transform → write entire file. No `Edit` tool, no offset-based writes.

### Test for the MEMORY.md invariant
```typescript
// In src/__tests__/agents.test.ts (Phase 17 plan)
test("updateAgent never modifies MEMORY.md", async () => {
  const name = `tst-agent-${Math.random().toString(36).slice(2, 8)}`;
  await createAgent({ name, role: "x", personality: "y", workflow: "z" });
  const memPath = join(process.cwd(), "agents", name, "MEMORY.md");
  const before = (await stat(memPath)).mtimeMs;
  // Sleep 5ms to ensure mtime would change if file was written
  await Bun.sleep(5);
  await updateAgent(name, { workflow: "different workflow text" });
  await updateAgent(name, { personality: "different personality" });
  await addJob(name, "test-job", "0 9 * * *", "do the thing");
  await updateJob(name, "test-job", { cron: "0 10 * * *" });
  await removeJob(name, "test-job");
  const after = (await stat(memPath)).mtimeMs;
  expect(after).toBe(before);
});
```

## Runtime Job Discovery and Execution

### Files touched
| File | Change |
|---|---|
| `src/jobs.ts` | Extend `loadJobs()` per Pattern 3; add `label`, `enabled`, `model` parsing |
| `src/commands/start.ts` | Call `migrateLegacyAgentJobs()` once on startup before `loadJobs()`; pass `job.label \|\| job.name` to forwarding helpers |
| `src/runner.ts` | NO CHANGES — `run(name, prompt, agentName)` already accepts agentName from Phase 16 plan 02 |

### Cron tick (existing — `src/commands/start.ts:710-734`)
The current cron loop:
```typescript
for (const job of currentJobs) {
  if (cronMatches(job.schedule, now, currentSettings.timezoneOffsetMinutes)) {
    resolvePrompt(job.prompt)
      .then((prompt) => run(job.name, prompt, job.agent))  // ← agent threading already wired
      .then((r) => {
        if (job.notify === false) return;
        if (job.notify === "error" && r.exitCode === 0) return;
        forwardToTelegram(job.name, r);  // ← Phase 17: replace with job.label || job.name
        forwardToDiscord(job.name, r);
      })
      .finally(/* ... */);
  }
}
```

Phase 17 changes (minimal):
1. Pre-startup: `await migrateLegacyAgentJobs();` (line ~315, before `loadJobs()`)
2. Skip disabled jobs: add `if (job.enabled === false) continue;` at the top of the for-loop (line ~712)
3. Use label for forwarding: `forwardToTelegram(job.label || job.name, r)` and `forwardToDiscord(...)` (lines ~719-720)
4. Per-job model override (LATER — defer if it complicates the runner): if `job.model` is set, the runner needs an override path. **Recommend deferring `model` override to a follow-up phase**; capture it in frontmatter for forward-compat but don't honor it in the runner yet. Document this gap clearly.

### Hot-reload (existing — `src/commands/start.ts:629-682`)
Hot-reload calls `await loadJobs()` every 30s. With the multi-source `loadJobs()` from Pattern 3, wizard-added jobs (whether via `create-agent` or `update-agent`) appear within 30s without daemon restart. **No additional hot-reload work needed.**

### Job-name uniqueness
The job-comparison hash on line 666-667 uses `${j.name}:${j.schedule}:${j.prompt}`. With agent jobs synthesized as `agentName/label`, names remain unique across the legacy flat dir and the new agent dirs. No collisions.

## Discord/Telegram Labelling

`forwardToDiscord` and `forwardToTelegram` (`src/commands/start.ts:514-536`) already accept a `label` parameter:
```typescript
function forwardToDiscord(label: string, result: { exitCode: number; stdout: string; stderr: string }) {
  const text = result.exitCode === 0
    ? `${label ? `[${label}]\n` : ""}${result.stdout || "(empty)"}`
    : `${label ? `[${label}] ` : ""}error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;
  // ...
}
```

Phase 17 change: when calling these from the cron loop, pass a composed label `"<agent>: <jobLabel>"` so multi-job agents disambiguate output. Example: `Reg: digest-scan complete` instead of `Reg: complete`.

```typescript
// In the cron loop, src/commands/start.ts line ~719
const displayLabel = job.agent && (job as any).label
  ? `${job.agent}: ${(job as any).label}`
  : job.name;
forwardToTelegram(displayLabel, r);
forwardToDiscord(displayLabel, r);
```

## Backwards-Compat Migration

### Migration trigger
Daemon start. Run exactly once per startup before `loadJobs()`. The shim is idempotent — if `agents/<name>/jobs/default.md` already exists, the legacy file is skipped (and should have been deleted by a prior migration run).

### Migration source detection
A legacy job is "owned by an agent" if its frontmatter contains `agent: <name>` AND `agents/<name>/` exists as a directory. Both conditions must hold to avoid migrating jobs that reference deleted agents.

### Migration transformation
1. Read legacy file content
2. Strip `agent:` line from frontmatter (no longer needed — directory location implies agent)
3. Inject `label: default` line as the new first frontmatter field
4. Write to `agents/<name>/jobs/default.md`
5. Verify the new file parses cleanly via `parseJobFile`
6. Only if parse succeeds: `unlink` the legacy file
7. Log migration

### Failure modes
| Failure | Handling |
|---|---|
| Target dir doesn't exist (agent dir missing) | Skip — log warning, leave legacy file in place |
| Target file already exists | Skip — log info, leave legacy file in place (next migration run will hit same skip) |
| New file fails to parse | Restore (don't unlink legacy), log error, return non-zero from migration helper but DON'T crash daemon |
| Two legacy jobs both reference the same agent | Migrate the first one to `default.md`, leave the second in place with a warning. User must manually rename or use update-agent to add it as a second job. |

### Rollback (no automatic — manual only)
If a user needs to roll back to Phase 16, they can manually move `agents/<name>/jobs/default.md` back to `.claude/claudeclaw/jobs/<name>.md` and re-add the `agent:` field. Document in the migration log message.

## Common Pitfalls

### Pitfall 1: Touching MEMORY.md from update-agent
**What goes wrong:** A user updates an agent's workflow, and Phase 17 inadvertently rewrites MEMORY.md (e.g. via a "rerender all files" pattern), erasing months of accumulated agent context.
**Why it happens:** Easy to write `for (const file of [identityPath, soulPath, claudeMdPath, memoryPath]) { ... }` and not notice the last entry.
**How to avoid:**
- Never iterate over `ctx`'s file paths blindly — explicitly name the files being touched
- Add a unit test that snapshots MEMORY.md mtime before and after every update-agent op (see test snippet in §6)
- Code review checklist: any PR touching `updateAgent`, `addJob`, `updateJob`, `removeJob` must grep for `MEMORY` and prove no reference exists
**Warning signs:** Test fails comparing mtime; user reports lost agent state after update.

### Pitfall 2: `loadJobs()` returns non-unique job names
**What goes wrong:** A standalone `.claude/claudeclaw/jobs/digest-scan.md` and an agent job at `agents/reg/jobs/digest-scan.md` both produce a `Job` with `name: "digest-scan"`. The hot-reload diff hash collides; one of them is silently dropped from the cron loop.
**Why it happens:** `parseJobFile` uses the file basename as the name.
**How to avoid:** Synthesize agent job names as `${agentName}/${label}` (slash-separated) to guarantee uniqueness. Verify by adding a test that creates a flat-dir job and an agent job with the same label.
**Warning signs:** Job count in `start.ts` log doesn't match the file count on disk; one of two same-named jobs never fires.

### Pitfall 3: NL→cron parser regression on existing presets
**What goes wrong:** Adding new branches to `parseScheduleToCron` accidentally shadows an existing preset (e.g. a new `^every\s+(\w+)$` branch matches before the more specific `^every\s+weekday$` branch).
**Why it happens:** Branch order matters; the function returns on first match.
**How to avoid:** Run the existing 26 test cases in `agents.test.ts` after each new branch addition. Add new branches AFTER more-specific existing branches. Order: raw cron → fixed strings (`hourly`, `daily`) → specific patterns (`every weekday`, `every N minutes`) → general patterns (`every <dayname>`).
**Warning signs:** `bun test src/__tests__/agents.test.ts` fails on previously-passing cases.

### Pitfall 4: Job-label collision creates invalid filename
**What goes wrong:** User says "label this job: ../../etc/passwd" or just uses spaces or capitals. The wizard tries to write `agents/<name>/jobs/../../etc/passwd.md`.
**Why it happens:** Labels become filenames; no validation.
**How to avoid:** Apply the same kebab-case validation as `validateAgentName` to labels. Reject invalid labels with the same error message style. New helper: `validateJobLabel(label)`.
**Warning signs:** Path traversal in test runs; files appearing outside `agents/<name>/jobs/`.

### Pitfall 5: Migration runs inside a unit test and corrupts real data
**What goes wrong:** A test imports `migrateLegacyAgentJobs` and runs it without setting cwd to a temp dir, scanning the real `.claude/claudeclaw/jobs/`.
**Why it happens:** Lazy cwd resolution means tests must use prefixed names AND clean up after themselves; migration is unique because it deletes files.
**How to avoid:** Migration tests must use a fresh tmp directory via `mkdtemp` AND `process.chdir` for the duration of the test. OR (preferred): make `migrateLegacyAgentJobs` accept an optional `rootDir` parameter for testing, with `process.cwd()` as default.
**Warning signs:** Real `.claude/claudeclaw/jobs/` files disappear after running tests.

### Pitfall 6: Wizard scaffolds an agent without any jobs and the user expects the daemon to "just run it"
**What goes wrong:** User runs the wizard, says "no" to the scheduled-tasks loop, then waits for the agent to do something. Nothing happens because there are no cron jobs to fire.
**Why it happens:** Phase 16 created agents with optional schedule; Phase 17 makes this a loop that user can skip entirely.
**How to avoid:** When the user finishes the wizard with zero jobs, print: `✓ Agent <name> created with no scheduled tasks. Invoke ad-hoc with: claudeclaw send --agent <name> "<message>"`. Make the no-jobs case explicit, not a silent state.
**Warning signs:** User asks "why isn't my agent running?" after wizard completes successfully.

### Pitfall 7: `model` field in job frontmatter promised but not honored
**What goes wrong:** Wizard collects `model: opus`, writes it to frontmatter, but `runner.ts` ignores it. User expects per-job model selection and is silently disappointed.
**Why it happens:** Plumbing the per-job model override through `runner.ts` requires touching the model selection logic at `src/runner.ts:466-490`, which is non-trivial.
**How to avoid:** Either (a) wire it end-to-end this phase (recommended scope) OR (b) document explicitly that `model` is captured for forward-compat but not honored yet, and don't ask the wizard question if it's not honored. **Pick one — do NOT ship the half-state.**
**Warning signs:** Job frontmatter has `model: opus` but logs show the daemon using the default model.

## Code Examples

### Adding a new wizard skill (mirror existing)
```typescript
// Source: skills/create-agent/SKILL.md (existing Phase 16) — Phase 17 mirrors structure
// New file: skills/update-agent/SKILL.md
// Frontmatter pattern is identical to create-agent; description must include trigger phrases
```

### Reading a job file with new fields (extend existing parser)
```typescript
// Source: src/jobs.ts:19-60 (Phase 16, extend in Phase 17)
function parseJobFile(name: string, content: string): Job | null {
  // ... existing schedule, recurring, notify, agent parsing ...

  // NEW Phase 17:
  const labelLine = lines.find((l) => l.startsWith("label:"));
  const label = labelLine ? parseFrontmatterValue(labelLine.replace("label:", "")) : name;

  const enabledLine = lines.find((l) => l.startsWith("enabled:"));
  const enabledRaw = enabledLine ? parseFrontmatterValue(enabledLine.replace("enabled:", "")).toLowerCase() : "";
  const enabled = !(enabledRaw === "false" || enabledRaw === "no" || enabledRaw === "0");

  const modelLine = lines.find((l) => l.startsWith("model:"));
  const model = modelLine ? parseFrontmatterValue(modelLine.replace("model:", "")) : undefined;

  return { name, schedule, prompt, recurring, notify, agent, label, enabled, model };
}

// Job interface gains:
export interface Job {
  name: string;
  schedule: string;
  prompt: string;
  recurring: boolean;
  notify: true | false | "error";
  agent?: string;
  label?: string;     // NEW
  enabled?: boolean;  // NEW (default true)
  model?: string;     // NEW
}
```

### Cron loop change (minimal)
```typescript
// Source: src/commands/start.ts:710-734 (Phase 16, modify in Phase 17)
setInterval(() => {
  const now = new Date();
  for (const job of currentJobs) {
    if (job.enabled === false) continue;  // NEW
    if (cronMatches(job.schedule, now, currentSettings.timezoneOffsetMinutes)) {
      const displayLabel = job.agent && job.label ? `${job.agent}: ${job.label}` : job.name;  // NEW
      resolvePrompt(job.prompt)
        .then((prompt) => run(job.name, prompt, job.agent))
        .then((r) => {
          if (job.notify === false) return;
          if (job.notify === "error" && r.exitCode === 0) return;
          forwardToTelegram(displayLabel, r);  // CHANGED
          forwardToDiscord(displayLabel, r);   // CHANGED
        })
        .finally(/* unchanged */);
    }
  }
  updateState();
}, 60_000);
```

### Migration call site
```typescript
// Source: src/commands/start.ts:312-315 (Phase 16, insert before loadJobs)
await initConfig();
const settings = await loadSettings();
await ensureProjectClaudeMd();

// NEW Phase 17:
const migration = await migrateLegacyAgentJobs();
if (migration.migrated.length > 0) {
  console.log(`[migration] moved ${migration.migrated.length} legacy agent job(s) into agents/<name>/jobs/default.md`);
  for (const m of migration.migrated) console.log(`  - ${m}`);
}

const jobs = await loadJobs();
```

## State of the Art

| Old Approach (Phase 16) | New Approach (Phase 17) | When Changed | Impact |
|---|---|---|---|
| One job per agent in `.claude/claudeclaw/jobs/<name>.md` | N jobs per agent in `agents/<name>/jobs/<label>.md` | Phase 17 | Agents become first-class multi-tasking; legacy paths auto-migrate |
| Schedule field in wizard mixes operational instructions | Workflow + Schedule are separate fields; Workflow lives in SOUL.md | Phase 17 | Cleaner separation, less wizard confusion |
| 9 NL→cron presets | ~14 NL→cron presets including `every day at <time>`, `twice daily`, `every N hours`, named-time aliases | Phase 17 | More forgiving to natural language |
| Create-only lifecycle (`create-agent`) | Create + update + delete (`create-agent`, `update-agent`) | Phase 17 | Agents become editable, not throwaway |
| Discord/Telegram label = agent name | Label = `<agent>: <jobLabel>` | Phase 17 | Multi-job disambiguation |

**Deprecated/outdated:**
- `defaultPrompt` parameter on `createAgent` — every job now has an explicit trigger prompt collected by wizard. Remove from `AgentCreateOpts` interface.
- Single-file legacy jobs at `.claude/claudeclaw/jobs/<agentName>.md` for agent-owned jobs — migrated automatically. Standalone non-agent jobs at this path remain valid.

## Open Questions

1. **Does the runner honor per-job `model` override this phase?**
   - What we know: Wizard collects `model`, frontmatter parses it, `runner.ts` model selection lives at lines 466-490 inside the agentic-routing block.
   - What's unclear: Does plumbing per-job model through justify the runner change in this phase, or defer?
   - Recommendation: **Defer the runner change** — capture `model` in frontmatter for forward-compat but mark as not-yet-honored in the wizard help text. Add a separate Phase 18 task for it. Avoids touching `runner.ts` model routing in Phase 17.

2. **Should `twice daily` map to a fixed cron or be user-configurable?**
   - What we know: ROADMAP lists `twice daily` as a required preset.
   - What's unclear: Default times (9am/9pm? noon/midnight? 8am/8pm?)
   - Recommendation: Hard-code `0 9,21 * * *` (9am and 9pm), document in wizard examples and inline parser comment. Users who want different times can use raw cron.

3. **What happens if a user runs `update-agent` while a cron-fired job is in flight?**
   - What we know: The runner has a global `queue` that serializes invocations.
   - What's unclear: If update-agent rewrites SOUL.md mid-execution, does the in-flight invocation see stale or new content?
   - Recommendation: Document as known race; the in-flight invocation already loaded its system prompt at start time, so it sees the OLD content. Next invocation sees new. This is benign and matches how config hot-reload already works. No code change needed.

4. **Should `delete-agent` require a daemon restart to fully drop the agent's session?**
   - What we know: `deleteAgent` rms the directory, including `session.json`. The daemon's hot-reload loop refreshes `currentJobs` every 30s but does not refresh sessions.
   - What's unclear: Is there any cached agent state in the daemon that survives `deleteAgent`?
   - Recommendation: Audit `src/sessions.ts` — agent sessions bypass the module-level cache, so deleting the file is sufficient. No daemon restart needed. Verify with a test.

5. **Where exactly is the Suzy → Reg cross-agent context documented?**
   - What we know: ROADMAP says Suzy's daily digest output path is migrating from `My Drive/Clippings` (gws CLI) to `$VAULT_PATH/POVIEW.AI/Clippings` (Obsidian vault). Reg's `digest-scan` job consumes this.
   - What's unclear: Is this Phase 17's responsibility to update Reg's job docs, or should it be a separate runtime config task?
   - Recommendation: **Out of scope for Phase 17 code.** Document the path change in the Phase 17 SUMMARY.md so Reg's `digest-scan` job (when created via the wizard) uses the vault path in its trigger prompt. The Suzy-side change is a runtime config tweak handled separately.

## Sources

### Primary (HIGH confidence)
- `src/agents.ts` (full file, 317 lines) — current Phase 16 module, Phase 17 baseline
- `src/sessions.ts` (full file, 132 lines) — agent session handling Phase 17 inherits
- `src/jobs.ts` (full file, 96 lines) — frontmatter parser Phase 17 extends
- `src/commands/start.ts` (full file, 736 lines) — daemon entry, cron loop, hot-reload
- `src/commands/send.ts` (full file, 124 lines) — `--agent` flag pattern Phase 17 mirrors for `update-agent` invocation
- `src/runner.ts` lines 1-120 + 420-580 — runner agentName threading + loadAgentPrompts helper
- `skills/create-agent/SKILL.md` (Phase 16, 110 lines) — wizard pattern Phase 17 restructures
- `skills/create-skill/SKILL.md` — reference for skill markdown structure
- `.planning/phases/16-create-agent-command-…/16-RESEARCH.md` — Phase 16 research findings still applicable
- `.planning/phases/16-…/16-CONTEXT.md` — locked decisions Phase 17 inherits
- `.planning/phases/16-…/16-01-SUMMARY.md`, `16-02-SUMMARY.md`, `16-03-PLAN.md` — Phase 16 implementation history
- `.planning/ROADMAP.md` lines 356-377 — Phase 17 scope block (canonical)
- `.planning/STATE.md` lines 261-262 — Phase 17 entry in roadmap evolution log

### Secondary
None. No external sources consulted — Phase 17 is a pure existing-codebase extension.

### Tertiary
None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new deps, all existing files read end-to-end
- Architecture: HIGH — every change is a localized extension of an existing pattern that already works in Phase 16
- Pitfalls: HIGH — pitfalls derived from reading current code and Phase 16 deviations log
- NL→cron parser broadening: MEDIUM-HIGH — current code clearly shows the branch structure, but the user-reported "every day at 7pm" bug needs reproduction to confirm root cause; recommended action is "add tests for every plausible variant"

**Research date:** 2026-04-06
**Valid until:** 2026-05-06 (30 days; codebase is stable, Phase 16 just shipped, Phase 17 is purely additive)
