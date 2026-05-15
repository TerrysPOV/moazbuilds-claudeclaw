import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { TunableSubject } from "../core/interfaces.js";
import {
  UnsignedProposalSchema,
  ClusterSchema,
  ObservationSchema,
  PatchSchema,
  ValidationResultSchema,
  type Cluster,
  type Observation,
  type Patch,
  type UnsignedProposal,
  type ValidationResult,
} from "../core/types.js";
import type { Proposal } from "../core/types.js";
import type { RiskTier } from "../core/interfaces.js";

export interface ExternalProcessConfig {
  name: string;
  command: string[];
  allowedRoots?: string[];
  riskTier?: RiskTier;
  autoMergeDefault?: boolean;
  supportsCreation?: boolean;
  orphanMinObservations?: number;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
}

const RpcResponseSchema = z.union([
  z.object({ result: z.unknown() }).strict(),
  z.object({ error: z.string() }).strict(),
]);

export class ExternalProcessSubject extends TunableSubject {
  readonly name: string;
  readonly risk_tier: RiskTier;
  readonly auto_merge_default: boolean;
  readonly supports_creation: boolean;
  readonly orphan_min_observations: number;

  constructor(private opts: ExternalProcessConfig) {
    super();
    this.name = opts.name;
    this.risk_tier = opts.riskTier ?? "high";
    this.auto_merge_default = opts.autoMergeDefault ?? false;
    this.supports_creation = opts.supportsCreation ?? false;
    this.orphan_min_observations = opts.orphanMinObservations ?? 2;
  }

  private async callMethod(method: string, payload: unknown): Promise<unknown> {
    const proc = spawn(this.opts.command[0]!, this.opts.command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
    });

    const requestBody = JSON.stringify({ method, payload, config: this.opts.config ?? {} });
    proc.stdin.write(requestBody);
    proc.stdin.end();

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timeoutMs = this.opts.timeoutMs ?? 60_000;
    const exitCode: number = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error(`ExternalProcess ${this.name} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      proc.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    if (exitCode !== 0) {
      throw new Error(
        `ExternalProcess ${this.name} exited ${exitCode}. stderr: ${stderr.slice(0, 500)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(
        `ExternalProcess ${this.name} returned invalid JSON: ${stdout.slice(0, 500)}`,
      );
    }

    const validated = RpcResponseSchema.parse(parsed);
    if ("error" in validated) {
      throw new Error(`ExternalProcess ${this.name} method ${method} error: ${validated.error}`);
    }
    return validated.result;
  }

  async collectObservations(since: Date): Promise<Observation[]> {
    const result = await this.callMethod("collect_observations", { since: since.toISOString() });
    return z.array(ObservationSchema).parse(result);
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    const result = await this.callMethod("detect_problems", { observations });
    return z.array(ClusterSchema).parse(result);
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    const result = await this.callMethod("propose_change", { cluster });
    return UnsignedProposalSchema.parse(result);
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    const result = await this.callMethod("apply", { proposal, alternative_id: alternativeId });
    const patch = PatchSchema.parse(result);

    // Path traversal guard
    const roots = this.opts.allowedRoots;
    if (!roots || roots.length === 0) {
      throw new Error(
        `ExternalProcessSubject '${this.name}' has no allowedRoots configured — external subjects must declare explicit write zones`,
      );
    }
    const target = resolve(patch.target_path.replace(/^~/, homedir()));
    const allowed = roots.map((r) => resolve(r.replace(/^~/, homedir())));
    const safe = allowed.some((root) => target.startsWith(root + sep) || target === root);
    if (!safe) {
      throw new Error(
        `ExternalProcessSubject '${this.name}' refusing to write outside allowedRoots: target=${target}, allowedRoots=[${allowed.join(", ")}]`,
      );
    }

    return patch;
  }

  async validate(patch: Patch): Promise<ValidationResult> {
    const result = await this.callMethod("validate", { patch });
    return ValidationResultSchema.parse(result);
  }
}
