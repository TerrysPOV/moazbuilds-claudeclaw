/**
 * Trust-prompt self-heal for claude 2.1.89+ (issue #81 failure mode #1).
 *
 * Claude shows an interactive trust prompt the first time it's invoked in a
 * given cwd:
 *
 *     Quick safety check: Is this a project you created or one you trust?
 *      > 1. Yes, I trust this folder
 *        2. No, exit
 *
 * The bun-pty spawn doesn't answer this prompt, so claude blocks forever and
 * the supervisor times out with an empty response. The "trust ack" state
 * lives in `~/.claude.json` under `projects["<absolute-cwd>"].
 * hasTrustDialogAccepted: true`.
 *
 * `ensureTrustAccepted(cwd, homedir)` writes that flag idempotently. Safe to
 * call repeatedly: a no-op when the project entry already has the flag set
 * to `true`. Mirrors the patch the operator applied manually during
 * diagnosis.
 *
 * Failures (filesystem errors, malformed JSON, etc.) are NOT thrown — they
 * are returned as `{ ok: false, reason }` so the supervisor can log them
 * without breaking PTY startup. A failing self-heal still lets the runtime
 * try (it just means the trust prompt may stall the first invocation).
 */
import { existsSync } from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import { resolve as resolvePath } from "node:path";

export interface TrustHealResult {
  ok: boolean;
  changed: boolean;
  configPath: string;
  reason?: string;
}

/** Default project-entry shape claude 2.1.89 writes when accepting trust. */
function defaultProjectEntry(): Record<string, unknown> {
  return {
    hasTrustDialogAccepted: true,
    mcpServers: {},
    allowedTools: [],
    mcpContextUris: [],
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    projectOnboardingSeenCount: 1,
    exampleFiles: [],
  };
}

/**
 * Ensure `~/.claude.json` has `projects[<absoluteCwd>].hasTrustDialogAccepted
 * = true`. Creates the file and the `projects` map if absent. Atomic write
 * (temp file + rename) to avoid partial writes.
 *
 * Idempotent: if the flag is already true, returns `{ ok: true, changed:
 * false }`.
 */
/**
 * Per-config-path serialisation queue. Multiple `ensureTrustAccepted`
 * calls for different cwds against the SAME `~/.claude.json` would race
 * the read-modify-write pattern below — concurrent PTY spawns for
 * different session keys can run in parallel, and last-writer-wins
 * silently drops one cwd's trust flag, re-triggering the interactive
 * trust prompt stall the self-heal exists to prevent. Codex PR #82 P1.
 *
 * Queue is keyed on the absolute config path so tests with separate
 * tmpdirs don't serialise against each other, and production callers
 * all collapse to one chain against the operator's real `~/.claude.json`.
 *
 * The queue chains via `.catch(() => undefined).then(...)` so a single
 * failed write doesn't poison the chain — same defensive pattern used
 * in `SessionPersistenceStore._mutate`.
 */
const _writeQueues = new Map<string, Promise<TrustHealResult | void>>();

export async function ensureTrustAccepted(
  cwd: string,
  opts?: {
    /** Override the homedir lookup. Used by tests for tmp dirs. */
    homedir?: () => string;
    /** Override the config-file path entirely. Used by tests. */
    configPath?: string;
  },
): Promise<TrustHealResult> {
  const home = opts?.homedir?.() ?? defaultHomedir();
  const configPath = opts?.configPath ?? resolvePath(home, ".claude.json");
  const absoluteCwd = resolvePath(cwd);

  const prev = _writeQueues.get(configPath) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => _doEnsureTrustAccepted(configPath, absoluteCwd));
  _writeQueues.set(configPath, next);
  return next;
}

async function _doEnsureTrustAccepted(
  configPath: string,
  absoluteCwd: string,
): Promise<TrustHealResult> {
  try {
    let raw: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      const text = await Bun.file(configPath).text();
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            raw = parsed as Record<string, unknown>;
          }
        } catch (err) {
          // Malformed JSON — refuse to overwrite, surface as a non-fatal
          // failure so the operator knows to fix the file.
          return {
            ok: false,
            changed: false,
            configPath,
            reason: `~/.claude.json is malformed JSON: ${(err as Error).message}`,
          };
        }
      }
    }

    const projects = (raw.projects as Record<string, unknown> | undefined) ?? {};
    const existing = (projects[absoluteCwd] as Record<string, unknown> | undefined) ?? null;

    if (existing && existing.hasTrustDialogAccepted === true) {
      return { ok: true, changed: false, configPath };
    }

    const next: Record<string, unknown> = { ...projects };
    next[absoluteCwd] = existing
      ? { ...existing, hasTrustDialogAccepted: true }
      : defaultProjectEntry();

    const updated = { ...raw, projects: next };
    const payload = `${JSON.stringify(updated, null, 2)}\n`;

    // Atomic-ish write: write a temp file then rename. Bun.write handles
    // the write side; we do a 2-step move to avoid leaving the file in a
    // partially-written state if the process dies mid-write.
    const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    await Bun.write(tmpPath, payload);
    await Bun.$`mv ${tmpPath} ${configPath}`.quiet();

    return { ok: true, changed: true, configPath };
  } catch (err) {
    return {
      ok: false,
      changed: false,
      configPath,
      reason: `failed to write ~/.claude.json: ${(err as Error).message}`,
    };
  }
}
