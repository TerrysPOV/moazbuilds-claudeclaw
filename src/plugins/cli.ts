#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const cmd = process.argv[2];
if (cmd === "print-bootstrap-token") {
  const path = join(homedir(), ".config", "plus", "plugin-bootstrap.secret");
  console.log(readFileSync(path).toString("hex"));
} else {
  console.error("Usage: bun run src/plugins/cli.ts print-bootstrap-token");
  process.exit(1);
}
