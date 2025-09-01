import { Request, Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import * as fs from "fs";
import z from "zod";
import { mastra } from "..";
import { MDocument } from "@mastra/rag";
import crypto from "crypto";
import { vectorStore } from "../../vectorDB/connection";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jobOpeningsDir = path.resolve(__dirname, "../../src/mastra/job-openings");

const JobOpeningSchema = z
  .object({
    position: z.string(),
    category: z.string(),
    type: z.string(),
    schedule: z.string(),
    location: z.string(),
    salaryRange: z.string(),
    description: z.string(),
    keyResponsibilities: z.array(z.string()),
    requirements: z.array(z.string()),
    qualifications: z.array(z.string()).optional(),
    experienceRequired: z.string(),
  })
  .describe("Job opening details");

export const getJobOpenings = async (req: Request, res: Response) => {
  const jobQuery = req.query.jobQuery;
  console.log("jobQuery", jobQuery);
  if (jobQuery && typeof jobQuery === "string" && jobQuery.trim() !== "") {
    try {
      const response = await fetch("http://localhost:11434/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "nomic-embed-text",
          input: jobQuery,
        }),
      });

      if (!response.ok) {
        throw new Error(`Error: ${response.statusText}`);
      }

      const { embeddings } = await response.json();

      const results = await vectorStore.query({
        indexName: "job-openings",
        queryVector: embeddings[0],
        topK: 3,
      });

      console.log("results", results);

      return res.json(results);
    } catch (err) {
      console.log("Error searching for job opening:", err);
      return res.status(500).json({ error: "Error searching for job opening" });
    }
  }

  return [];
};

export const createJobOpening = async (req: Request, res: Response) => {
  try {
    const { body: jobOpeningData } = req;

    const jobOpeningParseResult =
      JobOpeningSchema.safeParse(jobOpeningData).success;

    if (!jobOpeningParseResult) {
      console.error("Invalid job opening data");
      res.status(400).json({ error: "Invalid job opening data" });
      return;
    }

    const mDoc = MDocument.fromJSON(JSON.stringify(jobOpeningData));

    const jsonHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(jobOpeningData))
      .digest("hex");

    const chunks = await mDoc.chunk({
      strategy: "json",
      maxSize: 400,
      convertLists: true,
      stripWhitespace: true,
      keepSeparator: true,
      overlap: 10,
    });

    try {
      const response = await fetch("http://localhost:11434/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "nomic-embed-text",
          input: chunks.map((c) => c.text),
        }),
      });

      if (!response.ok) {
        throw new Error(`Error: ${response.statusText}`);
      }

      const { embeddings } = await response.json();

      const allIndexes = await vectorStore.listIndexes();

      if (!allIndexes.includes("job-openings")) {
        await vectorStore.createIndex({
          indexName: "job-openings",
          dimension: 768,
        });
      }
      const result = await vectorStore.upsert({
        indexName: "job-openings",
        vectors: embeddings,
        metadata: chunks.map((chunk) => ({
          text: chunk.text,
          hash: jsonHash,
          ...jobOpeningData,
        })),
      });

      if (result.length > 0) {
        return res.send("Job opening indexed successfully");
      }
    } catch (e) {
      console.log(e);
      return res.status(500).send("Error indexing job opening");
    }
  } catch (err) {
    console.log(err);
    res
      .status(500)
      .json({ error: "Error occured while indexing the job opening" });
    return;
  }
};

export const deleteJobOpening = async (req: Request, res: Response) => {
  const jobId = req.query.jobId;
  if (jobId && typeof jobId === "string" && jobId.trim() !== "") {
    try {
      const jobOpeningPath = path.join(jobOpeningsDir, `${jobId}.json`);

      const ragAgent = mastra.getAgent("ragAgent");

      if (!ragAgent) throw Error("RAG agent not found");

      await ragAgent.generate(
        `Verify the document at path ${jobOpeningPath} exists in the RAG index.`,
        {
          instructions: `Use the rag_query_documents tool to confirm the document presence by querying its content.`,
          maxSteps: 5,
          maxTokens: 400,
        }
      );

      const ragRemoveDocumentResult = await ragAgent.generate(
        `Remove the document at path: ${jobOpeningPath} from the RAG index using the rag_remove_document tool.`,
        {
          instructions: `You must use the rag_remove_document tool to remove the document located at: ${jobOpeningPath}. Only use this tool and confirm the removal.`,
          maxSteps: 5,
          maxTokens: 400,
        }
      );
      console.log("RAG remove document result:", ragRemoveDocumentResult.text);

      if (ragRemoveDocumentResult.text) {
        fs.rmSync(jobOpeningPath);
      }
      res.json({ message: "Job opening deleted successfully" });
      return;
    } catch (err) {
      console.log(err);
      res.json({ error: "Error occured while deleting job opening" });
      return;
    }
  }
};
