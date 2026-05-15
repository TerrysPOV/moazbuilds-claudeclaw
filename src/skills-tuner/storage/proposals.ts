import { existsSync, mkdirSync, readFileSync, appendFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Proposal } from "../core/types.js";

export interface ProposalRecord {
  proposal: Proposal;
  event: "created" | "applied" | "refused";
  ts: string;
  alternative_id?: string;
  commit_sha?: string;
  applied_target_path?: string; // actual path written (may differ from proposal.target_path for new_skill kind)
}

export const DEFAULT_PROPOSALS_PATH = join(homedir(), ".config", "tuner", "proposals.jsonl");

export class ProposalsStore {
  constructor(public readonly path: string) {}

  append(record: ProposalRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(record) + "\n");
  }

  readAll(): ProposalRecord[] {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, "utf8");
    const records: ProposalRecord[] = [];
    for (const line of raw.split("\n")) {
      const l = line.trim();
      if (!l) continue;
      try {
        const data = JSON.parse(l) as ProposalRecord;
        if (data.proposal?.created_at) {
          data.proposal.created_at = new Date(data.proposal.created_at as unknown as string);
        }
        records.push(data);
      } catch {
        // skip corrupt lines
      }
    }
    return records;
  }

  pendingSignatures(opts?: { subject?: string }): Set<string> {
    const all = this.readAll();
    const resolved = new Set(
      all
        .filter((r) => r.event === "applied" || r.event === "refused")
        .map((r) => r.proposal.pattern_signature),
    );
    const result = new Set<string>();
    for (const r of all) {
      if (r.event !== "created") continue;
      if (opts?.subject && r.proposal.subject !== opts.subject) continue;
      const sig = r.proposal.pattern_signature;
      if (!resolved.has(sig)) result.add(sig);
    }
    return result;
  }

  appliedSignatures(opts?: { withinDays?: number }): Set<string> {
    const withinDays = opts?.withinDays ?? 7;
    const cutoff = new Date(Date.now() - withinDays * 86_400_000);
    const sigs = new Set<string>();
    for (const r of this.readAll()) {
      if (r.event !== "applied") continue;
      const ts = new Date(r.ts);
      if (ts < cutoff) continue;
      const sig = r.proposal.pattern_signature;
      // Prefer the actual applied path (relevant for new_skill kind where proposal.target_path is a placeholder)
      const targetRaw = r.applied_target_path ?? r.proposal.target_path;
      const target = targetRaw.replace(/^~/, homedir());
      if (sig) {
        if (existsSync(target)) {
          const mtime = new Date(statSync(target).mtimeMs);
          if (mtime > ts) continue; // skill changed since applied — bypass cooldown
        }
        sigs.add(sig);
      }
    }
    return sigs;
  }

  signatureRefused(sig: string, refusedSigs: Set<string>): boolean {
    return refusedSigs.has(sig);
  }
}
