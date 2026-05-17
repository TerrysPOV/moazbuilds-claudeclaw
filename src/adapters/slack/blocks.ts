/**
 * Slack adapter — Block Kit builders.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.5.3.
 *
 * Pure functions split out of `index.ts` so the main adapter file stays
 * under the per-file LOC cap (SPRINT_4_PLAN.md). Block Kit reference:
 * https://api.slack.com/block-kit
 *
 * Sprint 4 ships one builder — `buildPermissionBlocks` for allow/deny
 * permission prompts. Future builders for `system.request_human` modal
 * variants, streaming placeholders, etc. would live here.
 */

import type { PermissionRequest } from "../../bus/types";
import type { SlackBlock } from "./types";

/**
 * Build the permission-prompt Block Kit payload. Pure function so the
 * test suite can assert on the exact shape without spinning up an adapter.
 *
 * The `action_id` format `perm:<allow|deny>:<request_id>` is the colon-
 * separated form chosen for Slack per SPRINT_4_PLAN.md. Telegram uses
 * the same format; Discord still uses `ccaw_perm_<…>_<…>` underscores —
 * convergence is a separate Sprint 4 task.
 */
export function buildPermissionBlocks(req: PermissionRequest): SlackBlock[] {
  const lines = [`*Permission request*`, `Tool: \`${req.tool_name}\``];
  if (req.description) lines.push(req.description);
  if (req.input_preview) lines.push(`\`\`\`\n${req.input_preview}\n\`\`\``);

  return [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Allow" },
          action_id: `perm:allow:${req.request_id}`,
          value: "allow",
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Deny" },
          action_id: `perm:deny:${req.request_id}`,
          value: "deny",
          style: "danger",
        },
      ],
    },
  ];
}
