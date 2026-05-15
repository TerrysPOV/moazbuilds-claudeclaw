import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface RefusedRecord {
  pattern_signature: string;
  subject: string;
  user_reason: string;
  ts: string;
  expires_at: string;
}

export const DEFAULT_REFUSED_PATH = join(homedir(), ".config", "tuner", "refused.jsonl");

export class RefusedStore {
  constructor(
    public readonly path: string,
    public ttlDays = 30,
  ) {}

  add(signature: string, subject: string, userReason = "skip"): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlDays * 86_400_000);
    const record: RefusedRecord = {
      pattern_signature: signature,
      subject,
      user_reason: userReason,
      ts: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    };
    appendFileSync(this.path, JSON.stringify(record) + "\n");
  }

  activeSignatures(): Set<string> {
    const now = Date.now();
    const sigs = new Set<string>();
    for (const r of this._readRecords()) {
      try {
        if (new Date(r.expires_at).getTime() > now) {
          sigs.add(r.pattern_signature);
        }
      } catch {
        // skip
      }
    }
    return sigs;
  }

  isRefused(sig: string): boolean {
    return this.activeSignatures().has(sig);
  }

  private _readRecords(): RefusedRecord[] {
    if (!existsSync(this.path)) return [];
    const records: RefusedRecord[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      const l = line.trim();
      if (!l) continue;
      try {
        records.push(JSON.parse(l) as RefusedRecord);
      } catch {
        // skip corrupt
      }
    }
    return records;
  }
}
