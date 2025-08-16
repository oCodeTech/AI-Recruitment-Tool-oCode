import { Request, Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import * as fs from "fs";
import z from "zod";
import { mastra } from "..";

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
  const jobId = req.query.jobId;
  if (jobId && typeof jobId === "string" && jobId.trim() !== "") {
    try {
      const jobOpening = fs.readFileSync(
        path.join(jobOpeningsDir, `${jobId}.json`),
        "utf-8"
      );
      const parsedJobOpening = JSON.parse(jobOpening);
      res.json(parsedJobOpening);
      return;
    } catch (err) {
      console.log(err);
      res.json({ error: "Error occured while fetching job opening" });
      return;
    }
  }

  try {
    const jobOpenings = fs.readdirSync(jobOpeningsDir);

    const jobOpeningsWithMetaData = jobOpenings
      .map((jobOpening) => {
        try {
          const jobOpeningWithMetaData = JSON.parse(
            fs.readFileSync(path.join(jobOpeningsDir, jobOpening), "utf-8")
          );
          delete jobOpeningWithMetaData.metadata.documentType;
          delete jobOpeningWithMetaData.metadata.containsJobOpening;
          delete jobOpeningWithMetaData.metadata.domain;
          delete jobOpeningWithMetaData.metadata.description;
          delete jobOpeningWithMetaData.metadata.relatedFields;
          delete jobOpeningWithMetaData.metadata.keywords;
          delete jobOpeningWithMetaData.metadata.summary;

          return jobOpeningWithMetaData;
        } catch (error) {
          console.log(
            `Error parsing job opening file: ${jobOpening}. Error: ${error}`
          );
          return null;
        }
      })
      .filter((jobOpening) => jobOpening);

    res.json(jobOpeningsWithMetaData);
  } catch (error) {
    console.log(error);
    res.json({ error: "Error occured while fetching job openings" });
  }
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

    const filePath = path.join(jobOpeningsDir, `jobOpening-${Date.now()}.json`);

    const jobOpeningWithMetaData = {
      ...jobOpeningData,
      metadata: {
        filePath: filePath,
        documentType: "jobOpening",
        containsJobOpening: true,
        domain: "employment",
        description:
          "This document contains detailed information about a job opening.",
        relatedFields: [
          "position",
          "category",
          "type",
          "schedule",
          "location",
          "salaryRange",
          "description",
          "keyResponsibilities",
          "requirements",
          "qualifications",
          "experienceRequired",
        ],
        keywords: [
          "job opening",
          "employment",
          "vacancy",
          "hiring",
          "recruitment",
          "career opportunity",
          jobOpeningData.position,
          jobOpeningData.category,
          jobOpeningData.location,
        ],
        summary: `Job opening for ${jobOpeningData.position} in ${jobOpeningData.location}.`,
      },
    };

    try {
      if (!fs.existsSync(jobOpeningsDir)) {
        fs.mkdirSync(jobOpeningsDir);
      }

      fs.writeFileSync(filePath, JSON.stringify(jobOpeningWithMetaData));

      const ragAgent = mastra?.getAgent("ragAgent");

      if (!ragAgent) throw Error("RAG agent not found");

      console.log("job opening file created at path:", filePath);

      try {
        const supportedFileTypes = [".json", ".jsonl", ".txt", ".md", ".csv"];
        const fileExtension = filePath
          .slice(filePath.lastIndexOf("."))
          .toLowerCase();

        if (!supportedFileTypes.includes(fileExtension)) {
          throw new Error(
            `Unsupported file type: ${fileExtension}. Supported types: ${supportedFileTypes.join(", ")}`
          );
        }

        const instructions = [
          `Read the file at path: ${filePath}.`,
          `Embed its content for RAG and store the result in the database.`,
          `The file type is ${fileExtension}.`,
        ].join(" ");

        const indexResult = await ragAgent.generate(
          `Index file at path ${filePath}`,
          {
            instructions,
            maxSteps: 5,
            maxTokens: 400,
          }
        );
        console.log("Indexing completed:", indexResult.text);
        res.status(200).json({ message: indexResult.text });
        return;
      } catch (error) {
        console.error("Error during RAG indexing:", error);
        res.status(500).json({ error: "Error during RAG indexing" });
        return;
      }
    } catch (error) {
      console.error("Error occured while indexing the job opening:", error);
      res
        .status(500)
        .json({ error: "Error occured while indexing the job opening" });
      return;
    }
  } catch (err) {
    console.log(err);
    res
      .status(500)
      .json({ error: "Error occured while indexing the job opening" });
    return;
  }
}

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
}