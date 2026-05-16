import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { TunableSubject } from "../core/interfaces.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export abstract class BaseSubject extends TunableSubject {
  protected async loadFrontmatter(
    filePath: string,
  ): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
    const content = await readFile(filePath, "utf8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return { frontmatter: {}, body: content };
    const yaml = await import("js-yaml");
    const parsed = yaml.load(match[1]!);
    return {
      frontmatter: (parsed != null && typeof parsed === "object" ? parsed : {}) as Record<
        string,
        unknown
      >,
      body: match[2]!,
    };
  }

  protected async scanMdFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    await this._scanDir(dir, results);
    return results;
  }

  private async _scanDir(dir: string, results: string[]): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this._scanDir(fullPath, results);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  }
}
