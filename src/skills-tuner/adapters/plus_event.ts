import { Adapter } from "../core/interfaces.js";
import type { Proposal } from "../core/types.js";

/**
 * Stub adapter for ClaudeClaw-Plus event bus.
 *
 * NOTE: With Plus issue #31 (plugin to MCP bridge), Plus would expose
 * tuner tools as MCP automatically and this adapter would collapse to
 * thin wrapper calls to native Plus endpoints. Without #31, we duplicate
 * notification + callback routing in TelegramAdapter.
 */
export class PlusEventAdapter extends Adapter {
  constructor(private plusBaseUrl: string = "http://localhost:3000") {
    super();
  }

  async renderProposal(proposal: Proposal): Promise<void> {
    console.log(
      "[PlusEventAdapter STUB] Would POST proposal #" +
        proposal.id +
        " (subject=" +
        proposal.subject +
        ", kind=" +
        proposal.kind +
        ")" +
        " to " +
        this.plusBaseUrl +
        "/api/tuner/proposal",
    );
  }

  async renderApplyConfirmation(proposal: Proposal, alternativeId: string): Promise<void> {
    console.log(
      "[PlusEventAdapter STUB] Would POST apply confirmation" +
        " (proposalId=" +
        proposal.id +
        ", alt=" +
        alternativeId +
        ")" +
        " to " +
        this.plusBaseUrl +
        "/api/tuner/applied",
    );
  }
}
