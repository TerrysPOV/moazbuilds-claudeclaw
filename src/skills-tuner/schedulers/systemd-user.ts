/**
 * SystemdUserBackend — Linux systemd-user units.
 *
 * Writes a `.timer` + `.service` pair under `~/.config/systemd/user/` and
 * activates via `systemctl --user daemon-reload && enable --now <name>.timer`.
 *
 * Auto-detection probes for the systemd-user manager via
 * `systemctl --user --no-pager show -p Version` with a short timeout. The
 * probe explicitly avoids `is-active` because that varies wildly across
 * distros and would false-negative on first install.
 *
 * Subprocesses spawned from a server (MCP, daemon child, etc.) typically
 * don't inherit `DBUS_SESSION_BUS_ADDRESS` / `XDG_RUNTIME_DIR`. Every
 * `systemctl --user` call here injects them explicitly so the backend
 * works in those contexts too.
 */

import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
/**
 * Quote a string for safe inclusion in a systemd ExecStart= line as the
 * argument to `/bin/sh -c`. systemd's parser supports double-quoted strings
 * with backslash escapes (per `systemd.syntax(7)`), but does NOT support
 * JSON's \uXXXX escapes — using JSON.stringify can therefore produce
 * output systemd rejects when the command contains non-ASCII control chars.
 *
 * We restrict ourselves to backslash-escaping the four characters that
 * actually need escaping inside systemd-double-quotes: \\, ", $, and `.
 * `validateJobCommand` already rejects \x00, \r, and \n so we don't need
 * to handle those here.
 */
function quoteForSystemdExecStart(s: string): string {
  return '"' + s.replace(/[\\"$\`]/g, (m) => "\\" + m) + '"';
}

import {
  type SchedulerBackend,
  type JobSpec,
  type ScheduledJob,
  type RenderedArtifacts,
  BackendError,
  validateJobName,
  validateJobCommand,
} from "./base.js";

const SYSTEMD_DIR = join(homedir(), ".config", "systemd", "user");
const UNIT_TAG = "wisecron-managed";

function systemdEnv(): NodeJS.ProcessEnv {
  const uid =
    process.getuid?.() ??
    parseInt(execSync("id -u", { stdio: ["ignore", "pipe", "pipe"] }).toString().trim(), 10);
  return {
    ...process.env,
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
  };
}

export class SystemdUserBackend implements SchedulerBackend {
  readonly name = "systemd-user" as const;

  async detect(): Promise<boolean> {
    if (process.platform !== "linux") return false;
    const result = spawnSync("systemctl", ["--user", "--no-pager", "show", "-p", "Version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: systemdEnv(),
      timeout: 500,
    });
    return result.status === 0;
  }

  gitRepoPath(): string {
    return SYSTEMD_DIR;
  }

  async list(): Promise<ScheduledJob[]> {
    if (!existsSync(SYSTEMD_DIR)) return [];
    const entries = readdirSync(SYSTEMD_DIR).filter((f) => f.endsWith(".timer"));
    const jobs: ScheduledJob[] = [];
    for (const f of entries) {
      const name = f.replace(/\.timer$/, "");
      const timerPath = join(SYSTEMD_DIR, f);
      const servicePath = join(SYSTEMD_DIR, `${name}.service`);
      let content = "";
      try {
        content = readFileSync(timerPath, "utf8");
      } catch {
        continue;
      }
      if (!content.includes(UNIT_TAG)) continue;

      const calendarMatch = content.match(/^OnCalendar=(.+)$/m);
      const schedule = calendarMatch?.[1]?.trim() ?? "";

      let command = "";
      if (existsSync(servicePath)) {
        const svc = readFileSync(servicePath, "utf8");
        const execStart = svc.match(/^ExecStart=(.+)$/m);
        // Strip the `/bin/sh -c ` wrapper if present, and any surrounding quotes.
        command = execStart?.[1]?.replace(/^\/bin\/sh\s+-c\s+"(.+)"$/, "$1") ?? "";
      }

      const isActiveResult = spawnSync(
        "systemctl",
        ["--user", "is-active", "--quiet", f],
        { env: systemdEnv(), timeout: 500 },
      );
      const status: ScheduledJob["status"] = isActiveResult.status === 0 ? "active" : "inactive";

      jobs.push({ name, schedule, command, status, artifactPath: timerPath });
    }
    return jobs;
  }

  render(spec: JobSpec): RenderedArtifacts {
    const serviceUnit = `[Unit]
Description=${spec.name} (${UNIT_TAG})
After=network.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c ${quoteForSystemdExecStart(spec.command)}
`;
    const timerUnit = `[Unit]
Description=${spec.name} timer (${UNIT_TAG})

[Timer]
OnCalendar=${spec.schedule}
Persistent=true

[Install]
WantedBy=timers.target
`;
    return {
      files: {
        [`${spec.name}.service`]: serviceUnit,
        [`${spec.name}.timer`]: timerUnit,
      },
      summary: `systemd-user: ${spec.name}.timer with OnCalendar=${spec.schedule}`,
    };
  }

  async create(spec: JobSpec): Promise<{ artifactPath: string | null }> {
    validateJobName(spec.name);
    validateJobCommand(spec.command);
    this.validateOnCalendar(spec.schedule);

    const servicePath = join(SYSTEMD_DIR, `${spec.name}.service`);
    const timerPath = join(SYSTEMD_DIR, `${spec.name}.timer`);
    if (existsSync(servicePath) || existsSync(timerPath)) {
      throw new BackendError(
        `systemd unit exists for ${spec.name} — remove() first or rename`,
        false,
      );
    }

    const rendered = this.render(spec);
    mkdirSync(SYSTEMD_DIR, { recursive: true });
    for (const [relPath, content] of Object.entries(rendered.files)) {
      writeFileSync(join(SYSTEMD_DIR, relPath), content, "utf8");
    }

    try {
      const env = systemdEnv();
      execSync("systemctl --user daemon-reload", { stdio: "pipe", env });
      execSync(`systemctl --user enable --now ${spec.name}.timer`, { stdio: "pipe", env });
    } catch (e) {
      // Files are on disk; surface the failure but don't pretend nothing was written.
      throw new BackendError(
        `systemctl enable failed for ${spec.name}: ${(e as Error).message.slice(0, 200)}. Files written to ${SYSTEMD_DIR}; activate manually with \`systemctl --user enable --now ${spec.name}.timer\`.`,
        true,
      );
    }

    return { artifactPath: timerPath };
  }

  async remove(name: string): Promise<void> {
    validateJobName(name);
    const servicePath = join(SYSTEMD_DIR, `${name}.service`);
    const timerPath = join(SYSTEMD_DIR, `${name}.timer`);
    if (!existsSync(timerPath) && !existsSync(servicePath)) return;

    const env = systemdEnv();
    try {
      execSync(`systemctl --user disable --now ${name}.timer`, { stdio: "pipe", env });
    } catch {
      // Already disabled or never enabled — fine, proceed to file removal.
    }
    if (existsSync(timerPath)) unlinkSync(timerPath);
    if (existsSync(servicePath)) unlinkSync(servicePath);
    try {
      execSync("systemctl --user daemon-reload", { stdio: "pipe", env });
    } catch {
      // Best-effort reload; absent files are already gone.
    }
  }

  private validateOnCalendar(spec: string): void {
    if (typeof spec !== "string" || spec.trim().length === 0) {
      throw new BackendError("OnCalendar spec is required", false);
    }
    if (spec.length > 200) {
      throw new BackendError(`OnCalendar too long: ${spec.length} chars`, false);
    }
    if (/[\x00\r\n]/.test(spec)) {
      throw new BackendError("OnCalendar contains forbidden control characters", false);
    }
  }
}
