import { dirname, join } from "path";
import { unlink, readdir, rename, mkdir } from "fs/promises";
import { getAgentsDir } from "./config";

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SESSION_FILE = join(HEARTBEAT_DIR, "session.json");

export interface GlobalSession {
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
  compactWarned: boolean;
  messageCount?: number;
}

// Module-level cache is for the GLOBAL session only.
// Agent sessions bypass this cache — they read/write directly.
let current: GlobalSession | null = null;

/** Resolve the directory and session-file path for an optional agent. */
function sessionDirFor(agentName?: string): string {
  if (agentName) return join(getAgentsDir(), agentName);
  return HEARTBEAT_DIR;
}

function sessionPathFor(agentName?: string): string {
  if (agentName) return join(getAgentsDir(), agentName, "session.json");
  return SESSION_FILE;
}

/** Validate that a loaded session record has a usable `sessionId`. A
 *  truthy record with `sessionId: null` (or missing / non-string) is
 *  treated as no session — callers like `runner.ts` derive
 *  `isNew = !existing` and then unconditionally dereference
 *  `existing.sessionId.slice(...)`, so a partially-written record on
 *  disk would crash the daemon at first use. Seen in production
 *  2026-05-16: a heartbeat-path writer left
 *  `{ sessionId: null, createdAt: null, lastUsedAt: "...", turnCount: 0, ... }`
 *  in the global session.json, and the next Discord message crashed
 *  with "null is not an object (evaluating 'existing.sessionId.slice')".
 *  Until the writer is hardened (separate issue), the loader normalises
 *  any null/missing sessionId to "no session" so callers fall through
 *  to the fresh-session path instead of crashing. */
function _isUsableSession(record: unknown): record is GlobalSession {
  if (!record || typeof record !== "object") return false;
  const sid = (record as { sessionId?: unknown }).sessionId;
  return typeof sid === "string" && sid.length > 0;
}

async function loadSession(agentName?: string): Promise<GlobalSession | null> {
  // Agent sessions bypass the module-level cache (cache is global-only).
  if (agentName) {
    try {
      const raw = await Bun.file(sessionPathFor(agentName)).json();
      return _isUsableSession(raw) ? raw : null;
    } catch {
      return null;
    }
  }
  if (current) return current;
  try {
    const raw = await Bun.file(SESSION_FILE).json();
    if (!_isUsableSession(raw)) return null;
    current = raw;
    return current;
  } catch {
    return null;
  }
}

async function saveSession(session: GlobalSession, agentName?: string): Promise<void> {
  if (!agentName) current = session;
  await Bun.write(sessionPathFor(agentName), JSON.stringify(session, null, 2) + "\n");
}

/** Returns the existing session or null. Never creates one. */
export async function getSession(
  agentName?: string,
): Promise<{ sessionId: string; turnCount: number; compactWarned: boolean } | null> {
  const existing = await loadSession(agentName);
  if (existing) {
    // Backfill missing fields from older session.json files
    if (typeof existing.turnCount !== "number") existing.turnCount = 0;
    if (typeof existing.compactWarned !== "boolean") existing.compactWarned = false;
    existing.lastUsedAt = new Date().toISOString();
    await saveSession(existing, agentName);
    return {
      sessionId: existing.sessionId,
      turnCount: existing.turnCount,
      compactWarned: existing.compactWarned,
    };
  }
  return null;
}

/** Save a session ID obtained from Claude Code's output. */
export async function createSession(sessionId: string, agentName?: string): Promise<void> {
  await saveSession(
    {
      sessionId,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      turnCount: 0,
      compactWarned: false,
    },
    agentName,
  );
}

/** Returns session metadata without mutating lastUsedAt. */
export async function peekSession(agentName?: string): Promise<GlobalSession | null> {
  return await loadSession(agentName);
}

/** Increment the turn counter after a successful Claude invocation. */
export async function incrementTurn(agentName?: string): Promise<number> {
  const existing = await loadSession(agentName);
  if (!existing) return 0;
  if (typeof existing.turnCount !== "number") existing.turnCount = 0;
  existing.turnCount += 1;
  await saveSession(existing, agentName);
  return existing.turnCount;
}

/** Increment the message counter for rotation tracking. Call once per actual Claude invocation, not on reads. */
export async function incrementMessageCount(agentName?: string): Promise<void> {
  const existing = await loadSession(agentName);
  if (!existing) return;
  existing.messageCount = (existing.messageCount ?? 0) + 1;
  await saveSession(existing, agentName);
}

/** Mark that the compact warning has been sent for the current session. */
export async function markCompactWarned(agentName?: string): Promise<void> {
  const existing = await loadSession(agentName);
  if (!existing) return;
  existing.compactWarned = true;
  await saveSession(existing, agentName);
}

export async function resetSession(agentName?: string): Promise<void> {
  if (!agentName) current = null;
  try {
    await unlink(sessionPathFor(agentName));
  } catch {
    // already gone
  }
}

// --- Fallback session management ---
// Fallback sessions are stored alongside primary sessions but keyed separately.
// They persist across rate-limit events so the fallback provider accumulates context.

const FALLBACK_SESSION_FILE = join(HEARTBEAT_DIR, "session_fallback.json");

function fallbackSessionPathFor(agentName?: string, threadId?: string): string {
  if (threadId)
    return join(HEARTBEAT_DIR, "fallback-sessions", `${encodeURIComponent(threadId)}.json`);
  if (agentName) return join(getAgentsDir(), agentName, "session_fallback.json");
  return FALLBACK_SESSION_FILE;
}

async function loadFallbackSession(
  agentName?: string,
  threadId?: string,
): Promise<GlobalSession | null> {
  try {
    const raw = await Bun.file(fallbackSessionPathFor(agentName, threadId)).json();
    return _isUsableSession(raw) ? raw : null;
  } catch {
    return null;
  }
}

async function saveFallbackSession(
  session: GlobalSession,
  agentName?: string,
  threadId?: string,
): Promise<void> {
  const path = fallbackSessionPathFor(agentName, threadId);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(session, null, 2) + "\n");
}

export async function getFallbackSession(
  agentName?: string,
  threadId?: string,
): Promise<{ sessionId: string; turnCount: number } | null> {
  const existing = await loadFallbackSession(agentName, threadId);
  if (existing) {
    if (typeof existing.turnCount !== "number") existing.turnCount = 0;
    existing.lastUsedAt = new Date().toISOString();
    await saveFallbackSession(existing, agentName, threadId);
    return { sessionId: existing.sessionId, turnCount: existing.turnCount };
  }
  return null;
}

export async function createFallbackSession(
  sessionId: string,
  agentName?: string,
  threadId?: string,
): Promise<void> {
  await saveFallbackSession(
    {
      sessionId,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      turnCount: 0,
      compactWarned: false,
    },
    agentName,
    threadId,
  );
}

export async function incrementFallbackTurn(
  agentName?: string,
  threadId?: string,
): Promise<number> {
  const existing = await loadFallbackSession(agentName, threadId);
  if (!existing) return 0;
  if (typeof existing.turnCount !== "number") existing.turnCount = 0;
  existing.turnCount += 1;
  await saveFallbackSession(existing, agentName, threadId);
  return existing.turnCount;
}

export async function resetFallbackSession(agentName?: string, threadId?: string): Promise<void> {
  try {
    await unlink(fallbackSessionPathFor(agentName, threadId));
  } catch {
    // already gone
  }
}

export async function backupSession(agentName?: string): Promise<string | null> {
  const existing = await loadSession(agentName);
  if (!existing) return null;

  const dir = sessionDirFor(agentName);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    files = [];
  }
  const indices = files
    .filter((f) => /^session_\d+\.backup$/.test(f))
    .map((f) => Number(f.match(/^session_(\d+)\.backup$/)![1]));
  const nextIndex = indices.length > 0 ? Math.max(...indices) + 1 : 1;

  const backupName = `session_${nextIndex}.backup`;
  const backupPath = join(dir, backupName);
  await rename(sessionPathFor(agentName), backupPath);
  if (!agentName) current = null;

  return backupName;
}
