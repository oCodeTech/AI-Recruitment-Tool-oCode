import { MCPClient } from "@mastra/mcp";

export const context7Mcp = new MCPClient({
  servers: {
    context7: {
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
    },
  },
});
