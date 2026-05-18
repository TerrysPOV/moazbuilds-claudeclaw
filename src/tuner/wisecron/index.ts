/**
 * wisecron — TunableSubject scheduler integrated inside the tuner.
 *
 * Public surface for registering the 8 new wisecron-managed subjects and
 * wiring the adaptive scheduler + apply pipeline against the tuner Registry.
 *
 * Not standalone, not MCP. See SPEC at ~/agent/plugin-specs/wisecron/SPEC.md.
 *
 * Phase 1 — fork Nibbler1250, opt-in via wisecron.enabled in config.yaml.
 */

import type { Registry } from '../../skills-tuner/core/registry.js';
import type { LLMClient } from '../../skills-tuner/core/llm.js';
import type { TunableSubject } from '../../skills-tuner/core/interfaces.js';
import { WisecronStateDB } from './state-db.js';
import { AdaptiveScheduler } from './adaptive-scheduler.js';
import { ProposalEngine } from './proposal-engine.js';
import { ApplyPipeline } from './apply-pipeline.js';
import type { WisecronSettings } from './types.js';

import { CronSubject } from '../subjects/cron-subject.js';
import { ClaudeMdSubject } from '../subjects/claude-md-subject.js';
import { HookSubject } from '../subjects/hook-subject.js';
import { McpPluginSubject } from '../subjects/mcp-plugin-subject.js';
import { ModelRoutingSubject } from '../subjects/model-routing-subject.js';
import { PromptTemplateSubject } from '../subjects/prompt-template-subject.js';
import { MemorySubject } from '../subjects/memory-subject.js';
import { AgentSubject } from '../subjects/agent-subject.js';

export interface WisecronContext {
  db: WisecronStateDB;
  scheduler: AdaptiveScheduler;
  engine: ProposalEngine;
  pipeline: ApplyPipeline;
}

/**
 * Register all 8 wisecron-managed subjects against the tuner registry, and
 * return the orchestrator handles for the CLI layer to drive.
 *
 * Honours per-subject `enabled` flags in settings.subjects.
 */
export function registerWisecronSubjects(
  registry: Registry,
  settings: WisecronSettings,
  opts: { llm?: LLMClient } = {},
): WisecronContext {
  const db = new WisecronStateDB(settings.db_path);
  const scheduler = new AdaptiveScheduler(db, {
    initialHours: settings.initial_interval_hours,
    maxHours: settings.max_interval_hours,
  });
  const engine = new ProposalEngine(registry, db);
  const pipeline = new ApplyPipeline(registry, db);

  const enabled = (name: string) => settings.subjects?.[name]?.enabled !== false;

  const registerWithProbeCheck = (subject: TunableSubject): void => {
    registry.registerSubject(subject);
    scheduler.ensureRegistered(subject.name);
    warnIfMissingHealthProbe(subject);
  };

  if (enabled('cron')) registerWithProbeCheck(new CronSubject({ llm: opts.llm }));
  if (enabled('claude_md')) registerWithProbeCheck(new ClaudeMdSubject({ llm: opts.llm }));
  if (enabled('hook')) registerWithProbeCheck(new HookSubject({ llm: opts.llm }));
  if (enabled('mcp_plugin')) registerWithProbeCheck(new McpPluginSubject({ llm: opts.llm }));
  if (enabled('model_routing')) registerWithProbeCheck(new ModelRoutingSubject({ llm: opts.llm }));
  if (enabled('prompt_template')) registerWithProbeCheck(new PromptTemplateSubject({ llm: opts.llm }));
  if (enabled('memory')) registerWithProbeCheck(new MemorySubject({ llm: opts.llm }));
  if (enabled('agent')) registerWithProbeCheck(new AgentSubject({ llm: opts.llm }));

  return { db, scheduler, engine, pipeline };
}

/**
 * Emit a one-time console.warn when a high/medium-risk subject ships without
 * a healthProbe implementation. The ApplyPipeline's default probe is
 * fail-open, so a missing probe silently disables the observation-window
 * auto-revert path; this warning surfaces that so operators can wire one in.
 *
 * Resolution order at apply time: pipeline's injected `healthProbe` option
 * wins over the subject's own `healthProbe()`. The warning fires on the
 * subject side; if the operator wires a pipeline-level probe, the warning
 * is informational only.
 */
function warnIfMissingHealthProbe(subject: TunableSubject): void {
  if (subject.risk_tier !== 'high' && subject.risk_tier !== 'medium') return;
  if (typeof (subject as TunableSubject & { healthProbe?: unknown }).healthProbe === 'function') return;
  console.warn(
    `[tuner] subject '${subject.name}' (risk=${subject.risk_tier}) has no healthProbe — ` +
    `auto-revert disabled. Wire a probe via ApplyPipeline opts or apply only with explicit observe=false.`,
  );
}

export { WisecronStateDB } from './state-db.js';
export { AdaptiveScheduler } from './adaptive-scheduler.js';
export { ProposalEngine } from './proposal-engine.js';
export { ApplyPipeline } from './apply-pipeline.js';
export type {
  ScheduleState,
  RevisionRecord,
  AppliedBy,
  ProposalSummary,
  ProposalCycleResult,
  ApplyOutcome,
  ObservationWindowResult,
  WisecronSettings,
  RevertibleSubject,
} from './types.js';
