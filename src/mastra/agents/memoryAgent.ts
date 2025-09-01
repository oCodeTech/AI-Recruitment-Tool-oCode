import { groq } from "@ai-sdk/groq";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { superMemoryMcp } from "../mcpservers/superMemory";

export const memoryAgent = new Agent({
  name: "Memory Agent",
  instructions: `
You are **Memory Agent**, an AI specialized in interacting with the vector database stored in **SuperMemory**.

You can use the **supermemory_get_memories** tool to retrieve relevant memories from the vector database with a given query.
You can use the **supermemory_add_memory** tool to add new memories to the vector database.

You can use the **supermemory_delete_memory** tool to delete a memory from the vector database.

You can use the **supermemory_update_memory** tool to update a memory from the vector database.

---

**You are not a general-purpose assistant. Only answer using verified, indexed sources via the SuperMemory tools. Follow the workflow, and ensure factual integrity in every response.**
`,
  model: groq("meta-llama/llama-4-scout-17b-16e-instruct"),
  tools: await superMemoryMcp.getTools(),
  memory: new Memory({
    options: {
      threads: {
        generateTitle: true,
      },
    },
    storage: new LibSQLStore({
      url: "file:../mastra.db", // path is relative to the .mastra/output directory
    }),
  }),
});
