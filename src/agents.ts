/**
 * Agents Module
 *
 * Core scaffolding for ClaudeClaw agents. Provides validation, NL→cron parsing,
 * and file generation primitives used by the create-agent wizard and runtime.
 */

import { join } from "path";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, writeFile, stat, unlink, rm } from "fs/promises";
import { ensureMemoryFile } from "./memory";
import { cronMatches } from "./cron";

// Resolve dirs at call time (not module load) so tests and runtime
// pick up the current working directory.
function projectDir(): string {
  return process.cwd();
}

function agentsDir(): string {
  return join(projectDir(), "agents");
}

export function agentJobsDir(name: string): string {
  return join(agentsDir(), name, "jobs");
}

function jobFilePath(agentName: string, label: string): string {
  return join(agentJobsDir(agentName), `${label}.md`);
}

export interface AgentCreateOpts {
  name: string;
  role: string;
  personality: string;
  schedule?: string;
  discordChannels?: string[];
  dataSources?: string;
  defaultPrompt?: string;
}

export interface AgentContext {
  name: string;
  dir: string;
  identityPath: string;
  soulPath: string;
  claudeMdPath: string;
  memoryPath: string;
  sessionPath: string;
}

export interface AgentJob {
  label: string;
  cron: string;
  enabled: boolean;
  model?: string;
  trigger: string;
  path: string;
}

const JOB_LABEL_RE = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

export function validateJobLabel(label: string): { valid: boolean; error?: string } {
  if (!label || typeof label !== "string") {
    return { valid: false, error: "label required" };
  }
  if (label.includes("/") || label.includes("..") || label.includes("\\")) {
    return { valid: false, error: "must not contain path separators" };
  }
  if (!JOB_LABEL_RE.test(label)) {
    return { valid: false, error: "must be kebab-case" };
  }
  return { valid: true };
}

// ─── Validation ──────────────────────────────────────────────────────────────

const NAME_RE = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

export function validateAgentName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== "string") {
    return { valid: false, error: "Name must be a non-empty string" };
  }
  if (!NAME_RE.test(name)) {
    return {
      valid: false,
      error:
        "Name must be kebab-case: lowercase letters, digits, hyphens; must start with a letter and not end with a hyphen",
    };
  }
  if (existsSync(join(agentsDir(), name))) {
    return { valid: false, error: `Agent "${name}" already exists` };
  }
  return { valid: true };
}

// ─── NL → cron ───────────────────────────────────────────────────────────────

const RAW_CRON_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;

const DAY_NAMES: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function parseHour(timeStr: string): number | null {
  // Handles "9am", "9 am", "5pm", "12am", "12pm", "9", "09:00", "9:30"
  const m = timeStr.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const ampm = m[3]?.toLowerCase();
  if (ampm === "am") {
    if (h === 12) h = 0;
  } else if (ampm === "pm") {
    if (h !== 12) h += 12;
  }
  if (h < 0 || h > 23) return null;
  return h;
}

export function parseScheduleToCron(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;

  // Raw 5-field cron: validate via cronMatches
  if (RAW_CRON_RE.test(s)) {
    try {
      cronMatches(s, new Date());
      return s;
    } catch {
      return null;
    }
  }

  // Presets
  if (s === "hourly" || s === "every hour") return "0 * * * *";
  if (s === "daily" || s === "every day" || s === "every day at midnight") {
    return "0 0 * * *";
  }
  if (s === "weekly" || s === "every week") return "0 0 * * 0";

  // every N minutes
  let m = s.match(/^every\s+(\d+)\s+minutes?$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n > 0 && n < 60) return `*/${n} * * * *`;
    return null;
  }

  // every weekday at <time>
  m = s.match(/^every\s+weekday(?:s)?(?:\s+at\s+(.+))?$/);
  if (m) {
    const t = m[1] ?? "9am";
    const h = parseHour(t);
    if (h === null) return null;
    return `0 ${h} * * 1-5`;
  }

  // daily at <time> / every day at <time>
  m = s.match(/^(?:daily|every day)\s+at\s+(.+)$/);
  if (m) {
    const h = parseHour(m[1]);
    if (h === null) return null;
    return `0 ${h} * * *`;
  }

  // every <dayname> [at <time>]
  m = s.match(/^every\s+(\w+?)s?(?:\s+at\s+(.+))?$/);
  if (m) {
    const day = DAY_NAMES[m[1]];
    if (day === undefined) return null;
    const h = m[2] ? parseHour(m[2]) : 0;
    if (h === null) return null;
    return `0 ${h} * * ${day}`;
  }

  return null;
}

// ─── Templates ───────────────────────────────────────────────────────────────

function renderIdentity(name: string, role: string): string {
  return [
    `# Identity`,
    ``,
    `- **Name:** ${name}`,
    `- **Role:** ${role}`,
    `- **Creature:** A ClaudeClaw agent — a focused familiar with one job to do well.`,
    `- **Vibe:** Sharp, purposeful, gets things done.`,
    ``,
    `---`,
    ``,
    `This is who you are. Make it yours.`,
    ``,
  ].join("\n");
}

function renderSoul(personality: string): string {
  return [
    `_You're not a chatbot. You're becoming someone._`,
    ``,
    `## Personality`,
    ``,
    personality,
    ``,
    `## Core Truths`,
    ``,
    `**Be genuinely helpful, not performatively helpful.** Skip the filler — just help.`,
    ``,
    `**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring.`,
    ``,
    `**Be resourceful before asking.** Try to figure it out first.`,
    ``,
    `**Earn trust through competence.** Be careful with external actions, bold with internal ones.`,
    ``,
  ].join("\n");
}

function renderClaudeMd(opts: AgentCreateOpts): string {
  const channels =
    opts.discordChannels && opts.discordChannels.length > 0
      ? opts.discordChannels.map((c) => `- ${c}`).join("\n")
      : "_none specified_";
  const sources = opts.dataSources && opts.dataSources.trim() ? opts.dataSources.trim() : "_none specified_";
  return [
    `# Agent: ${opts.name}`,
    ``,
    `## Role`,
    ``,
    opts.role,
    ``,
    `## Discord Channels`,
    ``,
    channels,
    ``,
    `## Data Sources`,
    ``,
    sources,
    ``,
  ].join("\n");
}

function renderJobFile(label: string, cron: string, trigger: string, model?: string): string {
  const lines = [
    `---`,
    `label: ${label}`,
    `cron: ${cron}`,
    `enabled: true`,
  ];
  if (model) lines.push(`model: ${model}`);
  lines.push(`---`, ``, trigger, ``);
  return lines.join("\n");
}

function parseFrontmatterValue(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "");
}

function parseJobFileContent(
  content: string
): { label: string; cron: string; enabled: boolean; model?: string; trigger: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return null;
  const fm = match[1];
  const trigger = match[2].replace(/^\n+/, "").replace(/\n+$/, "");
  const lines = fm.split("\n").map((l) => l.trim());

  const labelLine = lines.find((l) => l.startsWith("label:"));
  const cronLine = lines.find((l) => l.startsWith("cron:"));
  if (!labelLine || !cronLine) return null;
  const label = parseFrontmatterValue(labelLine.replace("label:", ""));
  const cron = parseFrontmatterValue(cronLine.replace("cron:", ""));

  const enabledLine = lines.find((l) => l.startsWith("enabled:"));
  let enabled = true;
  if (enabledLine) {
    const v = parseFrontmatterValue(enabledLine.replace("enabled:", "")).toLowerCase();
    if (v === "false" || v === "no" || v === "0") enabled = false;
  }

  const modelLine = lines.find((l) => l.startsWith("model:"));
  const model = modelLine ? parseFrontmatterValue(modelLine.replace("model:", "")) || undefined : undefined;

  return { label, cron, enabled, model, trigger };
}

function validateCronOrThrow(cron: string): void {
  if (!cron || typeof cron !== "string") {
    throw new Error(`invalid cron expression: "${cron}"`);
  }
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`invalid cron expression: "${cron}" (expected 5 fields)`);
  }
  // Each field must contain only cron-valid chars
  const FIELD_RE = /^[\d*,\-/]+$/;
  for (const f of fields) {
    if (!FIELD_RE.test(f)) {
      throw new Error(`invalid cron expression: "${cron}"`);
    }
  }
  try {
    cronMatches(cron, new Date());
  } catch {
    throw new Error(`invalid cron expression: "${cron}"`);
  }
}

export async function addJob(
  agentName: string,
  label: string,
  cron: string,
  trigger: string,
  model?: string
): Promise<AgentJob> {
  // Verify agent exists
  await loadAgent(agentName);

  const lv = validateJobLabel(label);
  if (!lv.valid) throw new Error(`invalid job label: ${lv.error}`);

  validateCronOrThrow(cron);

  await mkdir(agentJobsDir(agentName), { recursive: true });
  const path = jobFilePath(agentName, label);
  if (existsSync(path)) {
    throw new Error(`job ${label} already exists for agent ${agentName}`);
  }

  await writeFile(path, renderJobFile(label, cron, trigger, model), "utf8");

  return { label, cron, enabled: true, model, trigger, path };
}

export async function updateJob(
  agentName: string,
  label: string,
  patch: { cron?: string; trigger?: string; enabled?: boolean; model?: string }
): Promise<AgentJob> {
  const path = jobFilePath(agentName, label);
  if (!existsSync(path)) {
    throw new Error(`job ${label} does not exist for agent ${agentName}`);
  }
  const content = await readFile(path, "utf8");
  const parsed = parseJobFileContent(content);
  if (!parsed) throw new Error(`could not parse job file: ${path}`);

  const merged = {
    label: parsed.label,
    cron: patch.cron ?? parsed.cron,
    enabled: patch.enabled ?? parsed.enabled,
    model: patch.model !== undefined ? patch.model : parsed.model,
    trigger: patch.trigger ?? parsed.trigger,
  };

  if (patch.cron !== undefined) validateCronOrThrow(merged.cron);

  // Render preserving enabled flag
  const lines = [
    `---`,
    `label: ${merged.label}`,
    `cron: ${merged.cron}`,
    `enabled: ${merged.enabled}`,
  ];
  if (merged.model) lines.push(`model: ${merged.model}`);
  lines.push(`---`, ``, merged.trigger, ``);
  await writeFile(path, lines.join("\n"), "utf8");

  return { ...merged, path };
}

export async function removeJob(agentName: string, label: string): Promise<void> {
  await unlink(jobFilePath(agentName, label));
}

export async function listAgentJobs(agentName: string): Promise<AgentJob[]> {
  let files: string[];
  try {
    files = await readdir(agentJobsDir(agentName));
  } catch {
    return [];
  }
  const jobs: AgentJob[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const path = join(agentJobsDir(agentName), file);
    const content = await readFile(path, "utf8");
    const parsed = parseJobFileContent(content);
    if (parsed) {
      jobs.push({ ...parsed, path });
    }
  }
  jobs.sort((a, b) => a.label.localeCompare(b.label));
  return jobs;
}

export async function deleteAgent(name: string): Promise<void> {
  await rm(join(agentsDir(), name), { recursive: true, force: true });
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function createAgent(opts: AgentCreateOpts): Promise<AgentContext> {
  const v = validateAgentName(opts.name);
  if (!v.valid) {
    throw new Error(`Invalid agent name: ${v.error}`);
  }

  const dir = join(agentsDir(), opts.name);
  await mkdir(dir, { recursive: true });

  const identityPath = join(dir, "IDENTITY.md");
  const soulPath = join(dir, "SOUL.md");
  const claudeMdPath = join(dir, "CLAUDE.md");
  const memoryPath = join(dir, "MEMORY.md");
  const sessionPath = join(dir, "session.json");
  const gitignorePath = join(dir, ".gitignore");

  await writeFile(identityPath, renderIdentity(opts.name, opts.role), "utf8");
  await writeFile(soulPath, renderSoul(opts.personality), "utf8");
  await writeFile(claudeMdPath, renderClaudeMd(opts), "utf8");
  await ensureMemoryFile(opts.name);
  await writeFile(gitignorePath, "session.json\nMEMORY.md\n", "utf8");

  if (opts.schedule) {
    const cron = parseScheduleToCron(opts.schedule);
    if (!cron) {
      throw new Error(`Could not parse schedule: "${opts.schedule}"`);
    }
    // Validate the cron parses cleanly
    try {
      cronMatches(cron, new Date());
    } catch (e) {
      throw new Error(`Generated invalid cron "${cron}" from schedule "${opts.schedule}"`);
    }
    // Phase 17: scheduled tasks now live under agents/<name>/jobs/
    const body = opts.defaultPrompt ?? "Run your scheduled task per IDENTITY.md.";
    await addJob(opts.name, "default", cron, body, undefined);
  }

  return {
    name: opts.name,
    dir,
    identityPath,
    soulPath,
    claudeMdPath,
    memoryPath,
    sessionPath,
  };
}

export async function loadAgent(name: string): Promise<AgentContext> {
  const dir = join(agentsDir(), name);
  if (!existsSync(dir)) {
    throw new Error(`Agent "${name}" does not exist`);
  }
  return {
    name,
    dir,
    identityPath: join(dir, "IDENTITY.md"),
    soulPath: join(dir, "SOUL.md"),
    claudeMdPath: join(dir, "CLAUDE.md"),
    memoryPath: join(dir, "MEMORY.md"),
    sessionPath: join(dir, "session.json"),
  };
}

export async function listAgents(): Promise<string[]> {
  const dir = agentsDir();
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const result: string[] = [];
  for (const entry of entries) {
    try {
      const s = await stat(join(dir, entry));
      if (s.isDirectory()) result.push(entry);
    } catch {
      // skip
    }
  }
  return result.sort();
}
