import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { LibSQLStore } from "@mastra/libsql";
import { recruitmentPreStageWorkflow } from "./workflows/recruitment-pre-stage-workflow";

import { trackReplyMailsWorkflow } from "./workflows/track-reply-mails-workflow";
import { contextQAAgent } from "./agents/contextQA-agent";
import { webCrawlerAgent } from "./agents/webCrawler-agent";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import jobOpeningsRoutes from "./routes/jobOpeningsRoutes";
import { ragAgent } from "./agents/rag-agent";
import { getGmailClient } from "../OAuth/getGmailClient";
import {
  decodeEmailBody,
  getEmailContent,
  getLabelNames,
  getThreadMessages,
  gmailSearchEmails,
} from "../utils/gmail";
import { debugWorkflow } from "./workflows/debug-workflow";
import { recruitmentIndeedPreStageWorkflow } from "./workflows/recruitment-indeed-pre-stage-workflow";
import { memoryAgent } from "./agents/memoryAgent";

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
    recruitmentIndeedPreStageWorkflow,
    trackReplyMailsWorkflow,
    debugWorkflow
  },
  agents: {
    ragAgent,
    contextQAAgent,
    webCrawlerAgent,
    memoryAgent
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

const getCurrentLabels = async () => {
  try {
    //     for Labels
    const gmailClient = await getGmailClient("hi@ocode.co");
    const {
      data: { labels: res },
    } = await gmailClient.users.labels.list({
      userId: "me",
    });

    console.table(res);
  } catch (error) {
    throw error;
  }
};

const getInboxMails = async () => {
  //  for Inbox
  const searchInboxInputForSearchingEmails = {
    userId: "me",
    q: `label:INBOX`,
    maxResults: 20,
  };
  const searchResultOfSearchedMails = await gmailSearchEmails(
    searchInboxInputForSearchingEmails
  );

  const inboxMails: {
    from: string | null | undefined;
    subject: string | null | undefined;
    snippet: string | null | undefined;
    date: string | null | undefined;
  }[] = [];

  for (let mail of searchResultOfSearchedMails) {
    if (!mail.id) continue;
    const data = await getEmailContent(mail.id);

    if (!data) continue;

    const mailContent = {
      from: data?.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "from"
      )?.value,
      subject: data?.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "subject"
      )?.value,
      snippet: data?.snippet,
      date: data?.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "date"
      )?.value,
    };

    inboxMails.push(mailContent);
  }

  console.table(
    inboxMails.sort(
      (a, b) =>
        new Date(b.date || "").getTime() - new Date(a.date || "").getTime()
    )
  );
};

const getSentMails = async () => {
  //     for sent mails
  const searchInboxInput = {
    userId: "me",
    q: `label:SENT`,
    maxResults: 20,
  };
  const searchResult = await gmailSearchEmails(searchInboxInput);
  console.log("mails sent count", searchResult.length);
  for (let mail of searchResult) {
    if (!mail.id) continue;
    const data = await getEmailContent(mail.id);

    const parsedData = {
      labels: await getLabelNames(data?.labelIds || []),
      snippet: data?.snippet,
      bcc: data.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "bcc"
      )?.value,
      subject: data?.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "subject"
      )?.value,
    };

    console.table(parsedData);
  }
};

const getMailsByLabels = async () => {
  // for label specific mails

  const searchInboxInputForSearchingEmails = {
    userId: "me",
    q: `label:Developer OR label:Stage1 Interview OR label:Recruiter OR label:Pre-Stage`,
    maxResults: 20,
  };
  const searchResultOfSearchedMails = await gmailSearchEmails(
    searchInboxInputForSearchingEmails
  );

  const inboxMails: {
    from: string | null | undefined;
    subject: string | null | undefined;
    snippet: string | null | undefined;
  }[] = [];

  for (let mail of searchResultOfSearchedMails) {
    if (!mail.id) continue;
    const data = await getEmailContent(mail.id);

    if (!data) continue;

    const mailContent = {
      from: data?.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "from"
      )?.value,
      subject: data?.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "subject"
      )?.value,
      snippet: data?.snippet,
    };

    inboxMails.push(mailContent);
  }
  console.log("mails count", inboxMails.length);
  console.table(inboxMails);
};

const getLatestMsgByLabels = async () => {
  // for label specific mails with threads latest message

  const searchInboxInputForSearchingThreadEmails = {
    userId: "me",
    q: `label:"Stage1 Interview" OR label:"Pre-Stage"`,
    maxResults: 20,
  };
  const searchResultOfSearchedThreadMails = await gmailSearchEmails(
    searchInboxInputForSearchingThreadEmails
  );

  const inboxThreadMails: {
    from: string | null | undefined;
    subject: string | null | undefined;
    bcc: string | null | undefined;
    body: string | null | undefined;
    // snippet: string | null | undefined;
  }[] = [];

  for (let mail of searchResultOfSearchedThreadMails) {
    if (!mail.id || !mail.threadId) continue;

    const threadMessages = await getThreadMessages(mail.threadId);

    if (!threadMessages || !threadMessages.length) continue;

    const latestThreadMessage = threadMessages[threadMessages.length - 1];

    if (!latestThreadMessage.id) continue;

    const data = await getEmailContent(latestThreadMessage.id);

    if (!data) continue;

    const mailContent = {
      from: data?.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "from"
      )?.value,
      subject: data?.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "subject"
      )?.value,
      bcc: data?.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "bcc"
      )?.value,
      body: decodeEmailBody(
        data.payload?.parts
          ?.find((p) => p.mimeType === "multipart/alternative")
          ?.parts?.find((p2) => p2.mimeType === "text/plain") ||
          data.payload?.parts?.find((p) => p.mimeType === "text/plain")
      ),
      // snippet: data?.snippet,
    };

    inboxThreadMails.push(mailContent);
  }
  console.log("inboxThreadMails", inboxThreadMails.length);
  console.log(inboxThreadMails);
};

const deleteLabels = async () => {
  const gmailClient = await getGmailClient("hi@ocode.co");

  // to delete labels
  for (let labelId of ["Label_14", "Label_15", "Label_17"]) {
    try {
      const deleteResp = await gmailClient.users.labels.delete({
        userId: "me",
        id: labelId,
      });
      console.log("label deleted", deleteResp);
    } catch (err) {
      console.log("Error deleting label", labelId, err);
    }
  }
};

// getLatestMsgByLabels();

cron.schedule("0 */1 * * *", () => {
  console.log(" Executing recruitment workflows...");

  const workflowIds = [
    "recruitmentPreStageWorkflow",
    "recruitmentIndeedPreStageWorkflow",
    // "trackReplyMailsWorkflow",
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
