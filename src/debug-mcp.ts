import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync, appendFileSync } from "fs";

const LOG_FILE = "/tmp/mcp-debug.log";

function log(label: string, data: unknown) {
  const entry = `[${new Date().toISOString()}] ${label}:\n${JSON.stringify(data, null, 2)}\n\n`;
  appendFileSync(LOG_FILE, entry);
  console.error(entry); // Also to stderr so we can see it
}

// Clear log on startup
writeFileSync(LOG_FILE, `=== MCP Debug Server Started ${new Date().toISOString()} ===\n\n`);

const server = new Server(
  {
    name: "debug-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

log("Server created", { pid: process.pid });

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  log("ListTools request", request);
  return {
    tools: [
      {
        name: "debug_echo",
        description: "Echoes back everything it receives for debugging",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Any message to echo",
            },
          },
          required: ["message"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  log("CallTool FULL REQUEST", request);
  log("CallTool params", request.params);
  log("CallTool meta (if any)", (request as any).meta);
  log("Request keys", Object.keys(request));

  return {
    content: [
      {
        type: "text",
        text: `Logged request to ${LOG_FILE}\n\nRequest dump:\n${JSON.stringify(request, null, 2)}`,
      },
    ],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  log("Transport created", { type: "stdio" });
  await server.connect(transport);
  log("Server connected", {});
  console.error("Debug MCP server running on stdio");
}

main().catch((error) => {
  log("Fatal error", error);
  process.exit(1);
});
