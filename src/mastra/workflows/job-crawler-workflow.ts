import { createStep, createWorkflow } from "@mastra/core";

import * as fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import z from "zod";
const JobOpeningSchema = z
  .object({
    position: z.string(),
    category: z.string(),
    type: z.string(),
    schedule: z.string(),
    location: z.string(),
    salaryRange: z.string(),
    description: z.string(),
    keyResponsibilites: z.array(z.string()),
    requirements: z.array(z.string()),
    qualifications: z.array(z.string()),
    experienceRequired: z.string(),
  })
  .nullable()
  .describe("Job opening details");

/*
  dummy json for testing

{
  "position": "Software Engineer",
  "category": "Technology",
  "type": "Full-time",
  "schedule": "Regular",
  "location": "Remote",
  "salaryRange": "100000-150000",
  "description": "We are looking for a skilled software engineer to join our team. The ideal candidate will have a strong background in computer science and software engineering principles.",
  "keyResponsibilites": [
    "Design, develop, test, deploy, maintain and improve software",
    "Collaborate with cross-functional teams to identify and prioritize project requirements",
    "Troubleshoot and resolve complex technical issues",
    "Develop and maintain technical documentation",
    "Participate in code reviews and contribute to the improvement of the overall code quality"
  ],
  "requirements": [
    "Bachelor's degree in Computer Science or related field",
    "5+ years of experience in software development",
    "Experience with distributed systems, cloud computing and containerization",
    "Strong understanding of computer science fundamentals (data structures, algorithms, software design patterns)",
    "Experience with Agile development methodologies",
    "Strong communication and collaboration skills",
    "Experience with AWS or Google Cloud"
  ],
  "qualifications": [
    "Experience with Kubernetes",
    "Experience with serverless computing",
    "Experience with CI/CD pipelines",
    "Strong understanding of security best practices",
    "Experience with containerization using Docker"
  ],
  "experienceRequired": "5-10"
}
  */

const jobCrawlTrigger = createStep({
  id: "job-crawl-trigger",
  description: "Triggers the workflow when new job openings are found",
  inputSchema: JobOpeningSchema,
  outputSchema: JobOpeningSchema,
  execute: async ({ inputData }) => {
    if (!inputData) {
      console.error("No job opening data found");
      return null;
    }

    try {
      const jobOpeningParseResult =
        JobOpeningSchema.safeParse(inputData).success;

      if (!jobOpeningParseResult) {
        console.error("Invalid job opening data");
        return null;
      }

      return inputData;
    } catch (err) {
      console.log(err);
      return null;
    }
  },
});

const indexJobOpening = createStep({
  id: "index-job-opening",
  description: "Indexes the job opening",
  inputSchema: JobOpeningSchema,
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData, mastra }) => {
    if (!inputData) {
      console.log("No input data found for indexJobOpening step");
      return "No input data found";
    }
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const jobOpeningsDir = path.resolve(
      __dirname,
      "../../src/mastra/job-openings"
    );
    const filePath = path.join(jobOpeningsDir, `jobOpening-${Date.now()}.json`);

    try {
      if (!fs.existsSync(jobOpeningsDir)) {
        fs.mkdirSync(jobOpeningsDir);
      }

      fs.writeFileSync(filePath, JSON.stringify(inputData));

      const contextQAAgent = mastra?.getAgent("contextQAAgent");

      if (!contextQAAgent) throw Error("RAG agent not found");

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

        const indexResult = await contextQAAgent.generate(
          `Index file at path ${filePath}`,
          {
            instructions,
            maxSteps: 5,
            maxTokens: 400,
          }
        );
        console.log("Indexing completed:", indexResult.text);

        return indexResult.text;
      } catch (error) {
        console.error("Error during RAG indexing:", error);
        return "Error during RAG indexing";
      }
    } catch (error) {
      console.error("Error occured while indexing the job opening:", error);
      return "Error occured while indexing the job opening";
    }
  },
});

const jobCrawlerWorkflow = createWorkflow({
  id: "job-crawler-workflow",
  description:
    "Workflow to handle job descriptions scraping and document embedding to the index",
  inputSchema: JobOpeningSchema,
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  steps: [jobCrawlTrigger],
  retryConfig: {
    attempts: 5,
    delay: 5000,
  },
})
  .then(jobCrawlTrigger)
  .then(indexJobOpening);

jobCrawlerWorkflow.commit();

export { jobCrawlerWorkflow };
