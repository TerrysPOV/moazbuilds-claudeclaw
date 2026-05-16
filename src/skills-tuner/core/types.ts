import { z } from "zod";

export const ORPHAN_SUBJECT = "__new_entity__" as const;

export const CREATE_KINDS = new Set([
  "new_skill",
  "new_intent",
  "new_source",
  "new_mcp",
  "new_tool",
] as const);
export type CreateKind = "new_skill" | "new_intent" | "new_source" | "new_mcp" | "new_tool";

export const ObservationSchema = z.object({
  session_id: z.string(),
  observed_at: z.coerce.date(),
  signal_type: z.enum(["correction", "positive_feedback", "repeated_trigger", "orphan"]),
  verbatim: z.string().max(500),
  metadata: z.record(z.unknown()).default({}),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const AlternativeSchema = z.object({
  id: z.string(),
  label: z.string(),
  diff_or_content: z.string(),
  tradeoff: z.string().default(""),
});
export type Alternative = z.infer<typeof AlternativeSchema>;

export const UnsignedProposalSchema = z.object({
  id: z.number().int(),
  cluster_id: z.string(),
  subject: z.string(),
  kind: z.string(),
  target_path: z.string(),
  alternatives: z.array(AlternativeSchema).min(1).max(3),
  pattern_signature: z.string(),
  created_at: z.coerce.date(),
});
export type UnsignedProposal = z.infer<typeof UnsignedProposalSchema>;

export const ProposalSchema = UnsignedProposalSchema.extend({
  signature: z.string().min(1),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const ClusterSchema = z.object({
  id: z.string(),
  subject: z.string(),
  observations: z.array(ObservationSchema),
  frequency: z.number().int().min(1),
  success_rate: z.number().min(0).max(1),
  sentiment: z.enum(["positive", "negative", "neutral"]),
  subjects_touched: z.array(z.string()).default([]),
});
export type Cluster = z.infer<typeof ClusterSchema>;

export const PatchSchema = z.object({
  target_path: z.string(),
  kind: z.string(),
  applied_content: z.string(),
});
export type Patch = z.infer<typeof PatchSchema>;

export const ValidationResultSchema = z.object({
  valid: z.boolean(),
  reason: z.string().optional(),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;
