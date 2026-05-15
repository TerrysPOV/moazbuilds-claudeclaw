import { join } from "node:path";
import { existsSync } from "node:fs";
import { unlink, rename } from "node:fs/promises";

const PENDING_RESUME_PATH = join(process.cwd(), ".claude", "claudeclaw", "pending-resume.json");
// Consumed path: renamed before running so a crash mid-wake-up doesn't re-fire on next start
const PENDING_RESUME_CONSUMED = PENDING_RESUME_PATH + ".consumed";

let consumed = false;

export interface PendingResume {
  /** Which transport should deliver the wake-up reply. */
  transport: "discord" | "telegram";
  /** Destination channel ID (Discord snowflake, Telegram chat ID as string). */
  channelId: string;
  /** Optional thread context — Discord thread ID. */
  threadId?: string;
  /**
   * sessions.json key for the session to resume (e.g. Discord channel/thread snowflake).
   * Omit to resume the global session.
   */
  sessionKey?: string;
  /** Agent working-directory name, if the session is agent-scoped. */
  agentName?: string;
  /**
   * The prompt injected into the resumed session.  Should explain that a restart just occurred
   * and instruct the agent to verify the outcome and reply to the user.
   */
  wakeUpPrompt: string;
  /**
   * Expiry as Unix milliseconds.  Files older than this are silently discarded to avoid
   * stale confirmations firing hours later after an unexpected crash.
   */
  expires?: number;
}

/**
 * Atomically consume pending-resume.json for the given transport and return its contents,
 * or null if absent/expired/wrong-transport.
 *
 * The transport check happens before the file is renamed so that the wrong-transport caller
 * does not silently destroy a file intended for a different transport handler.
 *
 * The file is renamed before the wake-up runs.  If the wake-up throws, the file is already
 * gone so a subsequent restart does not fire a second time (prefer lost message over duplicate).
 */
export async function loadPendingResume(expectedTransport: string): Promise<PendingResume | null> {
  if (consumed) return null;

  if (!existsSync(PENDING_RESUME_PATH)) return null;

  // Peek at the file to check transport before consuming it
  let resume: PendingResume;
  try {
    resume = (await Bun.file(PENDING_RESUME_PATH).json()) as PendingResume;
  } catch (err) {
    console.warn(`[pending-resume] Parse failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }

  if (resume.transport !== expectedTransport) return null;

  // Transport matches — mark consumed and atomically rename before executing
  consumed = true;
  try {
    await rename(PENDING_RESUME_PATH, PENDING_RESUME_CONSUMED);
  } catch {
    return null;
  }

  await unlink(PENDING_RESUME_CONSUMED).catch(() => {});

  if (resume.expires && Date.now() > resume.expires) {
    console.log("[pending-resume] Expired, discarding.");
    return null;
  }

  if (!resume.wakeUpPrompt || !resume.transport || !resume.channelId) {
    console.warn(
      "[pending-resume] Missing required fields (transport, channelId, wakeUpPrompt), discarding.",
    );
    return null;
  }

  return resume;
}
