import { simpleGit, type SimpleGit } from "simple-git";
import { writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { Patch, Proposal } from "../core/types.js";

export class BranchManager {
  private git: SimpleGit;

  constructor(public readonly repoPath: string) {
    this.git = simpleGit(repoPath);
  }

  async ensureRepo(): Promise<void> {
    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) throw new Error(`${this.repoPath} is not a git repository`);
  }

  branchName(proposalId: number): string {
    return `tune/proposal-${proposalId}`;
  }

  async createProposalBranch(proposalId: number, baseBranch = "main"): Promise<string> {
    const name = this.branchName(proposalId);
    const branches = await this.git.branchLocal();
    if (branches.all.includes(name)) {
      await this.git.checkout(name);
      return name;
    }
    // Always branch from baseBranch (not the current HEAD) so successive
    // auto-merged proposals don't stack on each other.
    if (!branches.all.includes(baseBranch)) {
      throw new Error(
        `Base branch '${baseBranch}' not found in repo. Cannot create proposal branch — refusing to branch from current HEAD which would let proposals stack on each other. Set baseBranch explicitly if your repo doesn't use 'main'.`,
      );
    }
    await this.git.checkout(baseBranch);
    await this.git.checkoutLocalBranch(name);
    return name;
  }

  // Switch to a specific proposal branch (used before revert)
  async checkoutProposalBranch(proposalId: number): Promise<string> {
    const name = this.branchName(proposalId);
    await this.git.checkout(name);
    return name;
  }

  async commitPatch(patch: Patch, proposal: Proposal, alternativeId: string): Promise<string> {
    const target = resolve(patch.target_path.replace(/^~/, homedir()));
    const repoRoot = resolve(this.repoPath);
    if (!target.startsWith(repoRoot + sep) && target !== repoRoot) {
      throw new Error(
        `BranchManager refusing to write outside repo: target=${target}, repo=${repoRoot}`,
      );
    }
    // Symlink traversal check: resolve the real path if the target already exists as a symlink
    if (existsSync(target)) {
      const resolvedTarget = realpathSync(target);
      if (!resolvedTarget.startsWith(repoRoot + sep) && resolvedTarget !== repoRoot) {
        throw new Error(
          `BranchManager refusing symlink traversal: target=${target} resolves to ${resolvedTarget} which is outside repo=${repoRoot}`,
        );
      }
    }
    if (patch.applied_content) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, patch.applied_content, "utf8");
      await this.git.add(target);
    } else {
      // Empty content: only add the specific target if it exists/changed.
      // Never fall through to `git add .` — that stages unrelated WIP files.
      await this.git.add(target);
    }
    const msg = `tune: ${proposal.subject} — alternative ${alternativeId}\nProposal-ID: ${proposal.id}`;
    const result = await this.git.commit(msg, { "--allow-empty": null });
    return result.commit;
  }

  async revertPatch(commitSha: string): Promise<void> {
    await this.git.revert(commitSha, ["--no-edit"]);
  }

  /**
   * Fast-forward-merge a proposal branch back into the base branch (master / main).
   *
   * Without this step, every \ commits to \ and leaves
   * the base branch stale — operators see pplied\ in the tuner but    * on master shows nothing. The branch itself is kept after merge so the
   * audit trail (one branch per proposal) survives.
   *
   * Best-effort: if the merge cannot fast-forward (base branch has diverged
   * between the proposal branch creation and now), we log and continue rather
   * than aborting the apply — the operator can resolve manually.
   */
  async mergeProposalBranchIntoBase(proposalId: number, baseBranch = 'main'): Promise<{ merged: boolean; reason?: string }> {
    const proposalBranch = this.branchName(proposalId);
    const branches = await this.git.branchLocal();
    const candidates = [baseBranch, 'master', 'main'];
    const resolved = candidates.find(b => branches.all.includes(b));
    if (!resolved) {
      return { merged: false, reason: `base branch not found (tried ${candidates.join(", ")})` };
    }
    if (!branches.all.includes(proposalBranch)) {
      return { merged: false, reason: `proposal branch ${proposalBranch} not found` };
    }
    try {
      await this.git.checkout(resolved);
      // --ff-only: fast-forward only. If the base branch advanced since the
      // proposal branched off, this fails and we surface that — never silently
      // resolve a divergent merge.
      await this.git.merge([proposalBranch, '--ff-only']);
      return { merged: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { merged: false, reason: msg.slice(0, 200) };
    }
  }

  async listProposalBranches(): Promise<string[]> {
    const branches = await this.git.branchLocal();
    return branches.all.filter((b) => b.startsWith("tune/proposal-"));
  }
}
