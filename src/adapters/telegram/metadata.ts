/**
 * Telegram adapter — prompt metadata builder.
 *
 * Builds the `metadata` field attached to `bus.sendPrompt`. Future
 * surfaces (Web UI conversation view, audit log queries) consume this
 * to know what attachments were on the original message even though the
 * Bus adapter doesn't download the bytes itself.
 *
 * Lives in its own file to keep `index.ts` under the file-size ceiling.
 */

import type { TelegramMessage } from "./types";

/**
 * Build the `metadata` envelope passed to `bus.sendPrompt`.
 *
 * Always carries `message_id` (needed for downstream correlation). Adds
 * `message_thread_id` when the inbound was in a forum topic. Adds an
 * `attachments` array when any media was attached — file IDs only; the
 * Sprint 5 file pipeline will hydrate bytes.
 *
 * Photo handling mirrors `pickLargestPhoto()` in
 * `src/commands/telegram.ts:366-372`: Telegram returns N sizes, we keep
 * the largest by reported size (falling back to width × height).
 */
export function buildPromptMetadata(message: TelegramMessage): Record<string, unknown> {
  const meta: Record<string, unknown> = { message_id: message.message_id };
  if (message.message_thread_id !== undefined) {
    meta.message_thread_id = message.message_thread_id;
  }

  const attachments: Array<Record<string, unknown>> = [];
  if (message.photo && message.photo.length > 0) {
    const largest = [...message.photo].sort((a, b) => {
      const sa = a.file_size ?? a.width * a.height;
      const sb = b.file_size ?? b.width * b.height;
      return sb - sa;
    })[0];
    if (largest) {
      attachments.push({ kind: "photo", file_id: largest.file_id });
    }
  }
  if (message.document) {
    attachments.push({
      kind: "document",
      file_id: message.document.file_id,
      mime_type: message.document.mime_type,
      file_name: message.document.file_name,
    });
  }
  if (message.voice) {
    attachments.push({ kind: "voice", file_id: message.voice.file_id });
  }
  if (message.audio) {
    attachments.push({
      kind: "audio",
      file_id: message.audio.file_id,
      mime_type: message.audio.mime_type,
    });
  }
  if (attachments.length > 0) {
    meta.attachments = attachments;
  }
  return meta;
}
