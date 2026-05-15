#!/usr/bin/env bun
/**
 * migrate-from-python.ts
 *
 * One-shot migration: converts legacy Python flat-record proposals.jsonl
 * into the TypeScript wrapped-event format.
 *
 * Usage:
 *   bun run scripts/migrate-from-python.ts [--dry-run]
 *
 * Exports migrateRecord() for unit tests.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

import { loadSecret, computeProposalSignature } from "../core/security.js";
import type { ProposalRecord } from "../storage/proposals.js";
import type { Proposal } from "../core/types.js";

export const DEFAULT_PROPOSALS_PATH = join(homedir(), ".config", "tuner", "proposals.jsonl");

// Fields that exist only in the Python format and must be stripped
const LEGACY_FIELDS = new Set([
  "status",
  "applied_at",
  "applied_alternative",
  "feedback",
  "feedback_at",
  "git_branch",
  "git_commit",
  "git_merged",
  // Extra Python fields not in UnsignedProposalSchema
  "recommended",
  "confidence",
  "justification",
  "subjects_touched",
  "sentiment_evidence",
  "estimated_impact",
  // Stale empty signature — will be re-computed
  "signature",
]);

/**
 * Strip legacy-only keys from a flat Python record, leaving only the fields
 * that map to UnsignedProposalSchema (plus any extra TS-safe fields).
 */
function stripLegacyFields(raw: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!LEGACY_FIELDS.has(k)) cleaned[k] = v;
  }
  return cleaned;
}

/**
 * Convert a single raw JSON-parsed line into zero or more ProposalRecord events.
 *
 * Rules:
 *  - Meta lines (_meta: true)         → returned as-is (pass-through)
 *  - Already-wrapped (has `event`)    → returned as-is (idempotent)
 *  - Legacy flat (has `status`)       → emit created + applied/refused as needed
 */
export function migrateRecord(
  raw: unknown,
  secret: Buffer,
): { events: ProposalRecord[]; meta?: unknown } {
  if (typeof raw !== "object" || raw === null) return { events: [] };
  const obj = raw as Record<string, unknown>;

  // Pass-through: meta line
  if (obj._meta === true) return { events: [], meta: obj };

  // Pass-through: already wrapped TS format
  if (typeof obj.event === "string") {
    return { events: [obj as unknown as ProposalRecord] };
  }

  // Legacy flat Python record — must have 'status'
  if (typeof obj.status !== "string") {
    // Unknown format — skip with warning
    process.stderr.write(
      `WARN: skipping unrecognized line (no event, no status): ${JSON.stringify(obj).slice(0, 80)}\n`,
    );
    return { events: [] };
  }

  // Build UnsignedProposal by stripping legacy-only fields
  const unsignedObj = stripLegacyFields(obj);

  // Coerce created_at to Date for signing then back to string for serialisation
  const createdAt: Date =
    typeof unsignedObj.created_at === "string"
      ? new Date(unsignedObj.created_at as string)
      : new Date();

  // Ensure alternatives have tradeoff field (default '')
  const alternatives =
    (unsignedObj.alternatives as Array<Record<string, unknown>> | undefined) ?? [];
  const normalizedAlts = alternatives.map((a) => ({
    id: a.id ?? "",
    label: a.label ?? "",
    diff_or_content: a.diff_or_content ?? "",
    tradeoff: a.tradeoff ?? "",
  }));

  const unsignedProposal = {
    ...unsignedObj,
    alternatives: normalizedAlts,
    created_at: createdAt,
  };

  // Compute fresh HMAC signature
  const signature = computeProposalSignature(
    unsignedProposal as Parameters<typeof computeProposalSignature>[0],
    secret,
  );

  const proposal: Proposal = {
    ...(unsignedProposal as Omit<Proposal, "signature">),
    signature,
  };

  const events: ProposalRecord[] = [];
  const createdTs = createdAt.toISOString();

  // Always emit a 'created' event
  events.push({ event: "created", ts: createdTs, proposal });

  const status = obj.status as string;

  if (status === "applied" || status === "reverted") {
    const appliedTs =
      typeof obj.applied_at === "string"
        ? new Date(obj.applied_at as string).toISOString()
        : createdTs;
    const alternativeId =
      typeof obj.applied_alternative === "string" ? (obj.applied_alternative as string) : "A";
    events.push({
      event: "applied",
      ts: appliedTs,
      proposal,
      alternative_id: alternativeId,
    });
  }

  if (status === "refused" || status === "skipped" || status === "reverted") {
    const refusedTs =
      typeof obj.feedback_at === "string"
        ? new Date(obj.feedback_at as string).toISOString()
        : typeof obj.applied_at === "string"
          ? new Date(obj.applied_at as string).toISOString()
          : createdTs;
    events.push({ event: "refused", ts: refusedTs, proposal });
  }

  return { events };
}

// ── Main entrypoint ────────────────────────────────────────────────────────────

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  const proposalsPath = DEFAULT_PROPOSALS_PATH;

  if (!existsSync(proposalsPath)) {
    console.log(`No proposals.jsonl found at ${proposalsPath} — nothing to migrate.`);
    process.exit(0);
  }

  const raw = readFileSync(proposalsPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    console.log("proposals.jsonl is empty — nothing to migrate.");
    process.exit(0);
  }

  // Check if all lines are already in TS format (has 'event' field or is meta)
  const needsMigration = lines.some((l) => {
    try {
      const obj = JSON.parse(l) as Record<string, unknown>;
      return !obj._meta && typeof obj.event !== "string";
    } catch {
      return false;
    }
  });

  if (!needsMigration) {
    console.log("proposals.jsonl is already in TS format — no migration needed.");
    process.exit(0);
  }

  const secret = loadSecret();
  const outputLines: string[] = [];
  let legacyCount = 0;
  let createdCount = 0;
  let appliedCount = 0;
  let refusedCount = 0;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stderr.write(`WARN: skipping invalid JSON line: ${line.slice(0, 80)}\n`);
      continue;
    }

    const obj = parsed as Record<string, unknown>;

    // Meta line — copy as-is
    if (obj._meta === true) {
      outputLines.push(JSON.stringify(obj));
      continue;
    }

    // Already wrapped — copy as-is
    if (typeof obj.event === "string") {
      outputLines.push(line.trim());
      continue;
    }

    // Legacy flat record
    legacyCount++;
    const { events } = migrateRecord(parsed, secret);
    for (const ev of events) {
      outputLines.push(JSON.stringify(ev));
      if (ev.event === "created") createdCount++;
      else if (ev.event === "applied") appliedCount++;
      else if (ev.event === "refused") refusedCount++;
    }
  }

  const summary = `Migrated ${legacyCount} legacy records -> ${outputLines.length} lines (${createdCount} created, ${appliedCount} applied, ${refusedCount} refused)`;

  if (dryRun) {
    console.log(`[DRY RUN] ${summary}`);
    console.log("First 5 output lines:");
    for (const l of outputLines.slice(0, 5)) console.log(" ", l.slice(0, 120));
    process.exit(0);
  }

  // Backup original
  const backupTs = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${proposalsPath}.python-backup-${backupTs}`;
  copyFileSync(proposalsPath, backupPath);
  console.log(`Backup created: ${backupPath}`);

  // Write migrated output
  mkdirSync(dirname(proposalsPath), { recursive: true });
  writeFileSync(proposalsPath, outputLines.join("\n") + "\n");

  console.log(summary);
  console.log(`Written to: ${proposalsPath}`);
}
