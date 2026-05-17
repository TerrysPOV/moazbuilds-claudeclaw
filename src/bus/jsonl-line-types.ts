/**
 * JSONL line-type discriminated union + extraction helpers.
 *
 * Source of truth:
 *  - `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.2 (line-type table)
 *  - `docs/spikes/0.2-jsonl-schema-snapshot.md` (empirical shapes against
 *    claude 2.1.143)
 *  - `docs/spikes/0.5-lifecycle-markers.md` (compact_boundary mapping)
 *  - Fixtures under `docs/spikes/fixtures/jsonl/`
 *
 * Kept in a sibling file (not `types.ts`) because these shapes are
 * authoritatively owned by the Tailer parser — bumping a field shape
 * bumps `SCHEMA_VERSION` in `jsonl-tailer.ts`. Other Bus surfaces
 * (Web UI adapter, schema probe) consume normalised `BusEvent`s and
 * shouldn't need to know about these raw shapes.
 *
 * Spike 0.2 found `tool_result.content` is **string OR array** (array
 * when result includes images). All extraction helpers below guard
 * `typeof === "string"` before string ops.
 */

/* ───────────────────────────────────────────────────────────────────── */
/* Common envelope                                                       */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Fields present on most JSONL lines. Per Spike 0.2 §"Confirmed line
 * types" — every `user`/`assistant`/`attachment`/`system` line carries
 * `uuid`, `cwd`, `sessionId`, `timestamp`. The compact `permission-mode`
 * / `ai-title` / `pr-link` / `queue-operation` lines do NOT.
 */
export interface RawEnvelope {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
}

/* ───────────────────────────────────────────────────────────────────── */
/* Content blocks                                                        */
/* ───────────────────────────────────────────────────────────────────── */

/** Inside `user.message.content[]` when an array. */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  /** string OR array (Spike 0.2 §6 — array when result carries images). */
  content: string | unknown[];
  is_error?: boolean | null;
}

/** Inside `assistant.message.content[]`. */
export interface AssistantTextBlock {
  type: "text";
  text: string;
}

export interface AssistantToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AssistantThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export type AssistantContentBlock =
  | AssistantTextBlock
  | AssistantToolUseBlock
  | AssistantThinkingBlock
  | { type: string; [k: string]: unknown };

/* ───────────────────────────────────────────────────────────────────── */
/* Line types                                                            */
/* ───────────────────────────────────────────────────────────────────── */

/** Usage block as seen in `assistant.message.usage`. */
export interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  service_tier?: string;
  [k: string]: unknown;
}

export interface UserLine extends RawEnvelope {
  type: "user";
  message: {
    role: "user";
    content: string | Array<ToolResultBlock | { type: string; [k: string]: unknown }>;
  };
  permissionMode?: string;
  promptId?: string;
  toolUseResult?: unknown;
}

export interface AssistantLine extends RawEnvelope {
  type: "assistant";
  message: {
    role: "assistant";
    id?: string;
    model?: string;
    content: AssistantContentBlock[];
    stop_reason?: string | null;
    usage?: UsageBlock;
  };
  requestId?: string;
  error?: unknown;
  isApiErrorMessage?: boolean;
  apiErrorStatus?: string;
}

export interface AttachmentLine extends RawEnvelope {
  type: "attachment";
  attachment: { type: string; [k: string]: unknown };
}

export interface SystemLine extends RawEnvelope {
  type: "system";
  subtype: string;
  content?: unknown;
  compactMetadata?: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    durationMs?: number;
  };
  [k: string]: unknown;
}

export interface PermissionModeLine {
  type: "permission-mode";
  permissionMode: string;
  sessionId?: string;
}

export interface FileHistorySnapshotLine {
  type: "file-history-snapshot";
  messageId?: string;
  snapshot?: unknown;
  isSnapshotUpdate?: boolean;
}

export interface AiTitleLine {
  type: "ai-title";
  aiTitle: string;
  sessionId?: string;
}

export interface AgentNameLine {
  type: "agent-name";
  agentName: string;
  sessionId?: string;
}

export interface CustomTitleLine {
  type: "custom-title";
  customTitle?: string;
  sessionId?: string;
}

export interface PrLinkLine {
  type: "pr-link";
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
  timestamp?: string;
  sessionId?: string;
}

export interface LastPromptLine {
  type: "last-prompt";
  lastPrompt?: string;
  leafUuid?: string;
  sessionId?: string;
}

export interface QueueOperationLine {
  type: "queue-operation";
  operation?: string;
  sessionId?: string;
  timestamp?: string;
  content?: unknown;
}

/** Open-ended unknown — Tailer emits `bus.event.unknown` for these. */
export interface UnknownLine extends RawEnvelope {
  type: string;
  [k: string]: unknown;
}

export type JsonlLine =
  | UserLine
  | AssistantLine
  | AttachmentLine
  | SystemLine
  | PermissionModeLine
  | FileHistorySnapshotLine
  | AiTitleLine
  | AgentNameLine
  | CustomTitleLine
  | PrLinkLine
  | LastPromptLine
  | QueueOperationLine
  | UnknownLine;

/* ───────────────────────────────────────────────────────────────────── */
/* Path encoding (per Spike 0.2)                                         */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Encode an absolute realpath'd cwd into the directory name Claude Code
 * uses under `~/.claude/projects/`. Empirically:
 *   `/Users/foo/bar` → `-Users-foo-bar`
 * i.e. `/` → `-`. No other transformation — case is preserved.
 *
 * Session Manager already calls `fs.realpathSync(cwd)` before passing
 * cwd to the Tailer (resolves macOS `/tmp` → `/private/tmp` symlink per
 * Spike 0.5). Tailer trusts that contract.
 */
export function encodeCwdForProjectsDir(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/* ───────────────────────────────────────────────────────────────────── */
/* Extraction helpers                                                    */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Walk a user line's `message.content` array for `tool_result` blocks.
 * Returns [] when `content` is a string (top-level user prompt) or when
 * content is not an array. Per Spike 0.2 §"Confirmed line types":
 * `tool_result` is NEVER a top-level type — always a content block.
 */
export function extractToolResults(content: UserLine["message"]["content"]): ToolResultBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ToolResultBlock[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "tool_result") {
      out.push(block as ToolResultBlock);
    }
  }
  return out;
}

/**
 * Stringify `tool_result.content` defensively. Returns the original
 * string if already a string; JSON-stringifies the array form (image
 * results) for audit; returns "" for null/undefined.
 *
 * Per Spike 0.2 finding 6: `tool_result.content` is string OR array.
 * Use this helper anywhere we'd otherwise call string methods on it.
 */
export function toolResultContentToString(content: ToolResultBlock["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return JSON.stringify(content);
  return "";
}

/* ───────────────────────────────────────────────────────────────────── */
/* Bus-critical attachment subtypes (spec §5.2)                          */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Subset of the 22-variant attachment union that the Bus must surface
 * with specific semantics. Unknown subtypes still emit
 * `attachment.<subtype>` for forward-compat (§11.1) — this set is
 * informational, used by tests and the Web UI's filter shortlist.
 */
export const BUS_CRITICAL_ATTACHMENT_SUBTYPES: ReadonlySet<string> = new Set([
  "hook_success",
  "hook_cancelled",
  "hook_blocking_error",
  "edited_text_file",
  "command_permissions",
  "plan_mode",
  "plan_mode_exit",
  "task_reminder",
]);
