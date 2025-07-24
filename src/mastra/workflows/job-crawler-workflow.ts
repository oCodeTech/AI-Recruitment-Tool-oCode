import { createStep, createWorkflow } from "@mastra/core";
import z from "zod";

import { redis } from "../../queue/connection";

const AgentTrigger = createStep({
  id: "agent-trigger",
  description:
    "Triggers the agent when new reply mails arrive to handle recruitment tasks",
  inputSchema: z.object({ url: z.string() }).describe("Job Opening URL"),
  outputSchema: z.string(),
  execute: async ({ inputData }) => {
    if (!inputData) {
      console.error("No signal found for agent-trigger step");
      return "";
    }

    return "";
  },
});

const jobCrawlerWorkflow = createWorkflow({
  id: "job-crawler-workflow",
  description:
    "Workflow to handle job descriptions scraping and document embedding to the index",
  inputSchema: z.object({ url: z.string() }).describe("Job Opening URL"),
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  steps: [AgentTrigger],
  retryConfig: {
    attempts: 5,
    delay: 5000,
  },
}).then(AgentTrigger);

jobCrawlerWorkflow.commit();

export { jobCrawlerWorkflow };
