import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { LibSQLStore } from "@mastra/libsql";
import { recruitmentPreStageWorkflow } from "./workflows/recruitment-pre-stage-workflow";

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
import {
  getEmailContent,
  getLabelNames,
  gmailSearchEmails,
} from "../utils/gmail";

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
    recruitmentPreStageWorkflow,
    trackReplyMailsWorkflow,
    jobCrawlerWorkflow,
  },
  agents: {
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

// const getCurrentLabels = async () => {
//   try {
//     const gmailClient = await getGmailClient("hi@ocode.co");

//     // for Inbox
//     // const searchInboxInputForSearchingEmails = {
//     //   userId: "me",
//     //   q: `label:INBOX`,
//     //   maxResults: 20,
//     // };
//     // const searchResultOfSearchedMails = await gmailSearchEmails(searchInboxInputForSearchingEmails);

//     // const inboxMails = [];

//     // for (let mail of searchResultOfSearchedMails) {
//     //   if(!mail.id) continue;
//     //   const data = await getEmailContent(mail.id);

//     //   if(!data) continue;

//     //   const mailContent = {
//     //     from : data?.payload?.headers?.find((h) => h.name && h.name.toLowerCase() === "from")?.value,
//     //     subject : data?.payload?.headers?.find((h) => h.name && h.name.toLowerCase() === "subject")?.value,
//     //     snippet : data?.snippet
//     //   }

//     //   inboxMails.push(mailContent);
//     // }

//     // console.table(inboxMails);

//     //     for Labels
//     // const {
//     //   data: { labels: res },
//     // } = await gmailClient.users.labels.list({
//     //   userId: "me",
//     // });

//     // console.table(res);

//     //     for sent mails
//     const searchInboxInput = {
//       userId: "me",
//       q: `label:SENT`,
//       maxResults: 20,
//     };
//     const searchResult = await gmailSearchEmails(searchInboxInput);
//     console.log("mails sent count", searchResult.length);
//     for (let mail of searchResult) {
//       if (!mail.id) continue;
//       const data = await getEmailContent(mail.id);

//       const parsedData = {
//         labels: await getLabelNames(data?.labelIds || []),
//         snippet: data?.snippet,
//         bcc: data.payload?.headers?.find(
//           (h) => h.name && h.name.toLowerCase() === "bcc"
//         )?.value,
//         subject: data?.payload?.headers?.find(
//           (h) => h.name && h.name.toLowerCase() === "subject"
//         )?.value,
//       };

//       console.table(parsedData);
//     }

//     // for label specific mails

//     // const searchInboxInputForSearchingEmails = {
//     //   userId: "me",
//     //   q: `label:Label_12 label:Label_13`,
//     //   maxResults: 20,
//     // };
//     // const searchResultOfSearchedMails = await gmailSearchEmails(
//     //   searchInboxInputForSearchingEmails
//     // );

//     // const inboxMails = [];

//     // for (let mail of searchResultOfSearchedMails) {
//     //   if (!mail.id) continue;
//     //   const data = await getEmailContent(mail.id);

//     //   if (!data) continue;

//     //   const mailContent = {
//     //     from: data?.payload?.headers?.find(
//     //       (h) => h.name && h.name.toLowerCase() === "from"
//     //     )?.value,
//     //     subject: data?.payload?.headers?.find(
//     //       (h) => h.name && h.name.toLowerCase() === "subject"
//     //     )?.value,
//     //     snippet: data?.snippet,
//     //   };

//     //   inboxMails.push(mailContent);
//     // }

//     // console.table(inboxMails);

//     // console.log("label names", await getLabelNames(["Label_16", "Label_17"]));

//     // to delete labels
//     // for (let labelId of ["Label_14", "Label_15", "Label_17"]) {
//     //   try {
//     //     const deleteResp = await gmailClient.users.labels.delete({
//     //       userId: "me",
//     //       id: labelId,
//     //     });
//     //     console.log("label deleted", deleteResp);
//     //   } catch (err) {
//     //     console.log("Error deleting label", labelId, err);
//     //   }
//     // }

//   } catch (error) {
//     throw error;
//   }
// };

// getCurrentLabels();

cron.schedule("0 */1 * * *", () => {
  console.log(" Executing recruitment workflows...");

  const workflowIds = [
    "recruitmentPreStageWorkflow",
    "trackReplyMailsWorkflow",
  ];

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
