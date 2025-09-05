import { createStep, createWorkflow } from "@mastra/core";
import z from "zod";
import {
  decodeEmailBody,
  getEmailContent,
  getThreadMessages,
  gmailSearchEmails,
  modifyEmailLabels,
  sendThreadReplyEmail,
} from "../../utils/gmail";
import { redis } from "../../queue/connection";
import { fastParseEmail } from "../../utils/emailUtils";
import * as cheerio from "cheerio";
import { env } from "../../utils/config";

const recruitmentMail = env.RECRUITMENT_MAIL;
const consultingMail = env.CONSULTING_MAIL;

if (!recruitmentMail) {
  throw new Error("RECRUITMENT_MAIL environment variable is not set");
}

if (!consultingMail) {
  throw new Error("CONSULTING_MAIL environment variable is not set");
}

export const extractEmailAndName = (
  emailString: string | null | undefined
): { email: string | null; name: string | null } => {
  if (!emailString) return { email: null, name: null };
  const emailMatch = emailString.match(/<(.+?)>/);
  const name = emailString.split("<")[0].trim()?.split("@")[0];
  const email = emailMatch ? emailMatch[1] : emailString.trim();
  return { email, name };
};

export const extractJsonFromResult = (result: string) => {
  const match = result.match(/\{.*\}/s);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch (e) {
      console.log("Error parsing result:", e);
    }
  }
  return null;
};

const AgentTrigger = createStep({
  id: "agent-trigger",
  description:
    "Triggers the agent when new mails arrive to handle recruitment tasks",
  inputSchema: z.boolean().describe("Signal to start the workflow"),
  outputSchema: z
    .array(
      z.object({
        id: z.string().nullable().optional(),
        threadId: z.string().nullable().optional(),
      })
    )
    .describe("Array of email IDs and thread IDs"),
  execute: async ({ inputData }) => {
    if (!inputData) {
      console.error("No signal found for agent-trigger step");
      return [{ id: "", threadId: "" }];
    }

    const searchInboxInput = {
      userId: "me",
      q: `label:inbox -label:pre-stage`,
      maxResults: 50,
    };

    try {
      const searchResult = await gmailSearchEmails(searchInboxInput);

      return searchResult;
    } catch (err) {
      console.log(err);
      return [{ id: "", threadId: "" }];
    }
  },
});

const deduplicateNewlyArrivedMails = createStep({
  id: "deduplicate-newly-arrived-mails",
  description: "Deduplicates newly arrived emails",
  inputSchema: z
    .object({
      id: z.string().nullable().optional(),
      threadId: z.string().nullable().optional(),
    })
    .describe("Email ID and thread ID to deduplicate"),
  outputSchema: z
    .object({
      id: z.string(),
      threadId: z.string(),
    })
    .nullable()

    .describe("Email ID and thread ID deduplicated"),
  execute: async ({ inputData: { id, threadId } }) => {
    if (!id || !threadId) {
      console.log(
        "Email ID or thread ID not found for deduplicate-newly-arrived-mails step"
      );
      return null;
    }

    try {
      const alreadyProcessed = await redis.get(`processed_email:${id}`);
      if (alreadyProcessed) {
        console.log(`Email ID ${id} already processed, skipping`);
        return null;
      }

      await redis.set(`processed_email:${id}`, "1", "EX", 3600);
      return {
        id,
        threadId,
      };
    } catch (err) {
      console.log(err);
      return null;
    }
  },
});

const ExtractEmailMetaDataOutput = z
  .object({
    id: z.string(),
    messageId: z.string(),
    threadId: z.string(),
    userEmail: z.string().nullable(),
    name: z.string().nullable(),
    subject: z.string().nullable(),
    body: z.string().nullable(),
    resume: z.string().nullable(),
    hasResume: z.boolean(),
    position: z.string().nullable(),
    category: z.string().nullable(),
    experienceStatus: z.string().nullable(),
  })
  .nullable()
  .describe("Extracted email metadata");

const extractEmailMetaData = createStep({
  id: "extract-email-meta-data",
  description: "Extracts email metadata by email ID and thread ID",
  // for development
  // inputSchema: z.object({
  //   id: z.string().nullable().optional(),
  //   threadId: z.string().nullable().optional(),
  // }),
  // for production
  inputSchema: z
    .object({
      id: z.string(),
      threadId: z.string(),
    })
    .nullable()
    .describe("Email ID and thread ID to extract metadata"),
  outputSchema: ExtractEmailMetaDataOutput,
  execute: async ({ inputData, mastra }) => {
    if (!inputData || Object.values(inputData).some((v) => !v || !v.trim())) {
      console.log(
        "Email ID or thread ID not found for extract-email-meta-data step",
        inputData
      );
      return null;
    }

    try {
      const { id, threadId } = inputData;

      if (!id || !threadId) {
        console.log(
          "Email ID or thread ID not found for extract-email-meta-data step"
        );
        return null;
      }

      const threadMessages = await getThreadMessages(threadId);

      if (threadMessages && threadMessages.length > 1) {
        console.log(
          "Thread has more than one message, skipping",
          threadMessages.length
        );
        return null;
      }

      const email = await getEmailContent(id!);

      const messageId = email.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "message-id"
      )?.value;

      const userAddress = email.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "from"
      )?.value;

      const replyToAddress = email.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "reply-to"
      )?.value;

      const plainTextPart =
        email.payload?.parts
          ?.find((p) => p.mimeType === "multipart/alternative")
          ?.parts?.find((p2) => p2.mimeType === "text/plain") ||
        email.payload?.parts?.find((p) => p.mimeType === "text/plain");

      const htmlPart =
        email.payload?.parts
          ?.find((p) => p.mimeType === "multipart/alternative")
          ?.parts?.find((p2) => p2.mimeType === "text/html") ||
        email.payload?.parts?.find((p) => p.mimeType === "text/html");

      const decodedBody = decodeEmailBody(plainTextPart);
      const decodedHtmlBody = decodeEmailBody(htmlPart);

      const $ = cheerio.load(decodedHtmlBody);

      // Find all anchor tags and filter based on text
      const resumeLink =
        $("a")
          .filter(
            (i, el) => $(el).text().trim().toLowerCase() === "view resume"
          )
          .attr("href") ?? null;

      const username = decodedBody
        .split("Name:")
        .splice(1)
        .join(" ")
        .split("\n")[0];

      const { email: userEmail, name } =
        userAddress?.includes(consultingMail) && replyToAddress
          ? extractEmailAndName(replyToAddress)
          : extractEmailAndName(userAddress);

      if (!userEmail?.includes("@indeedemail.com")) {
        console.log("Email is not from Indeed, skipping", userEmail);
        return null;
      }

      const subject = email.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "subject"
      )?.value;

      const relevantSubjectKeywords = [
        "application received",
        "new application received",
        "new application for",
        "application for",
        "Applying for",
        "job application",
        "job candidate",
        "applied for",
        "resume",
        "cv",
        "profile",
        "hiring",
        "interview",
        "interested in",
        "candidate for",
        "looking for job",
        "seeking opportunity",
      ];

      const irrelevantSubjectKeywords = [
        "unsubscribe",
        "newsletter",
        "promotion",
        "discount",
        "offer",
        "sale",
        "buy now",
        "thank you for subscribing",
        "follow us",
        "follow up",
        "follow-up",
        "webinar",
        "event invite",
        "no-reply",
        "notification",
        "account",
        "password",
        "invoice",
        "receipt",
      ];

      const relevantSubject =
        relevantSubjectKeywords.some((keyword) =>
          subject?.toLowerCase().includes(keyword.toLowerCase())
        ) &&
        !irrelevantSubjectKeywords.some((keyword) =>
          subject?.toLowerCase().includes(keyword.toLowerCase())
        );

      if (!relevantSubject) {
        console.log("Subject not related to recruitment, skipping", subject);
        return null;
      }

      const emailMetaData = {
        id: id || email.id || "",
        messageId: messageId || "",
        threadId: threadId || email.threadId || "",
        userEmail: userEmail ?? null,
        name: username && username !== "" ? username : (name ?? null),
        subject: subject ?? null,
        body: decodedBody ?? null,
        resume: resumeLink,
      };

      const hasResume = resumeLink ? true : false;

      const potentialJobTitle = subject
        ? subject.split("New application for")[1].split(",")[0].trim()
        : null;

      let potentialCategory = "unclear";

      //   if (experiencePatterns.some((pattern) => pattern.test(resumeText))) {
      //     potientialExperienceStatus = "experienced";
      //   } else if (fresherPatterns.some((pattern) => pattern.test(resumeText))) {
      //     potientialExperienceStatus = "fresher";
      //   }

      const categoryKeywords = {
        Recruiter: ["recruiter", "hr", "talent acquisition", "it recruitment"],
        Developer: [
          "developer",
          "engineer",
          "programmer",
          "flutter",
          "react",
          "react js",
          "backend",
          "frontend",
          "full.stack",
          "node",
          "laravel",
          "php",
          "mobile",
          "app",
          "software",
          "javascript",
          "js",
          "python",
          "devops",
        ],
        "Web Designer": ["designer", "ui/ux", "web design"],
        "Sales/Marketing": ["sales", "marketing", "business development"],
      };

      for (const [cat, keywords] of Object.entries(categoryKeywords)) {
        if (keywords.some((k) => potentialJobTitle ?? "".toLowerCase().includes(k))) {
          potentialCategory = cat;
          break;
        }
      }

      const fastResult = fastParseEmail(subject ?? "", decodedBody);

      return {
        ...emailMetaData,
        hasResume,
        position:
          fastResult?.job_title.trim() ?? potentialJobTitle ?? "unclear",
        category: fastResult?.category ?? potentialCategory ?? "unclear",
        experienceStatus: fastResult?.experience_status || "unclear",
      };
    } catch (err) {
      console.log("Error occured while extracting details from email", err);
      return null;
    }
  },
});

const SortEmailDataInput = z.array(ExtractEmailMetaDataOutput);
const SortEmailDataOutput = z.object({
  multipleMissingDetailsEmails: z.array(ExtractEmailMetaDataOutput),
  missingResumeEmails: z.array(ExtractEmailMetaDataOutput),
  unclearPositionEmails: z.array(ExtractEmailMetaDataOutput),
  confirmEmails: z.array(ExtractEmailMetaDataOutput),
});

type SortEmailDataOutput = z.infer<typeof SortEmailDataOutput>;

const sortEmailData = createStep({
  id: "sort-email-data",
  inputSchema: SortEmailDataInput,
  outputSchema: SortEmailDataOutput,
  description:
    "Sorts the processed emails meta data into two arrays: rejectEmails and confirmEmails based on resumeStatus, coverLetterStatus and position",
  execute: async ({ inputData }) => {
    if (!inputData || inputData.length === 0) {
      return SortEmailDataOutput.parse({
        multipleMissingDetailsEmails: [],
        missingResumeEmails: [],

        unclearPositionEmails: [],
        confirmEmails: [],
      });
    }

    const missingResumeEmails: typeof inputData = [];

    const unclearPositionEmails: typeof inputData = [];
    const multipleMissingDetailsEmails: typeof inputData = [];
    const confirmEmails: typeof inputData = [];

    inputData.forEach((email) => {
      if (!email) {
        return;
      }
      const missingResume = !email.hasResume;
      const unclearPosition = !email.position || email.position === "unclear";
      const missingDetailsCount = [missingResume, unclearPosition].filter(
        Boolean
      ).length;

      if (missingDetailsCount > 1) {
        multipleMissingDetailsEmails.push(email);
      } else if (missingResume) {
        missingResumeEmails.push(email);
      } else if (unclearPosition) {
        unclearPositionEmails.push(email);
      } else {
        confirmEmails.push(email);
      }
    });

    return SortEmailDataOutput.parse({
      multipleMissingDetailsEmails,
      missingResumeEmails,

      unclearPositionEmails,
      confirmEmails,
    });
  },
});

const sendMultipleRejectionReasonsMail = createStep({
  id: "send-multiple-rejection-reasons-email",
  description:
    "Sends rejection email to candidate with multiple missing details",
  inputSchema: SortEmailDataOutput,
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData: { multipleMissingDetailsEmails } }) => {
    if (
      !multipleMissingDetailsEmails ||
      multipleMissingDetailsEmails.length === 0
    ) {
      console.log(
        "No rejected email data found for sendMultipleRejectionReasonsMail step"
      );
      return "No rejected email data found";
    }

    for (let mail of multipleMissingDetailsEmails) {
      if (!mail || !mail.userEmail) {
        continue;
      }

      await sendThreadReplyEmail({
        name: mail.name || "",
        position: mail.position || "unclear",
        userEmail: mail.userEmail,
        subject: mail.subject,
        threadId: mail.threadId,
        emailId: mail.id,
        inReplyTo: mail.messageId,
        references: [mail.messageId],
        templateId: "templates-rejection-missing_multiple_details",
        addLabelIds: ["Pre-Stage"],
      });
    }

    return "Resume missing emails sent successfully";
  },
});
const sendResumeMissingMail = createStep({
  id: "send-resume-missing-email",
  description: "Sends rejection email to candidate for missing resume",
  inputSchema: SortEmailDataOutput,
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData: { missingResumeEmails } }) => {
    if (!missingResumeEmails || missingResumeEmails.length === 0) {
      console.log(
        "No rejected email data found for sendResumeMissingMail step"
      );
      return "No rejected email data found";
    }

    for (let mail of missingResumeEmails) {
      if (!mail || !mail.userEmail) {
        continue;
      }

      await sendThreadReplyEmail({
        name: mail.name || "",
        position: mail.position || "unclear",
        userEmail: mail.userEmail,
        subject: mail.subject,
        threadId: mail.threadId,
        emailId: mail.id,
        inReplyTo: mail.messageId,
        references: [mail.messageId],
        templateId: "templates-rejection-no_resume",
        addLabelIds: ["Pre-Stage"],
      });
    }

    return "Resume missing emails sent successfully";
  },
});

const sendUnclearPositionEmail = createStep({
  id: "send-unclear-position-email",
  description: "Sends rejection email to candidate for unclear job position",
  inputSchema: SortEmailDataOutput,
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData: { unclearPositionEmails } }) => {
    if (!unclearPositionEmails || unclearPositionEmails.length === 0) {
      console.log(
        "No rejected email data found for sendUnclearPositionEmail step"
      );
      return "No rejected email data found";
    }

    for (let mail of unclearPositionEmails) {
      if (!mail || !mail.userEmail) {
        continue;
      }

      await sendThreadReplyEmail({
        name: mail.name || "",
        position: mail.position || "unclear",
        userEmail: mail.userEmail,
        subject: mail.subject,
        threadId: mail.threadId,
        emailId: mail.id,
        inReplyTo: mail.messageId,
        references: [mail.messageId],
        templateId: "templates-rejection-no_clear_job_position",
        addLabelIds: ["Pre-Stage", "Unclear Applications"],
      });
    }

    return "Unclear position emails sent successfully";
  },
});

const sendConfirmationEmail = createStep({
  id: "send-confirmation-email",
  description: "Sends confirmation email to candidate",
  inputSchema: SortEmailDataOutput,
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData: { confirmEmails } }) => {
    if (!confirmEmails || confirmEmails.length === 0) {
      console.log(
        "No confirmed email data found for sendConfirmationEmail step"
      );
      return "No confirmed email data found";
    }

    for (let mail of confirmEmails) {
      if (!mail || !mail.userEmail) {
        continue;
      }

      const applicationCategory =
        mail.category !== "unclear" && mail.category
          ? mail.category
          : "Unclear Applications";

      switch (mail.category) {
        case "Developer":
          const templateId =
            mail.experienceStatus === "experienced" ||
            mail.experienceStatus === "unclear"
              ? "templates-request_key_details-developer-experienced"
              : mail.experienceStatus === "fresher"
                ? "templates-request_key_details-developer-fresher"
                : null;

          if (!templateId || applicationCategory === "Unclear Applications") {
            await modifyEmailLabels({
              emailId: mail.id,
              addLabelIds: ["Unclear Applications", "Pre-Stage"],
            });
            continue;
          }

          await sendThreadReplyEmail({
            name: mail.name || "",
            position: mail.position || "unclear",
            userEmail: mail.userEmail,
            subject: mail.subject,
            threadId: mail.threadId,
            emailId: mail.id,
            inReplyTo: mail.messageId,
            references: [mail.messageId],
            templateId: templateId,
            addLabelIds: [applicationCategory, "Stage1 Interview"],
            removeLabelIds: ["Pre-Stage"],
          });

          break;

        case "Recruiter":
          await sendThreadReplyEmail({
            name: mail.name || "",
            position: mail.position || "unclear",
            userEmail: mail.userEmail,
            subject: mail.subject,
            threadId: mail.threadId,
            emailId: mail.id,
            inReplyTo: mail.messageId,
            references: [mail.messageId],
            templateId: "templates-request_key_details-non-tech",
            addLabelIds: [applicationCategory, "Stage1 Interview"],
            removeLabelIds: ["Pre-Stage"],
          });
          break;

        case "Sales / Marketing":
          await sendThreadReplyEmail({
            name: mail.name || "",
            position: mail.position || "unclear",
            userEmail: mail.userEmail,
            subject: mail.subject,
            threadId: mail.threadId,
            emailId: mail.id,
            inReplyTo: mail.messageId,
            references: [mail.messageId],
            templateId: "templates-request_key_details-non-tech",
            addLabelIds: [applicationCategory, "Stage1 Interview"],
            removeLabelIds: ["Pre-Stage"],
          });
          break;

        case "Web Designer":
          await sendThreadReplyEmail({
            name: mail.name || "",
            position: mail.position || "unclear",
            userEmail: mail.userEmail,
            subject: mail.subject,
            threadId: mail.threadId,
            emailId: mail.id,
            inReplyTo: mail.messageId,
            references: [mail.messageId],
            templateId: "templates-request_key_details-creative",
            addLabelIds: [applicationCategory, "Stage1 Interview"],
            removeLabelIds: ["Pre-Stage"],
          });
          break;

        default:
          await modifyEmailLabels({
            emailId: mail.id,
            addLabelIds: ["Unclear Applications", "Pre-Stage"],
          });
          break;
      }
    }

    return "Confirmation emails sent successfully";
  },
});

const recruitmentIndeedPreStageWorkflow = createWorkflow({
  id: "recruitment-indeed-pre-stage-workflow",
  description:
    "Workflow to handle recruitment tasks with an agent triggered by Gmail events",
  inputSchema: z.boolean().describe("Signal to start the workflow"),
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  steps: [
    AgentTrigger,
    deduplicateNewlyArrivedMails,
    extractEmailMetaData,
    sortEmailData,
    sendResumeMissingMail,
    sendUnclearPositionEmail,
    sendMultipleRejectionReasonsMail,
    sendConfirmationEmail,
  ],
  retryConfig: {
    attempts: 5,
    delay: 5000,
  },
})
  .then(AgentTrigger)
  .foreach(deduplicateNewlyArrivedMails)
  .foreach(extractEmailMetaData)
  .then(sortEmailData)
  .branch([
    [
      async ({ inputData: { missingResumeEmails } }) =>
        missingResumeEmails.length > 0,
      sendResumeMissingMail,
    ],
    [
      async ({ inputData: { unclearPositionEmails } }) =>
        unclearPositionEmails.length > 0,
      sendUnclearPositionEmail,
    ],
    [
      async ({ inputData: { multipleMissingDetailsEmails } }) =>
        multipleMissingDetailsEmails.length > 0,
      sendMultipleRejectionReasonsMail,
    ],
    [
      async ({ inputData: { confirmEmails } }) => confirmEmails.length > 0,
      sendConfirmationEmail,
    ],
  ]);

recruitmentIndeedPreStageWorkflow.commit();

export { recruitmentIndeedPreStageWorkflow };
