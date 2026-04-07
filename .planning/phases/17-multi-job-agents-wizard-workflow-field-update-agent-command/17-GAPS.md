---
phase: 17
status: blocking
created: 2026-04-07
source: live UAT on Hetzner production server (Reg agent creation attempt)
---

# Phase 17 — UAT Gaps (BLOCKING)

Discovered during live testing of `/claudeclaw:create-agent` on the Hetzner server (cwd `/home/claw/project`, source at `/opt/claudeclaw`). All three issues block Phase 17 verification — the wizard cannot successfully scaffold an agent end-to-end as deployed.

## GAP-17-01 — Skill `bun -e` snippets use repo-relative imports (FIXED in this commit)

**Severity:** Blocking
**Status:** Fixed pending deploy

### Symptom
Wizard collects all answers correctly, then on the scaffold step prints:
> "I'm hitting the same permission issue as before — the `.claude/claudeclaw/agents/` directory is protected. I can't create the agent files without explicit permission."

Claude then offers to fall back to direct `Write` (which is the legacy code path the new skill is supposed to bypass).

### Root cause
Every `bun -e` snippet in `skills/create-agent/SKILL.md` and `skills/update-agent/SKILL.md` used a repo-relative import:
```js
import { createAgent, addJob } from "./src/agents";
```
On the server, the systemd service runs from `cwd=/home/claw/project` while the source lives at `/opt/claudeclaw/src/`. The import fails with `Cannot find module './src/agents' from '/home/claw/project/[eval]'`. Claude treats the failure as ambiguous and falls back to direct `Write`/`Edit` on agent files, which Claude Code's built-in protection then blocks. The "permanently sensitive" path Claude reports (`.claude/claudeclaw/agents/`) is hallucinated from the legacy Phase 16 layout still present in earlier conversation context.

### Fix (this commit)
All 14 `bun -e` snippets converted from static `import { X } from "./src/agents"` to dynamic:
```js
const { X } = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`);
```
- Local dev: `process.env.CLAUDECLAW_ROOT` is unset → falls back to `.` → resolves against repo cwd (unchanged behaviour).
- Server: `CLAUDECLAW_ROOT=/opt/claudeclaw` set in `/usr/local/bin/claudeclaw-start` → resolves to absolute path.

Smoke-tested both paths against `validateAgentName("reg")` → `{valid:true}`.

### Deploy steps
1. Push to `povai/main`
2. Fast-forward `/opt/claudeclaw` (`git pull povai main`)
3. Add `export CLAUDECLAW_ROOT=/opt/claudeclaw` to the launcher block in `/usr/local/bin/claudeclaw-start` (above the `cd /home/claw/project` line so child bun processes inherit it)
4. Restart `claudeclaw.service`
5. Re-run create-agent wizard end-to-end

## GAP-17-02 — Workflow vs per-job Trigger Prompt redundancy

**Severity:** Blocking (UX, but blocks confident sign-off)
**Status:** Open

### Symptom
For single-task agents, the wizard asks the same question twice in different shapes:
- **Q4 (Workflow):** "How does this agent operate? Guidelines, tone, do's and don'ts — mini operating manual."
- **Q7c (Trigger Prompt):** "What should the agent do when this fires?"

The user (Reg UAT, 2026-04-07) wrote a 300-word workflow describing exactly what Reg should do on each daily run, then was asked the trigger prompt question and replied: *"This has already been defined here:"* and pasted the same content verbatim.

### Why it matters
- Wastes user time and patience.
- Creates two sources of truth that can drift (the SOUL.md `## Workflow` block and the job's trigger prompt). Which one wins at runtime?
- Encourages users to abandon the wizard mid-flow.

### Proposed fix
Wizard logic: when the user has provided a non-trivial Workflow AND the agent has exactly one job, **default the trigger prompt to "Run the workflow defined in SOUL.md"** (or actually inline the workflow content) and skip Q7c. Offer "want to override the trigger prompt for this job? (y/n)" as an opt-out for users who genuinely want a different per-job trigger.

Multi-job agents still need per-job trigger prompts since different jobs do different things.

## GAP-17-03 — Network glitch eats wizard acknowledgment, no recovery

**Severity:** Medium-High (fragility, not always reproducible but already happened in UAT)
**Status:** Open

### Symptom
During Reg UAT, a `[Failed: TypeError: network error]` swallowed Claude's acknowledgment of the role answer. The user typed the personality answer next, which Claude (correctly) accepted as Q3 — but with no visible "got it" reply, the user didn't know whether the wizard had advanced. They had to ask "Are you still working on the guidelines?" to confirm state.

### Why it matters
The wizard is stateful but stateless on the user side — when an acknowledgment is dropped, the user has no way to resync without asking Claude. For long wizards (8+ questions) this is a real failure mode.

### Proposed fix
- Echo the captured value at the start of every question: `Got it — role: "Researches Topics..." Next: who are they? Personality (2-4 sentences).`
- After the last question, before scaffolding, print a full "here's everything I have, confirm or amend" review block.
- Persist wizard state to `/tmp/claudeclaw-agent-wizard.json` after EACH answer (not just at the end), so a network glitch / context reset doesn't lose progress.

---

## Verification gate

Phase 17 cannot be marked verified until:
- [ ] GAP-17-01 deployed to server and a fresh wizard run successfully scaffolds an agent at `/home/claw/project/agents/<name>/` with `## Workflow` markers in SOUL.md and `agents/<name>/jobs/<label>.md` for each scheduled task
- [ ] GAP-17-02 fixed in `skills/create-agent/SKILL.md` (single-job workflow reuse) and re-tested
- [ ] GAP-17-03 fixed (per-question echo + final review block + per-step temp-file persistence)

Plan 17-05's SUMMARY and the phase verification step (`gsd-verifier`) are blocked on these.
