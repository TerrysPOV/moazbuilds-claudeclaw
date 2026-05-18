import { z } from 'zod';
import type { Patch, Proposal, UnsignedProposal } from '../../skills-tuner/core/types.js';
import type { RiskTier } from '../../skills-tuner/core/interfaces.js';

// ── Adaptive scheduling ─────────────────────────────────────────────────────

export const ScheduleStateSchema = z.object({
  subject: z.string(),
  last_run: z.coerce.date(),
  next_run: z.coerce.date(),
  current_interval_hours: z.number().int().min(1).max(168),
  consecutive_zero_runs: z.number().int().min(0),
  last_proposal_count: z.number().int().min(0),
  enabled: z.boolean(),
});
export type ScheduleState = z.infer<typeof ScheduleStateSchema>;

export const INITIAL_INTERVAL_HOURS = 24;
export const MAX_INTERVAL_HOURS = 168;
export const HIGH_RISK_OBSERVATION_WINDOW_MS = 5 * 60 * 1000;

// ── Rollback history ────────────────────────────────────────────────────────

export const AppliedBy = z.enum(['cli', 'telegram', 'auto-revert']);
export type AppliedBy = z.infer<typeof AppliedBy>;

export const RevisionRecordSchema = z.object({
  id: z.number().int(),
  proposal_id: z.string(),
  subject: z.string(),
  applied_at: z.coerce.date(),
  forward_patch: z.object({
    target_path: z.string(),
    kind: z.string(),
    applied_content: z.string(),
  }),
  inverse_patch: z.object({
    target_path: z.string(),
    kind: z.string(),
    applied_content: z.string(),
  }),
  applied_by: AppliedBy,
  rolled_back_at: z.coerce.date().nullable(),
});
export type RevisionRecord = z.infer<typeof RevisionRecordSchema>;

// ── Subject contract extension ──────────────────────────────────────────────
//
// All 8 new wisecron subjects implement this surface on top of TunableSubject.
// `apply()` must return a Patch (existing TunableSubject contract). `revert()`
// is wisecron-specific — it consumes the inverse_patch persisted in
// rollback_history.

export interface RevertibleSubject {
  readonly name: string;
  readonly risk_tier: RiskTier;
  revert(inversePatch: Patch): Promise<void>;
}

// ── Proposal lifecycle ──────────────────────────────────────────────────────

export interface ProposalSummary {
  proposal: Proposal;
  subject: string;
  risk_tier: RiskTier;
  diff_preview: string;
}

export interface ProposalCycleResult {
  subject: string;
  observations: number;
  clusters: number;
  proposals: UnsignedProposal[];
  duration_ms: number;
}

// ── Apply pipeline ──────────────────────────────────────────────────────────

export interface ApplyOutcome {
  revision: RevisionRecord;
  observation_window_armed: boolean;
  auto_reverted: boolean;
  audit_event_id: string;
}

export interface ObservationWindowResult {
  reverted: boolean;
  reason: string | null;
  errors_detected: string[];
}

// ── Wisecron settings (extends TunerConfig.wisecron section) ────────────────

export const WisecronSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  db_path: z.string().default('~/.config/tuner/wisecron.db'),
  systemd_unit_prefix: z.string().default('wisecron-'),
  initial_interval_hours: z.number().int().min(1).default(INITIAL_INTERVAL_HOURS),
  max_interval_hours: z.number().int().min(1).default(MAX_INTERVAL_HOURS),
  llm_model_for_propose: z.string().default('claude-sonnet-4-6'),
  llm_call_path: z.enum(['direct-sdk', 'llm-router']).default('direct-sdk'),
  subjects: z.record(z.string(), z.object({ enabled: z.boolean() })).default({}),
  rollback: z.object({
    retention_days: z.number().int().min(1).default(90),
    require_confirm_on_rollback: z.boolean().default(true),
  }).default({}),
});
export type WisecronSettings = z.infer<typeof WisecronSettingsSchema>;
