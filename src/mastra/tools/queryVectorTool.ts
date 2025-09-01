import { createTool } from "@mastra/core";
import z from "zod";
import { vectorStore } from "../../vectorDB/connection";

export const queryVectorTool = createTool({
  id: "query-vector",
  description:
    "Queries the vector database to retrieve relevant vectors for a given query. This tool is used to implement Retrieval-Augmented Generation (RAG) tasks.",
  inputSchema: z.object({
    query: z
      .string()
      .describe("The query to search for in the vector database."),
    limit: z
      .number()
      .default(5)
      .describe("The maximum number of results to return. Default is 5."),
  }),
  execute: async ({ context: { query, limit } }) => {
    if (!query) {
      throw new Error("No query provided");
    }

    try {
      const response = await fetch("http://localhost:11434/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "nomic-embed-text",
          input: query,
        }),
      });

      if (!response.ok) {
        throw new Error(`Error: ${response.statusText}`);
      }

      const { embeddings } = await response.json();

      const results = await vectorStore.query({
        indexName: "job-openings",
        queryVector: embeddings[0],
        topK: limit,
      });
      return results;
    } catch (err) {
      console.log("Error searching for job opening:", err);
      return [];
    }
  },
});
