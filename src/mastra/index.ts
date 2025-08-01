import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { LibSQLStore } from "@mastra/libsql";
import { gmailGroqAgent } from "./agents/gmail-agent";
import { decodeEmailBody, recruitWorkflowV3 } from "./workflows/recruit-workflowV3";

import { trackReplyMailsWorkflow } from "./workflows/track-reply-mails-workflow";
import { contextQAAgent } from "./agents/contextQA-agent";
import { webCrawlerAgent } from "./agents/webCrawler-agent";
import { jobCrawlerWorkflow } from "./workflows/job-crawler-workflow";

import express from "express";
import cors from "cors";
import cron from "node-cron";
import jobOpeningsRoutes from "./routes/jobOpeningsRoutes";
import { ragAgent } from "./agents/rag-agent";
import { getGmailClient } from "../OAuth/getGmailClient";

const app = express();
const port = process.env.NODE_PORT || 5000;

app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN,
  })
);

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

export const mastra = new Mastra({
  workflows: {
    // current recruit workflow
    recruitWorkflowV3,
    trackReplyMailsWorkflow,
    jobCrawlerWorkflow,
  },
  agents: {
    gmailGroqAgent,
    ragAgent,
    contextQAAgent,
    webCrawlerAgent,
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

app.use("/api/jobopenings", jobOpeningsRoutes);

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

const gmailSearchEmails = async (searchProps: {
  userId?: string;
  q: string;
  labelIds?: string[];
  maxResults?: number;
}) => {
  try {
    const gmailClient = await getGmailClient("hi@ocode.co");

    const res = await gmailClient.users.messages.list({
      userId: "me",
      labelIds: ["INBOX"],
      ...searchProps,
    });

    const latestEmails = res.data.messages || [];

    const fullMessages = await Promise.all(
      latestEmails.map(async (message) => {
        const email = await gmailClient.users.messages.get({
          userId: "me",
          id: message.id || "",
        });

        const parsedEmailData = {
          from: email.data.payload?.headers
            ?.find((header) => header.name === "From")
            ?.value?.trim(),
          subject: email.data.payload?.headers
            ?.find((header) => header.name === "Subject")
            ?.value?.trim(),
          snippet: email.data.snippet?.trim(),
          date: email.data.payload?.headers
            ?.find((header) => header.name === "Date")
            ?.value?.trim(),
        };

        return parsedEmailData;
      })
    );

    console.table(fullMessages);
  } catch (error) {
    throw error;
  }
};
const searchInboxInput = {
  userId: "me",
  q: `label:inbox from:consulting@ocode.co`,
  maxResults: 1000,
};

gmailSearchEmails(searchInboxInput);

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
