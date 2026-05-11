import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';

export const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'tuner', 'config.yaml');

const ModelConfigSchema = z.object({
  intent_classifier: z.string().default('claude-haiku-4-5-20251001'),
  detector: z.string().default('claude-opus-4-7'),
  proposer_default: z.string().default('claude-sonnet-4-6'),
  proposer_high_stakes: z.string().default('claude-opus-4-7'),
  judge: z.string().default('claude-opus-4-7'),
});

const SubjectConfigSchema = z.object({
  enabled: z.boolean().default(true),
  git_repo: z.string().optional(),
  auto_merge: z.union([z.boolean(), z.array(z.string())]).default(false),
  proposer: z.string().optional(),
  proposer_for_create: z.string().optional(),
  scan_dirs: z.array(z.string()).default([]),
  emotional_patterns: z.array(z.string()).optional(),
  overrides: z.record(z.unknown()).optional(),
});
export type SubjectConfig = z.infer<typeof SubjectConfigSchema>;

const DetectionConfigSchema = z.object({
  improvement_keywords_extra: z.array(z.string()).default([]),
  confidence_floor: z.number().min(0).max(1).default(0.65),
  max_proposals_per_run: z.number().int().positive().default(5),
});

const ProposerConfigSchema = z.object({
  alternatives_count: z.number().int().positive().default(3),
  language_preference: z.string().default('en'),
});

const UiConfigSchema = z.object({
  primary_adapter: z.string().default('cli'),
  follow_up_survey: z.boolean().default(true),
  follow_up_after_seconds: z.number().int().positive().default(30),
});

const StorageConfigSchema = z.object({
  proposals_jsonl: z.string().default(join(homedir(), '.config', 'tuner', 'proposals.jsonl')),
  refused_jsonl: z.string().default(join(homedir(), '.config', 'tuner', 'refused.jsonl')),
  schema_version: z.number().int().default(1),
  backup_keep: z.number().int().default(7),
  git_repo: z.string().optional(),
});

const LLMConfigSchema = z.object({
  backend: z.enum(['anthropic_api', 'claude_cli']).default('anthropic_api'),
  api_key: z.string().optional(),
});

const TunerConfigSchema = z.object({
  models: ModelConfigSchema.default({}),
  llm: LLMConfigSchema.default({}),
  detection: DetectionConfigSchema.default({}),
  proposer: ProposerConfigSchema.default({}),
  subjects: z.record(SubjectConfigSchema).default({}),
  ui: UiConfigSchema.default({}),
  storage: StorageConfigSchema.default({}),
});
export type TunerConfig = z.infer<typeof TunerConfigSchema>;

export function subjectConfig(config: TunerConfig, name: string): SubjectConfig {
  return config.subjects[name] ?? SubjectConfigSchema.parse({});
}

export function loadConfig(path = DEFAULT_CONFIG_PATH): TunerConfig {
  if (!existsSync(path)) {
    return TunerConfigSchema.parse({});
  }
  const raw = yaml.load(readFileSync(path, 'utf8')) as Record<string, unknown> ?? {};
  // Expand ~ in storage paths
  if (raw['storage'] && typeof raw['storage'] === 'object') {
    const storage = raw['storage'] as Record<string, unknown>;
    for (const key of ['proposals_jsonl', 'refused_jsonl', 'git_repo']) {
      if (typeof storage[key] === 'string') {
        storage[key] = (storage[key] as string).replace(/^~/, homedir());
      }
    }
  }
  // Expand ~ in per-subject git_repo paths
  if (raw['subjects'] && typeof raw['subjects'] === 'object') {
    for (const subj of Object.values(raw['subjects'] as Record<string, unknown>)) {
      if (subj && typeof subj === 'object') {
        const s = subj as Record<string, unknown>;
        if (typeof s['git_repo'] === 'string') {
          s['git_repo'] = (s['git_repo'] as string).replace(/^~/, homedir());
        }
      }
    }
  }
  return TunerConfigSchema.parse(raw);
}

const DEFAULT_YAML = `# Skills Tuner TS configuration

llm:
  backend: anthropic_api
  # api_key: sk-ant-...   # or set ANTHROPIC_API_KEY env var

detection:
  confidence_floor: 0.65
  max_proposals_per_run: 5

models:
  intent_classifier: claude-haiku-4-5-20251001
  detector: claude-opus-4-7
  proposer_default: claude-sonnet-4-6
  proposer_high_stakes: claude-opus-4-7
  judge: claude-opus-4-7

proposer:
  alternatives_count: 3
  language_preference: en

subjects:
  skills:
    enabled: true
    auto_merge: [patch, frontmatter]
    proposer: claude-sonnet-4-6
    proposer_for_create: claude-opus-4-7

ui:
  primary_adapter: cli
  follow_up_survey: true
  follow_up_after_seconds: 30

storage:
  backup_keep: 7
`;

export function writeDefaultConfig(path = DEFAULT_CONFIG_PATH): void {
  mkdirSync(join(path, '..'), { recursive: true });
  if (existsSync(path)) throw new Error(`Config already exists at ${path}`);
  writeFileSync(path, DEFAULT_YAML, 'utf8');
}
