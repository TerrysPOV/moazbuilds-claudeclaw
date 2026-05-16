import type { Proposal } from "../core/types.js";

export interface CallbackPayload {
  proposalId: number;
  alternativeId?: string;
  action: "apply" | "refuse" | "edit";
}

export type CallbackHandler = (payload: CallbackPayload) => Promise<void>;

export interface FeedbackResponse {
  proposalId: number;
  preferred: "yes" | "yes_but" | "no";
  comment?: string;
}

export type FeedbackHandler = (response: FeedbackResponse) => Promise<void>;
