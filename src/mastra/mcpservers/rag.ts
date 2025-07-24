import { MCPClient } from "@mastra/mcp";

// Configure MCPClient to connect to your server(s)
export const ragMcp = new MCPClient({
  servers: {
    rag: {
      command: "npx",
      args: ["-y", "mcp-rag-server"],
      env: {
        BASE_LLM_API: "http://localhost:11434/v1",
        EMBEDDING_MODEL: "nomic-embed-text",
        VECTOR_STORE_PATH: "./vector_store",
        CHUNK_SIZE: "500"
      }
    }
  },
});
