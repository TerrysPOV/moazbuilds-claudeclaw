/**
 * Telegram adapter — text-directive helpers.
 *
 * Split out of `index.ts` so the main adapter stays under the file-size
 * ceiling and so directive parsing has its own test surface.
 *
 * Mirrors the regex + post-cleanup pipeline used by
 * `src/commands/telegram.ts:661-684` (legacy PTY listener). Spec
 * reference: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.5.2 +
 * `CLAUDE.md` "Emoji & Reactions".
 */

/**
 * Strip every `[react:<emoji>]` tag from `text` and collect the emojis.
 *
 * - Tags are case-insensitive (`[REACT:🪶]` and `[react:🪶]` both match).
 * - Multiple tags are supported. The legacy file only kept the first; we
 *   keep all of them because applying multiple reactions is harmless and
 *   future agents may want to emit several.
 * - Cleanup runs the same steps as the legacy file: collapse trailing
 *   whitespace before newlines, collapse runs of 3+ blank lines down to
 *   two, then `trim()`.
 *
 * Exported for tests; not part of the public adapter surface.
 */
export function extractReactionDirectives(text: string): {
  cleanedText: string;
  emojis: string[];
} {
  const emojis: string[] = [];
  let cleaned = text.replace(/\[react:([^\]\r\n]+)\]/gi, (_match, raw) => {
    const candidate = String(raw).trim();
    if (candidate) emojis.push(candidate);
    return "";
  });
  cleaned = cleaned.replace(/[ \t]+\n/g, "\n");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  cleaned = cleaned.trim();
  return { cleanedText: cleaned, emojis };
}
