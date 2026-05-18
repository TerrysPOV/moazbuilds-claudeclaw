import type {
  Cluster,
  Observation,
  Patch,
  Proposal,
  UnsignedProposal,
  ValidationResult,
} from "./types.js";
import { ORPHAN_SUBJECT } from "./types.js";

export type RiskTier = "low" | "medium" | "high" | "critical";

export abstract class TunableSubject {
  abstract readonly name: string;
  readonly risk_tier: RiskTier = "low";
  readonly auto_merge_default: boolean = false;
  readonly supports_creation: boolean = false;
  readonly orphan_min_observations: number = 2;

  abstract collectObservations(since: Date): Promise<Observation[]>;
  abstract detectProblems(observations: Observation[]): Promise<Cluster[]>;
  abstract proposeChange(cluster: Cluster): Promise<UnsignedProposal>;
  abstract apply(proposal: Proposal, alternativeId: string): Promise<Patch>;
  abstract validate(patch: Patch): Promise<ValidationResult>;

  scoreSignal(
    _verbatim: string,
    _attributedTo: string,
    _knownEntities: Record<string, unknown>,
  ): number {
    return 0;
  }

  reclassifySignal(_verbatim: string, _knownEntities: Record<string, unknown>): string {
    return ORPHAN_SUBJECT;
  }

  /**
   * Compute a deterministic hash of this subject's managed state.
   * Used by the engine to detect drift between cron ticks.
   *
   * Default returns empty string (no drift detection — opt-in per subject).
   * Override to track changes in scan_dirs, plugin lists, RAG corpus, etc.
   *
   * Hash must be stable across runs (no clocks, no random) and reflect
   * any meaningful change to what the subject would propose tuning.
   */
  currentStateHash(): string {
    return "";
  }

  /**
   * Optional: produce the inverse-patch `applied_content` for `target`
   * before apply() runs. When undefined, the pipeline falls back to reading
   * `target` from disk. Overriders return a string (the inverse content) —
   * cron serializes the prior JobSpec, hook captures the prior file bytes.
   */
  snapshotInverse?(target: string): Promise<string>;

  /**
   * Optional: per-subject health probe consulted by the apply pipeline's
   * observation window. When undefined for a high/medium-risk subject, the
   * pipeline logs a boot warning and the auto-revert path is effectively
   * disabled (the default pipeline probe is fail-open).
   */
  healthProbe?(target: string): Promise<{ failed: boolean; errors: string[] }>;
}

export abstract class Adapter {
  abstract renderProposal(proposal: Proposal): Promise<void>;
  abstract renderApplyConfirmation(proposal: Proposal, alternativeId: string): Promise<void>;
}

export { ORPHAN_SUBJECT, CREATE_KINDS } from "./types.js";
export type { UnsignedProposal } from "./types.js";
