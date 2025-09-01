import { MCPClient } from "@mastra/mcp";

export const superMemoryMcp = new MCPClient({
  servers: {
    "api-supermemory-ai": {
      command: "npx",
      args: [
        "-y",
        "mcp-remote@latest",
        "https://api.supermemory.ai/mcp",
        "--header",
        "x-sm-project:default",
      ],
    },
  },
});