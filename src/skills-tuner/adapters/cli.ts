import { Adapter } from "../core/interfaces.js";
import type { Proposal } from "../core/types.js";

export class CliAdapter extends Adapter {
  async renderProposal(proposal: Proposal): Promise<void> {
    console.log("━".repeat(60));
    console.log("Proposal #" + proposal.id + " (" + proposal.subject + "/" + proposal.kind + ")");
    console.log("Target: " + proposal.target_path);
    console.log("Pattern: " + proposal.pattern_signature);
    console.log("");
    for (const alt of proposal.alternatives) {
      console.log("  " + alt.id + ". " + alt.label);
      if (alt.tradeoff) console.log("     " + alt.tradeoff);
      console.log("");
    }
    console.log("Apply with: tuner apply " + proposal.id + " <A|B|C>");
    console.log("Refuse with: tuner skip " + proposal.id);
    console.log("━".repeat(60));
  }

  async renderApplyConfirmation(proposal: Proposal, alternativeId: string): Promise<void> {
    console.log("Applied alternative " + alternativeId + " from proposal #" + proposal.id);
  }
}
