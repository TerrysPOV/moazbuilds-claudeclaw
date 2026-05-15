/**
 * ClaudeClaw-Plus MCP stdio server
 *
 * Exposes all plugin-registered tools via the Model Context Protocol.
 * Run standalone: bun run src/plugins/mcp-server.ts
 *
 * Or configure in claude_desktop_config.json:
 *   { "mcpServers": { "claudeclaw-plus": { "command": "bun", "args": ["run", "/path/to/mcp-server.ts"] } } }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getMcpBridge } from "./mcp-bridge.js";

export async function startMcpServer(): Promise<void> {
  const bridge = getMcpBridge();

  const server = new Server(
    { name: "claudeclaw-plus", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // List all registered plugin tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = bridge.listTools();
    return {
      tools: tools.map((t) => ({
        name: t.fqn,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  // Invoke a tool by FQN
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await bridge.invokeTool(name, args ?? {});
      return {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run standalone when executed directly
if (import.meta.main) {
  startMcpServer().catch((err) => {
    console.error("[mcp-server] Fatal:", err);
    process.exit(1);
  });
}
