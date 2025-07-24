import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { LibSQLStore } from "@mastra/libsql";
import { weatherWorkflow } from "./workflows/weather-workflow";
import { gmailGroqAgent, gmailMetaAgent } from "./agents/gmail-agent";
import { recruitmentWorkflow } from "./workflows/recruitment-workflow";
import { recruitAgentWorkflow } from "./workflows/recruit-agent-workflow";
import { recruitWorkflow } from "./workflows/recruit-workflow";
import { recruitWorkflowV2 } from "./workflows/recruit-workflowV2";
import { recruitWorkflowV3 } from "./workflows/recruit-workflowV3";

import express from "express";
import cron from "node-cron";
import { trackReplyMailsWorkflow } from "./workflows/track-reply-mails-workflow";
import { contextQAAgent } from "./agents/contextQA-agent";
import { webCrawlerAgent } from "./agents/webCrawler-agent";
import { ragAgent } from "./agents/rag-Agent";
import { jobCrawlerWorkflow } from "./workflows/job-crawler-workflow";

const app = express();
const port = process.env.NODE_PORT || 5000;

export const mastra = new Mastra({
  workflows: {
    weatherWorkflow,
    recruitmentWorkflow,
    recruitAgentWorkflow,
    recruitWorkflow,
    recruitWorkflowV2,

    // current recruit workflow
    recruitWorkflowV3,
    trackReplyMailsWorkflow,
    jobCrawlerWorkflow
  },
  agents: { gmailMetaAgent, gmailGroqAgent, contextQAAgent, 
    webCrawlerAgent, ragAgent
   },
  storage: new LibSQLStore({
    // stores telemetry, evals, ... into memory storage, if it needs to persist, change to file:../mastra.db
    url: "file:../mastra.db",
  }),
  logger: new PinoLogger({
    name: "Mastra",
    level: "info",
  }),
});

app.get("/", (req, res) => {
  res.send("server is up and running");
});

const executeWorkflow = async (workflowId: string) => {
  if (!workflowId) return;
  try {
    const res = await fetch(
      `http://localhost:4111/api/workflows/${workflowId}/start-async`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputData: true,
        }),
      }
    );

    console.log(
      "Successfully sent signal to start the workflow:",
      res.status,
      res.statusText
    );
  } catch (error) {
    console.error("Error sending signal to start the workflow:", error);
    return Promise.reject(error);
  }
};

cron.schedule("0 */2 * * *", () => {
  console.log(" Executing recruitment workflows...");

  const workflowIds = ["recruitWorkflowV3", "trackReplyMailsWorkflow"];

  Promise.allSettled(
    workflowIds.map((workflowId) => executeWorkflow(workflowId))
  )
    .then((results) => {
      const errors = results.filter((result) => result.status === "rejected");
      if (errors.length > 0) {
        throw new Error(
          `Errors executing workflows: ${errors.map((error) => error.reason.message).join(", ")}`
        );
      }
    })
    .catch((error) => console.error("Error executing workflows:", error));
});

app.listen(port, () => {
  console.log(`express server listening on port ${port}`);
});
