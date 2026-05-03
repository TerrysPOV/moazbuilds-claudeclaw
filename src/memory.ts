/**
 * Memory Persistence
 *
 * Loads and manages MEMORY.md files for the main session and agent sessions.
 * Memory is injected into --append-system-prompt on every invocation.
 */

import { join } from "path";
import { existsSync } from "fs";
import { spawnSync } from "child_process";
import { readFile, writeFile, mkdir } from "fs/promises";

const PROJECT_DIR = process.cwd();
const CLAUDECLAW_DIR = join(PROJECT_DIR, ".claude", "claudeclaw");
// MEMORY.md lives in project root (NOT .claude/) because Claude Code
// blocks writes to .claude/ directories even with --dangerously-skip-permissions
const MEMORY_FILE = join(PROJECT_DIR, "MEMORY.md");
const AGENTS_DIR = join(CLAUDECLAW_DIR, "agents");

const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");
const MEMORY_INSTRUCTIONS_FILE = join(PROMPTS_DIR, "MEMORY_INSTRUCTIONS.md");

const MEMORY_TEMPLATE = [
  "# Memory",
  "",
  "## Current Status",
  "- No tasks in progress",
  "",
  "## Key Decisions",
  "- None yet",
  "",
  "## Session Log",
  "- Session started",
  "",
].join("\n");

// Agent memory also lives outside .claude/ for the same write permission reason
const AGENTS_MEMORY_DIR = join(PROJECT_DIR, "agents");

export function getMemoryPath(agentName?: string): string {
  if (agentName) {
    return join(AGENTS_MEMORY_DIR, agentName, "MEMORY.md");
  }
  return MEMORY_FILE;
}

export async function ensureMemoryFile(agentName?: string): Promise<void> {
  const memPath = getMemoryPath(agentName);
  const dir = join(memPath, "..");
  await mkdir(dir, { recursive: true });
  if (!existsSync(memPath)) {
    await writeFile(memPath, MEMORY_TEMPLATE, "utf8");
  }
}

export async function loadMemory(agentName?: string): Promise<string> {
  const memPath = getMemoryPath(agentName);
  try {
    if (!existsSync(memPath)) return "";
    const content = await readFile(memPath, "utf8");
    return content.trim();
  } catch {
    return "";
  }
}

export async function loadMemoryInstructions(agentName?: string): Promise<string> {
  try {
    if (!existsSync(MEMORY_INSTRUCTIONS_FILE)) return "";
    const content = await readFile(MEMORY_INSTRUCTIONS_FILE, "utf8");
    if (!content.trim()) return "";
    return content.trim().replace(/<MEMORY_PATH>/g, getMemoryPath(agentName));
  } catch {
    return "";
  }
}
// ---------------------------------------------------------------------------
// Session-history search (added 2026-05-03 for issue #19)
//
// Wraps the Python `tools/memory-search/` indexer + searcher. We keep the
// heavy lifting (SQLite + FTS5 + sentence-transformer embeddings) in Python
// where the libraries are mature, and expose deterministic read/write entry
// points to the rest of the daemon from here.
//
// Determinism notes:
//   - No in-process cache: every searchSessions() call shells out to a
//     fresh Python subprocess that reads from the on-disk SQLite database.
//     If you write a memory or index a new session, the very next read
//     reflects it.
//   - indexSessions() is idempotent (the Python indexer skips files whose
//     mtime has not changed) so calling it on every boot is cheap.
// ---------------------------------------------------------------------------

const MEMORY_SEARCH_DIR = join(import.meta.dir, "..", "tools", "memory-search");
const MEMORY_SEARCH_BIN = join(MEMORY_SEARCH_DIR, ".venv", "bin", "memory-search");

export interface MemorySearchSettings {
  /** Disable the whole subsystem at runtime. Default: true. */
  enabled?: boolean;
  /** Path to the `memory-search` CLI. Falls back to project venv then PATH. */
  binPath?: string;
  /** Path to the SQLite DB. Falls back to ~/.claude/claudeclaw/memory-search.db. */
  dbPath?: string;
  /** Colon-separated session JSONL directories. Falls back to all of ~/.claude/projects/*. */
  sessionsDir?: string;
  /** sentence-transformer model name. Default: all-MiniLM-L6-v2. */
  model?: string;
  /** Hybrid blend, 1.0=semantic only, 0.0=FTS5 only. Default: 0.5. */
  alpha?: number;
  /** Re-index after every N runner turns. Default: 10. 0 disables. */
  reindexEveryNTurns?: number;
  /** Max seconds a search subprocess is allowed to run. Default: 60. */
  searchTimeoutSec?: number;
  /** Max seconds an index subprocess is allowed to run. Default: 600. */
  indexTimeoutSec?: number;
}

export interface SessionSearchHit {
  score: number;
  session_id: string;
  timestamp: string;
  turn_count: number;
  excerpt: string;
}

export interface SessionSearchResult {
  query: string;
  hits: SessionSearchHit[];
  summary: string | null;
}

export interface IndexResult {
  found: number;
  indexed: number;
  skipped: number;
}

function resolveBin(opts?: MemorySearchSettings): string {
  if (opts?.binPath) return opts.binPath;
  if (existsSync(MEMORY_SEARCH_BIN)) return MEMORY_SEARCH_BIN;
  return "memory-search"; // rely on PATH
}

function buildEnv(opts?: MemorySearchSettings): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (opts?.dbPath) env.MEMORY_SEARCH_DB = opts.dbPath;
  if (opts?.sessionsDir) env.MEMORY_SEARCH_SESSIONS_DIR = opts.sessionsDir;
  if (opts?.model) env.MEMORY_SEARCH_MODEL = opts.model;
  return env;
}

/**
 * Re-index every configured session JSONL into the search DB.
 * Idempotent — skips files whose mtime is unchanged.
 *
 * Returns counts. Throws on subprocess failure (caller decides whether
 * a failed boot-time index should be fatal).
 */
export function indexSessions(opts?: MemorySearchSettings): IndexResult {
  if (opts?.enabled === false) {
    return { found: 0, indexed: 0, skipped: 0 };
  }
  const result = spawnSync(resolveBin(opts), ["index"], {
    env: buildEnv(opts),
    encoding: "utf8",
    timeout: (opts?.indexTimeoutSec ?? 600) * 1000,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(`memory-search index failed (exit ${result.status}): ${stderr}`);
  }

  // Parse the human-readable output: "📂 found: N  ✅ indexed: N  ⏭️  skipped: N"
  const stdout = result.stdout || "";
  const found = parseInt(stdout.match(/found:\s*(\d+)/)?.[1] ?? "0", 10);
  const indexed = parseInt(stdout.match(/indexed:\s*(\d+)/)?.[1] ?? "0", 10);
  const skipped = parseInt(stdout.match(/skipped[^:]*:\s*(\d+)/)?.[1] ?? "0", 10);
  return { found, indexed, skipped };
}

/**
 * Search past sessions for a query.
 * Always reads the on-disk DB fresh (no cache), so writes from a concurrent
 * indexSessions() are visible immediately.
 *
 * @param query  free-text query
 * @param topK   max distinct sessions to return (default 5)
 * @param withSummary  if true, the Python CLI also runs `claude --print` to
 *                     summarize the hits (default false from this entry point —
 *                     callers like skills can opt in). Costs ~1-3s extra.
 */
export function searchSessions(
  query: string,
  opts?: MemorySearchSettings & { topK?: number; withSummary?: boolean }
): SessionSearchResult {
  if (opts?.enabled === false) {
    return { query, hits: [], summary: null };
  }
  const args = [
    "recall",
    query,
    "--top",
    String(opts?.topK ?? 5),
    "--json",
  ];
  if (opts?.alpha !== undefined) {
    args.push("--alpha", String(opts.alpha));
  }
  if (!opts?.withSummary) {
    args.push("--no-summary");
  }

  const result = spawnSync(resolveBin(opts), args, {
    env: buildEnv(opts),
    encoding: "utf8",
    timeout: (opts?.searchTimeoutSec ?? 60) * 1000,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // exit code 1 just means "no hits" (caller can still parse JSON for empty array)
  if (result.status !== 0 && result.status !== 1) {
    const stderr = (result.stderr || "").trim();
    throw new Error(`memory-search recall failed (exit ${result.status}): ${stderr}`);
  }

  const stdout = (result.stdout || "").trim();
  if (!stdout) return { query, hits: [], summary: null };

  try {
    return JSON.parse(stdout) as SessionSearchResult;
  } catch (e) {
    throw new Error(`memory-search returned invalid JSON: ${(e as Error).message}`);
  }
}
