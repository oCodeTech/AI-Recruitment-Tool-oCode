import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { LibSQLStore } from "@mastra/libsql";
import { weatherWorkflow } from "./workflows/weather-workflow";
import { gmailGroqAgent, gmailMetaAgent } from "./agents/gmail-agent";
import { recruitmentWorkflow } from "./workflows/recruitment-workflow";
import { recruitAgentWorkflow } from "./workflows/recruit-agent-workflow";
import { recruitWorkflow } from "./workflows/recruit-workflow";
import { recruitWorkflowV2 } from "./workflows/recruit-workflowV2";
import {
  executeRecruitWorkflow,
  recruitWorkflowV3,
} from "./workflows/recruit-workflowV3";

import express from "express";
import cron from "node-cron";

const app = express();
const port = process.env.NODE_PORT || 3000;

export const mastra = new Mastra({
  workflows: {
    weatherWorkflow,
    recruitmentWorkflow,
    recruitAgentWorkflow,
    recruitWorkflow,
    recruitWorkflowV2,
    recruitWorkflowV3,
  },
  agents: { gmailMetaAgent, gmailGroqAgent },
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

cron.schedule("0 */2 * * * *", () => {
  console.log("🔄 Executing recruitment workflow...");
  executeRecruitWorkflow().catch(console.error);
});

app.listen(port, () => {
  console.log(`express server listening on port ${port}`);
});
