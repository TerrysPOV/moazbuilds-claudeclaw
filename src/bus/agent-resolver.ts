/**
 * Resolve `settings.agents` entries into spawnable `AgentConfig`s
 * (Sprint 5.2a).
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.3 + §10
 * Sprint 5.2.
 *
 * Each `BusAgentSettings` entry from settings.json is operator-facing
 * (terse, mostly-optional). `AgentConfig` is the SessionManager-facing
 * shape — every field defaulted/derived. The two live as separate types
 * by design: settings.json stays stable even as `AgentConfig` grows.
 *
 * The big responsibility here is **session_id persistence**. Each agent
 * gets a UUID that's stable across daemon restarts; without that,
 * `claude --session-id <uuid>` can't resume the JSONL transcript and
 * every restart loses conversation context. We reuse the existing
 * `agents/<id>/session.json` storage layer (`src/sessions.ts`) so the
 * Bus runtime and legacy PTY runtime share session state — operators
 * can flip `runtime` between modes without losing history.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BusAgentSettings } from "../config";
import { getAgentsDir } from "../config";
import { createSession, getSession } from "../sessions";
import type { AgentConfig, SupervisionMode } from "./types";

export interface ResolveAgentOptions {
  /**
   * Working directory to use when the agent didn't specify one. Defaults
   * to `process.cwd()` at call time.
   */
  defaultCwd?: string;
  /**
   * Test seam: when set, replaces the session_id resolver entirely. Lets
   * tests bypass the on-disk `agents/<id>/session.json` round-trip and
   * inject a deterministic UUID.
   */
  resolveSessionId?: (agentId: string) => Promise<string>;
}

/**
 * Resolve one settings entry into a spawnable `AgentConfig`.
 *
 * Defaults applied:
 *   - `cwd` ← `opts.defaultCwd ?? process.cwd()`
 *   - `permission_mode` ← `"plan"`
 *   - `session_id` ← existing `agents/<id>/session.json` value, else
 *     a fresh UUID persisted on first call.
 *   - `supervision` ← undefined (SessionManager will pick via
 *     `defaultSupervisionFor`).
 */
export async function resolveBusAgentConfig(
  entry: BusAgentSettings,
  opts: ResolveAgentOptions = {},
): Promise<AgentConfig> {
  const cwd = entry.cwd ?? opts.defaultCwd ?? process.cwd();
  const session_id = await (opts.resolveSessionId ?? defaultResolveSessionId)(entry.id);

  const config: AgentConfig = {
    id: entry.id,
    cwd,
    session_id,
    permission_mode: entry.permission_mode ?? "plan",
  };
  if (entry.system_prompt_file) config.system_prompt_file = entry.system_prompt_file;
  if (entry.memory_file) config.memory_file = entry.memory_file;
  if (entry.mcp_config) config.mcp_config = entry.mcp_config;
  if (entry.supervision) config.supervision = entry.supervision as SupervisionMode;
  return config;
}

/**
 * Resolve all agent entries in parallel. Failure of one resolution does
 * NOT abort the others — failures are surfaced as `null` slots so the
 * caller can decide whether to spawn the remaining agents or refuse.
 *
 * Bus runtime's `mountBusRuntime` treats any null as a fatal error and
 * rolls back the mount, but tests can pick a different policy.
 */
export async function resolveBusAgentConfigs(
  entries: readonly BusAgentSettings[],
  opts: ResolveAgentOptions = {},
): Promise<Array<{ entry: BusAgentSettings; config: AgentConfig | null; error?: unknown }>> {
  return Promise.all(
    entries.map(async (entry) => {
      try {
        const config = await resolveBusAgentConfig(entry, opts);
        return { entry, config };
      } catch (error) {
        return { entry, config: null, error };
      }
    }),
  );
}

/**
 * Read the agent's session.json; create a fresh UUID + persist if absent.
 *
 * Note on storage layer reuse: `agents/<id>/session.json` is shared with
 * the legacy `runtime: "pty"` agent-session store (`src/sessions.ts`).
 * Operators flipping between runtimes keep their conversation history
 * across the switch. The directory is also where the daemon writes other
 * per-agent state (memory snapshots, JSONL pointers), so the Bus
 * runtime's auto-spawn naturally lands in the right place.
 */
async function defaultResolveSessionId(agentId: string): Promise<string> {
  const existing = await getSession(agentId);
  if (existing?.sessionId) return existing.sessionId;
  const fresh = randomUUID();
  await createSession(fresh, agentId);
  return fresh;
}

/** Diagnostic-only: where does this agent's session.json live? */
export function agentSessionPath(agentId: string): string {
  return join(getAgentsDir(), agentId, "session.json");
}
