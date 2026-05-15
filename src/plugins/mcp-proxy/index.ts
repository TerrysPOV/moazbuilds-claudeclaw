import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { getMcpBridge } from "../mcp-bridge.js";
import { getHttpGateway } from "../http-gateway.js";
import { McpServerProcess, type McpServerConfig } from "./server-process.js";

const MAX_RESULT_BYTES = Number(process.env.MCP_PROXY_MAX_RESULT_BYTES ?? 1_048_576);

// ── Config schema ─────────────────────────────────────────────────────────────

const ServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  enabled: z.boolean().default(true),
  allowedTools: z.array(z.string()).optional(),
});

const ProxyConfigSchema = z.object({
  servers: z.record(ServerConfigSchema),
});

type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

// ── McpProxyPlugin ────────────────────────────────────────────────────────────

export interface McpProxyPluginOpts {
  configPath?: string;
  tokenPath?: string;
  // For reasoned mode: inject into active Claude session
  reasonedInvokeFn?: (tool: string, args: unknown) => Promise<unknown>;
}

export class McpProxyPlugin {
  private servers = new Map<string, McpServerProcess>();
  private configPath: string;
  private tokenPath: string;
  private reasonedInvokeFn?: (tool: string, args: unknown) => Promise<unknown>;
  private pluginToken: Buffer | null = null;

  constructor(opts: McpProxyPluginOpts = {}) {
    this.configPath = opts.configPath ?? join(homedir(), ".config", "claudeclaw", "mcp-proxy.json");
    this.tokenPath = opts.tokenPath ?? join(homedir(), ".config", "claudeclaw", "mcp-proxy.token");
    this.reasonedInvokeFn = opts.reasonedInvokeFn;
  }

  async start(): Promise<void> {
    try {
      const stat = statSync(this.configPath);
      if (stat.mode & 0o077) {
        console.error(
          `[mcp-proxy] WARN: ${this.configPath} has permissive permissions (${(stat.mode & 0o777).toString(8)}); recommended 0600.`,
        );
      }
    } catch {} // missing config handled below with a clearer message

    const config = this._loadConfig();
    if (!config) {
      console.error(
        "[mcp-proxy] No config found — registering with zero tools (graceful degradation)",
      );
      this._registerWithGateway([]);
      return;
    }

    const enabledServers = Object.entries(config.servers).filter(([, s]) => s.enabled);
    const allTools: { name: string; description: string; schema: Record<string, unknown> }[] = [];

    await Promise.allSettled(
      enabledServers.map(async ([name, cfg]) => {
        const proc = new McpServerProcess(name, cfg as McpServerConfig, {
          onCrash: (n, reason) => this._onServerCrash(n, reason),
        });

        try {
          await proc.start();
          this.servers.set(name, proc);

          for (const tool of proc.tools) {
            const fqn = `${name}__${tool.name}`;
            try {
              getMcpBridge().registerPluginTool("mcp-proxy", {
                name: fqn,
                description: tool.description,
                schema: z.object({
                  arguments: z.record(z.unknown()).optional().default({}),
                  mode: z.enum(["direct", "reasoned"]).optional().default("direct"),
                }),
                handler: async (input) => {
                  const mode = input.mode ?? "direct";
                  const args = input.arguments ?? {};
                  if (mode === "reasoned") {
                    return this._invokeReasoned(fqn, args);
                  }
                  const result = await proc.call(tool.name, args);
                  const resultStr = JSON.stringify(result);
                  const resultBytes = Buffer.byteLength(resultStr, "utf8");
                  if (resultBytes > MAX_RESULT_BYTES) {
                    throw new Error(
                      `Tool result exceeds ${MAX_RESULT_BYTES} bytes (got ${resultBytes})`,
                    );
                  }
                  return result;
                },
              });
              allTools.push({ name: fqn, description: tool.description, schema: tool.inputSchema });
            } catch {
              // duplicate or error — skip
            }
          }

          console.error(`[mcp-proxy] Server '${name}' ready — ${proc.tools.length} tools`);
        } catch (err) {
          console.error(
            `[mcp-proxy] Server '${name}' failed to start: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );

    this._registerWithGateway(allTools);
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.servers.values()].map((p) => p.stop()));
    this.servers.clear();
  }

  health(): Record<string, unknown> {
    const servers: Record<string, unknown> = {};
    for (const [name, proc] of this.servers) {
      servers[name] = {
        status: proc.status,
        uptime_s: proc.startedAt
          ? Math.floor((Date.now() - proc.startedAt.getTime()) / 1000)
          : null,
        last_invocation_at: proc.lastInvocationAt?.toISOString() ?? null,
        tools: proc.tools.map((t) => t.name),
      };
    }
    return { servers };
  }

  private _loadConfig(): ProxyConfig | null {
    const paths = [this.configPath, join(homedir(), ".config", "claude", "mcp.json")];
    for (const p of paths) {
      if (!existsSync(p)) continue;
      try {
        const raw = JSON.parse(readFileSync(p, "utf8"));
        const result = ProxyConfigSchema.safeParse(raw);
        if (result.success) return result.data;
      } catch {}
    }
    return null;
  }

  private _registerWithGateway(
    tools: { name: string; description: string; schema: Record<string, unknown> }[],
  ): void {
    const gateway = getHttpGateway();
    this.pluginToken = gateway.registerInProcess("mcp-proxy", {
      version: "1.0.0",
      tools,
      healthFn: async () => this.health(),
    });

    const tokenDir = join(this.tokenPath, "..");
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(this.tokenPath, this.pluginToken.toString("hex"), { encoding: "utf8" });
    chmodSync(this.tokenPath, 0o600);

    console.error(
      `[mcp-proxy] Registered with gateway — ${tools.length} tools. Token stored at ${this.tokenPath}`,
    );
  }

  private _onServerCrash(name: string, reason: string): void {
    const proc = this.servers.get(name);
    if (!proc) return;

    getMcpBridge().audit("mcp_proxy_server_crashed", { server: name, reason, status: proc.status });
    console.error(`[mcp-proxy] Server '${name}' crashed: ${reason} — status: ${proc.status}`);

    if (proc.status === "failed") {
      console.error(`[mcp-proxy] Server '${name}' permanently failed after too many crashes`);
      getMcpBridge().audit("mcp_proxy_server_permanently_failed", { server: name });
    }
  }

  private async _invokeReasoned(fqn: string, args: unknown): Promise<unknown> {
    if (!this.reasonedInvokeFn) {
      throw new Error(`reasoned mode not configured for ${fqn}`);
    }
    return this.reasonedInvokeFn(fqn, args);
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _proxy: McpProxyPlugin | null = null;

export function getMcpProxyPlugin(opts?: McpProxyPluginOpts): McpProxyPlugin {
  if (!_proxy) _proxy = new McpProxyPlugin(opts);
  return _proxy;
}

export function _resetMcpProxy(): void {
  _proxy = null;
}
