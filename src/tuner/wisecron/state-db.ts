import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import type { RevisionRecord, ScheduleState, AppliedBy } from './types.js';
import type { Patch } from '../../skills-tuner/core/types.js';

interface SubjectStateRow {
  subject: string;
  last_run: string;
  next_run: string;
  current_interval_hours: number;
  consecutive_zero_runs: number;
  last_proposal_count: number;
  enabled: number;
}

interface RollbackRow {
  id: number;
  proposal_id: string;
  subject: string;
  applied_at: string;
  forward_patch_json: string;
  inverse_patch_json: string;
  applied_by: string;
  rolled_back_at: string | null;
}

function rowToScheduleState(row: SubjectStateRow): ScheduleState {
  return {
    subject: row.subject,
    last_run: new Date(row.last_run),
    next_run: new Date(row.next_run),
    current_interval_hours: row.current_interval_hours,
    consecutive_zero_runs: row.consecutive_zero_runs,
    last_proposal_count: row.last_proposal_count,
    enabled: row.enabled === 1,
  };
}

function rowToRevisionRecord(row: RollbackRow): RevisionRecord {
  return {
    id: row.id,
    proposal_id: row.proposal_id,
    subject: row.subject,
    applied_at: new Date(row.applied_at),
    forward_patch: JSON.parse(row.forward_patch_json),
    inverse_patch: JSON.parse(row.inverse_patch_json),
    applied_by: row.applied_by as AppliedBy,
    rolled_back_at: row.rolled_back_at ? new Date(row.rolled_back_at) : null,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subject_state (
  subject TEXT PRIMARY KEY,
  last_run TEXT NOT NULL,
  next_run TEXT NOT NULL,
  current_interval_hours INTEGER NOT NULL,
  consecutive_zero_runs INTEGER NOT NULL DEFAULT 0,
  last_proposal_count INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS rollback_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  forward_patch_json TEXT NOT NULL,
  inverse_patch_json TEXT NOT NULL,
  applied_by TEXT NOT NULL,
  rolled_back_at TEXT
);

CREATE TABLE IF NOT EXISTS telemetry_cache (
  subject TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (subject, observation_id)
);

CREATE INDEX IF NOT EXISTS idx_rollback_subject ON rollback_history(subject, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_collected ON telemetry_cache(subject, collected_at DESC);
`;

export class WisecronStateDB {
  private db: Database;
  private readonly path: string;

  constructor(dbPath: string) {
    this.path = dbPath.replace(/^~/, homedir());
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ── subject_state ─────────────────────────────────────────────────────────

  upsertScheduleState(state: ScheduleState): void {
    this.db.prepare(`
      INSERT INTO subject_state(
        subject, last_run, next_run, current_interval_hours,
        consecutive_zero_runs, last_proposal_count, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject) DO UPDATE SET
        last_run = excluded.last_run,
        next_run = excluded.next_run,
        current_interval_hours = excluded.current_interval_hours,
        consecutive_zero_runs = excluded.consecutive_zero_runs,
        last_proposal_count = excluded.last_proposal_count,
        enabled = excluded.enabled
    `).run(
      state.subject,
      state.last_run.toISOString(),
      state.next_run.toISOString(),
      state.current_interval_hours,
      state.consecutive_zero_runs,
      state.last_proposal_count,
      state.enabled ? 1 : 0,
    );
  }

  getScheduleState(subject: string): ScheduleState | null {
    const row = this.db.prepare('SELECT * FROM subject_state WHERE subject = ?').get(subject) as SubjectStateRow | undefined;
    return row ? rowToScheduleState(row) : null;
  }

  listScheduleStates(): ScheduleState[] {
    const rows = this.db.prepare('SELECT * FROM subject_state ORDER BY next_run ASC').all() as SubjectStateRow[];
    return rows.map(rowToScheduleState);
  }

  setEnabled(subject: string, enabled: boolean): void {
    this.db.prepare('UPDATE subject_state SET enabled = ? WHERE subject = ?').run(enabled ? 1 : 0, subject);
  }

  // ── rollback_history ──────────────────────────────────────────────────────

  recordApply(record: {
    proposal_id: string;
    subject: string;
    forward_patch: Patch;
    inverse_patch: Patch;
    applied_by: AppliedBy;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO rollback_history(
        proposal_id, subject, applied_at,
        forward_patch_json, inverse_patch_json, applied_by
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      record.proposal_id,
      record.subject,
      new Date().toISOString(),
      JSON.stringify(record.forward_patch),
      JSON.stringify(record.inverse_patch),
      record.applied_by,
    );
    return Number(result.lastInsertRowid);
  }

  markRolledBack(revisionId: number): void {
    this.db.prepare('UPDATE rollback_history SET rolled_back_at = ? WHERE id = ?')
      .run(new Date().toISOString(), revisionId);
  }

  getRevision(revisionId: number): RevisionRecord | null {
    const row = this.db.prepare('SELECT * FROM rollback_history WHERE id = ?').get(revisionId) as RollbackRow | undefined;
    return row ? rowToRevisionRecord(row) : null;
  }

  listRevisionsBySubject(subject: string, limit = 50): RevisionRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM rollback_history WHERE subject = ? ORDER BY applied_at DESC LIMIT ?'
    ).all(subject, limit) as RollbackRow[];
    return rows.map(rowToRevisionRecord);
  }

  purgeExpiredRevisions(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const result = this.db.prepare(
      'DELETE FROM rollback_history WHERE applied_at < ?'
    ).run(cutoff);
    return Number(result.changes);
  }

  // ── telemetry_cache ───────────────────────────────────────────────────────

  cacheTelemetry(subject: string, observationId: string, data: unknown): void {
    this.db.prepare(`
      INSERT INTO telemetry_cache(subject, observation_id, collected_at, data_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(subject, observation_id) DO UPDATE SET
        collected_at = excluded.collected_at,
        data_json = excluded.data_json
    `).run(subject, observationId, new Date().toISOString(), JSON.stringify(data));
  }

  recentTelemetry(subject: string, sinceIso: string): Array<{ observation_id: string; data: unknown }> {
    const rows = this.db.prepare(`
      SELECT observation_id, data_json FROM telemetry_cache
      WHERE subject = ? AND collected_at >= ?
      ORDER BY collected_at DESC
    `).all(subject, sinceIso) as Array<{ observation_id: string; data_json: string }>;
    return rows.map(r => ({ observation_id: r.observation_id, data: JSON.parse(r.data_json) }));
  }

  // ── lifecycle / migration ────────────────────────────────────────────────

  static fileExists(dbPath: string): boolean {
    return existsSync(dbPath.replace(/^~/, homedir()));
  }

  /**
   * On corruption detected at open time, backup + recreate fresh schema.
   * Reset subject_state to defaults; rollback_history is lost (acceptable —
   * archived audit log on disk has the trace).
   *
   * **Best-effort contract.** This call closes the bad connection, renames
   * the corrupt file to `*.corrupt-<ISO>`, and opens a fresh DB. Both
   * `subject_state` and `rollback_history` are reset; the only durable trace
   * of pre-corruption applies is the appended audit log on disk. Operators
   * who need rollback history that survives a corruption event should back
   * up `~/.config/tuner/wisecron.db` periodically (e.g. via a daily cron
   * snapshot to a side directory).
   */
  recover(): void {
    try { this.db.close(); } catch { /* ignore */ }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${this.path}.corrupt-${ts}`;
    try { renameSync(this.path, backup); } catch { /* ignore if missing */ }
    this.db = new Database(this.path);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec(SCHEMA);
  }
}
