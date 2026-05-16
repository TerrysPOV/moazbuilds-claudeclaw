import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import { LOGS_DIR } from "../constants";

export async function readLogs(tail: number) {
  const daemonLog = await readTail(join(LOGS_DIR, "daemon.log"), tail);
  const runs = await readRecentRunLogs(tail);
  return { daemonLog, runs };
}

async function readRecentRunLogs(tail: number) {
  let files: string[] = [];
  try {
    files = await readdir(LOGS_DIR);
  } catch {
    return [];
  }

  const candidates = files.filter((f) => f.endsWith(".log") && f !== "daemon.log").slice(0, 200);

  const withStats = await Promise.all(
    candidates.map(async (name) => {
      const path = join(LOGS_DIR, name);
      try {
        const s = await stat(path);
        return { name, path, mtime: s.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  return await Promise.all(
    withStats
      .filter((x): x is { name: string; path: string; mtime: number } => Boolean(x))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5)
      .map(async ({ name, path }) => ({
        file: name,
        lines: await readTail(path, tail),
      })),
  );
}

async function readTail(path: string, lines: number): Promise<string[]> {
  try {
    const text = await readFile(path, "utf-8");
    const all = text.split(/\r?\n/);
    return all.slice(Math.max(0, all.length - lines)).filter(Boolean);
  } catch {
    return [];
  }
}
