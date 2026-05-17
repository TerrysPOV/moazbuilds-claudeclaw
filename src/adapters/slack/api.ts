/**
 * Slack adapter — fetch-backed Web API client.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.5.3.
 * Sprint coordination: `src/bus/SPRINT_4_PLAN.md` (Agent A scope).
 *
 * Mirrors `slackApi()` in `src/commands/slack.ts:220-244`. We re-implement
 * here (rather than importing) so the Bus adapter has zero dependency on
 * the legacy file. Sprint 5 consolidates once the PTY path is retired.
 *
 * Sprint 4 TODO: extract a shared `src/slack/api.ts` from the legacy
 * listener — `chat.update`, `reactions.add`, `files.completeUploadExternal`,
 * `assistant.threads.*`, `conversations.open`, etc. all live in the
 * legacy file today. The Bus adapter only needs `chat.postMessage` for
 * Sprint 4, so we ship a minimal client now and grow it.
 */

import type { SlackApi, SlackBlock } from "./types";

const API_BASE = "https://slack.com/api";

/**
 * Build a `SlackApi` instance bound to a particular bot token.
 *
 * Notes:
 *   - Posts JSON with `Authorization: Bearer <token>`, matching Slack's
 *     recommended pattern (legacy uses the same shape, line 225-230).
 *   - On `ok: false` we DO NOT throw — Slack errors are surfaced through
 *     the response object so the adapter's `safe*` wrappers can decide
 *     whether to log + swallow or react. This differs from the legacy
 *     `slackApi` which throws; the Bus adapter prefers returning the
 *     payload so a transient `rate_limited` from `chat.postMessage`
 *     doesn't tank a permission-button click.
 *   - HTTP-level failures (non-2xx, network errors) still throw so the
 *     adapter can log them via `logger.error`.
 */
export function createSlackApi(token: string): SlackApi {
  async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${API_BASE}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Slack API ${method}: HTTP ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  return {
    async postMessage(params: {
      channel: string;
      text: string;
      thread_ts?: string;
      blocks?: SlackBlock[];
    }) {
      return call("chat.postMessage", params as unknown as Record<string, unknown>);
    },
  };
}
