/**
 * Phase 17 migration shim: relocate Phase 16 single-job agents from
 * `.claude/claudeclaw/jobs/<agent>.md` to `agents/<agent>/jobs/default.md`.
 *
 * Idempotent: safe to call on every daemon startup.
 */

import { existsSync } from "fs";
import { readdir, mkdir, writeFile, unlink } from "fs/promises";
import { join } from "path";

export interface MigrationResult {
  migrated: string[];
  skipped: string[];
}

export async function migrateLegacyAgentJobs(): Promise<MigrationResult> {
  const result: MigrationResult = { migrated: [], skipped: [] };
  const legacyDir = join(process.cwd(), ".claude", "claudeclaw", "jobs");

  let files: string[];
  try {
    files = await readdir(legacyDir);
  } catch {
    return result;
  }

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const legacyPath = join(legacyDir, file);
    const content = await Bun.file(legacyPath).text();

    // Look for `agent: <name>` inside frontmatter.
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) {
      result.skipped.push(file);
      continue;
    }
    const agentLine = fmMatch[1]
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("agent:"));
    if (!agentLine) {
      result.skipped.push(file);
      continue;
    }
    const agentName = agentLine
      .replace("agent:", "")
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!agentName) {
      result.skipped.push(file);
      continue;
    }

    const agentDir = join(process.cwd(), "agents", agentName);
    if (!existsSync(agentDir)) {
      result.skipped.push(file);
      continue;
    }

    const targetDir = join(agentDir, "jobs");
    const targetPath = join(targetDir, "default.md");
    if (existsSync(targetPath)) {
      result.skipped.push(file);
      continue;
    }

    await mkdir(targetDir, { recursive: true });
    const migrated = content
      .replace(/^agent:\s*\S+\s*\n/m, "")
      .replace(/^---\s*\n/, "---\nlabel: default\n");
    await writeFile(targetPath, migrated, "utf8");
    await unlink(legacyPath);
    result.migrated.push(`${agentName}/default`);
  }

  return result;
}
