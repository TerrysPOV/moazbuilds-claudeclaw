import { z } from "zod";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// ── Types ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface PluginTool<T extends z.ZodType = z.ZodType<any, any>> {
  name: string;
  description: string;
  schema: T;
  handler: (args: z.infer<T>) => Promise<unknown> | unknown;
}

export interface PluginToolContext {
  pluginId: string;
  callerToken?: string;
  signature: string;
  ts: number;
}

export interface RegisteredTool {
  plugin: string;
  tool: PluginTool;
}

export interface ListedTool {
  fqn: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ── PluginMcpBridge ───────────────────────────────────────────────────────────

export class PluginMcpBridge {
  private tools = new Map<string, RegisteredTool>();
  private secrets = new Map<string, Buffer>();
  private auditPath: string;

  constructor(auditPath?: string) {
    this.auditPath = auditPath
      ? resolve(auditPath)
      : resolve(homedir(), ".config", "plus", "plugin-audit.jsonl");

    // Ensure audit directory exists
    const auditDir = this.auditPath.substring(0, this.auditPath.lastIndexOf("/"));
    mkdirSync(auditDir, { recursive: true });
  }

  // ── Tool registration ──────────────────────────────────────────────────

  // Path-traversal guard: pluginId must be a safe identifier.
  // Allowed: lowercase letters, digits, dashes; must start with a letter; 1-64 chars.
  // Rejects any string containing path separators, dots, or other special chars.
  private _validatePluginId(pluginId: string): void {
    if (typeof pluginId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(pluginId)) {
      throw new Error(
        `invalid pluginId: ${JSON.stringify(pluginId)} (must match /^[a-z][a-z0-9-]{0,63}$/)`,
      );
    }
  }

  registerPluginTool(pluginId: string, tool: PluginTool): void {
    this._validatePluginId(pluginId);
    const fqn = `${pluginId}__${tool.name}`;

    if (this.tools.has(fqn)) {
      throw new Error(`Duplicate tool registration: "${fqn}" is already registered`);
    }

    this.tools.set(fqn, { plugin: pluginId, tool });
    this.audit("register", { fqn, pluginId, toolName: tool.name, description: tool.description });
  }

  unregisterPlugin(pluginId: string): void {
    this._validatePluginId(pluginId);
    for (const [fqn, entry] of this.tools) {
      if (entry.plugin === pluginId) this.tools.delete(fqn);
    }
    this.audit("unregister", { pluginId });
  }

  // ── Secret management ──────────────────────────────────────────────────

  loadOrCreateSecret(pluginId: string): Buffer {
    this._validatePluginId(pluginId);
    const cached = this.secrets.get(pluginId);
    if (cached) return cached;

    const secretDir = resolve(homedir(), ".config", "plus", "plugins", pluginId);
    const secretPath = join(secretDir, ".secret");

    mkdirSync(secretDir, { recursive: true });

    let secret: Buffer;
    if (existsSync(secretPath)) {
      const raw = readFileSync(secretPath);
      // hex-encoded 32 bytes = 64 chars
      secret = Buffer.from(raw.toString().trim(), "hex");
    } else {
      secret = randomBytes(32);
      writeFileSync(secretPath, secret.toString("hex"), { encoding: "utf8" });
      chmodSync(secretPath, 0o600);
    }

    this.secrets.set(pluginId, secret);
    return secret;
  }

  // ── HMAC signing ──────────────────────────────────────────────────────

  signCall(pluginId: string, body: unknown, ts: number): string {
    const secret = this.loadOrCreateSecret(pluginId);
    const canonical = JSON.stringify({ body, ts });
    return createHmac("sha256", secret).update(canonical).digest("hex");
  }

  verifyCall(pluginId: string, body: unknown, ts: number, signature: string): boolean {
    const expected = this.signCall(pluginId, body, ts);
    try {
      const expectedBuf = Buffer.from(expected, "hex");
      const signatureBuf = Buffer.from(signature, "hex");
      if (expectedBuf.length !== signatureBuf.length) return false;
      return timingSafeEqual(expectedBuf, signatureBuf);
    } catch {
      return false;
    }
  }

  // ── Tool invocation ───────────────────────────────────────────────────

  async invokeTool(fqn: string, args: unknown): Promise<unknown> {
    const registered = this.tools.get(fqn);
    if (!registered) {
      throw new Error(`Unknown tool: "${fqn}"`);
    }

    const { plugin: pluginId, tool } = registered;

    // Validate args via Zod schema
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      const err = new Error(`Invalid args for "${fqn}": ${parsed.error.message}`);
      this.audit("error", { fqn, pluginId, error: parsed.error.message, phase: "validation" });
      throw err;
    }

    // Sign the call
    const ts = Date.now();
    const signature = this.signCall(pluginId, parsed.data, ts);

    try {
      const result = await tool.handler(parsed.data);
      this.audit("invoke", { fqn, pluginId, ts, signature, success: true });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit("error", { fqn, pluginId, ts, signature, error: message, phase: "handler" });
      throw err;
    }
  }

  // ── Tool listing ──────────────────────────────────────────────────────

  listTools(): ListedTool[] {
    return Array.from(this.tools.entries()).map(([fqn, { tool }]) => ({
      fqn,
      description: tool.description,
      inputSchema: this.zodToJson(tool.schema),
    }));
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private zodToJson(schema: z.ZodType): Record<string, unknown> {
    // MVP minimal converter — returns a basic JSON Schema object
    if (schema instanceof z.ZodObject) {
      const shape = schema.shape as Record<string, z.ZodType>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, field] of Object.entries(shape)) {
        properties[key] = this.zodFieldToJson(field as z.ZodType);
        // If not optional, mark as required
        if (!(field instanceof z.ZodOptional) && !(field instanceof z.ZodDefault)) {
          required.push(key);
        }
      }

      return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      };
    }

    // Fallback for non-object schemas
    return { type: "object", additionalProperties: true };
  }

  private zodFieldToJson(field: z.ZodType): Record<string, unknown> {
    if (field instanceof z.ZodOptional) {
      return this.zodFieldToJson(field.unwrap() as z.ZodType);
    }
    if (field instanceof z.ZodDefault) {
      return this.zodFieldToJson(field._def.innerType as z.ZodType);
    }
    if (field instanceof z.ZodString) return { type: "string" };
    if (field instanceof z.ZodNumber) return { type: "number" };
    if (field instanceof z.ZodBoolean) return { type: "boolean" };
    if (field instanceof z.ZodArray)
      return { type: "array", items: this.zodFieldToJson(field.element as z.ZodType) };
    if (field instanceof z.ZodEnum) return { type: "string", enum: field.options as string[] };
    return { type: "object", additionalProperties: true };
  }

  audit(event: string, payload: Record<string, unknown>): void {
    try {
      const entry = JSON.stringify({ event, ts: new Date().toISOString(), ...payload }) + "\n";
      appendFileSync(this.auditPath, entry, { encoding: "utf8" });
    } catch {
      // Audit failures must not break the bridge
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _bridge: PluginMcpBridge | null = null;

export function getMcpBridge(): PluginMcpBridge {
  if (!_bridge) {
    _bridge = new PluginMcpBridge();
  }
  return _bridge;
}

/** Reset singleton — only for testing */
export function _resetMcpBridge(): void {
  _bridge = null;
}

/** Set bridge singleton — only for testing */
export function _setMcpBridge(b: PluginMcpBridge | null): void {
  _bridge = b;
}
