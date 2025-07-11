import { MCPClient } from "@mastra/mcp";

// Configure MCPClient to connect to your server(s)
export const gmailMcp = new MCPClient({
  servers: {
    gmail: {
      command: "npx",
      args: ["@gongrzhe/server-gmail-autoauth-mcp"]
    },
  },
});
