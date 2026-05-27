import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PATHS = ["/home/claw/.claudeclaw-env", "/etc/claudeclaw/.claudeclaw-env"];

export interface LoadResult {
  path: string;
  loaded: number;
}

/**
 * Auto-load `.claudeclaw-env` into `process.env` for CLI subcommands that
 * spawn `claude --print` (send, fire). Existing vars are NEVER overwritten —
 * so a daemon launched via `set -a; source …; set +a` keeps its already
 * exported values and this call is a no-op for it. Designed for the case
 * where an operator runs `claudeclaw send …` from a terminal that hasn't
 * sourced the env file: without this, `claude --print` falls back to a stale
 * `~/.claude/.credentials.json` and 401s.
 *
 * Search order (first existing file wins):
 *   1. `$CLAUDECLAW_ENV_FILE` (operator override)
 *   2. `/home/claw/.claudeclaw-env` (production daemon host)
 *   3. `/etc/claudeclaw/.claudeclaw-env` (system-wide install)
 *   4. `~/.claudeclaw-env` (dev/laptop)
 *
 * Opt-out: set `CLAUDECLAW_ENV_AUTOLOAD=0` to disable entirely (returns
 * `null` without scanning).
 *
 * Returns the loaded file + count, or `null` if nothing was found.
 */
export function autoLoadClaudeClawEnv(
  opts: { log?: (msg: string) => void } = {},
): LoadResult | null {
  if (process.env.CLAUDECLAW_ENV_AUTOLOAD === "0") return null;

  const candidates = [
    process.env.CLAUDECLAW_ENV_FILE,
    ...DEFAULT_PATHS,
    join(homedir(), ".claudeclaw-env"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const st = statSync(path);
      if (!st.isFile()) continue;
      const text = readFileSync(path, "utf8");
      const loaded = applyDotenv(text);
      opts.log?.(`claudeclaw: loaded ${loaded} var(s) from ${path}`);
      return { path, loaded };
    } catch {
      // ignore unreadable file, try next candidate
    }
  }
  return null;
}

/**
 * Parse simple `KEY=value` lines and set them in `process.env` only when the
 * key is currently `undefined`. Supports `#` comments, blank lines, and
 * surrounding single/double quotes. Returns the count of keys set.
 *
 * Deliberately minimal: no variable interpolation, no `export` keyword
 * handling, no multi-line values. Matches the format Doppler's
 * `env-no-quotes` writer produces, which is what the daemon launcher uses.
 */
export function applyDotenv(text: string): number {
  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (!key) continue;
    let value = m[2] ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      count++;
    }
  }
  return count;
}
