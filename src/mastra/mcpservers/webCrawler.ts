import { MCPClient } from "@mastra/mcp";

// Configure MCPClient to connect to your server(s)
export const webCrawlerMcp = new MCPClient({
  servers: {
    fetcher: {
      command: "npx",
      args: ["-y", "fetcher-mcp"]
    },
  },
});
