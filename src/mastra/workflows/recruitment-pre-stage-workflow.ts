import { createStep, createWorkflow } from "@mastra/core";
import z from "zod";
import {
  containsKeyword,
  decodeEmailBody,
  getEmailContent,
  getThreadMessages,
  gmailSearchEmails,
  modifyEmailLabels,
  sendThreadReplyEmail,
} from "../../utils/gmail";
import { redis } from "../../queue/connection";
import { fastParseEmail } from "../../utils/emailUtils";

const recruitmentMail = process.env.RECRUITMENT_MAIL;
const consultingMail = process.env.CONSULTING_MAIL;

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
    attachment_filename: z
      .array(z.string().nullable().optional())
      .nullable()
      .optional(),
    attachmentId: z
      .array(z.string().nullable().optional())
      .nullable()
      .optional(),
    hasCoverLetter: z.boolean(),
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
  inputSchema: z.object({
    id: z.string().nullable().optional(),
    threadId: z.string().nullable().optional(),
  }),
  // for production
  // inputSchema: z
  //   .object({
  //     id: z.string(),
  //     threadId: z.string(),
  //   })
  //   .nullable()
  //   .describe("Email ID and thread ID to extract metadata"),
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

      const decodedBody = decodeEmailBody(plainTextPart);

      const username = decodedBody
        .split("Name:")
        .splice(1)
        .join(" ")
        .split("\r\n")[0];

      const { email: userEmail, name } =
        userAddress?.includes(consultingMail) && replyToAddress
          ? extractEmailAndName(replyToAddress)
          : extractEmailAndName(userAddress);

      if (!userEmail?.includes("@gmail.com")) {
        console.log("Email is not from Gmail, skipping", userEmail);
        return null;
      }

      const subject = email.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "subject"
      )?.value;

      const relevantSubjectKeywords = [
        "application received",
        "new application received",
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

      const attachment_filename = email.payload?.parts
        ?.filter((p) => p.filename)
        .map((p) => p.filename);
      const attachmentId = email.payload?.parts
        ?.filter((p) => p.body?.attachmentId)
        .map((p) => p.body?.attachmentId);

      const emailMetaData = {
        id: id || email.id || "",
        messageId: messageId || "",
        threadId: threadId || email.threadId || "",
        userEmail: userEmail ?? null,
        name: username && username !== "" ? username : (name ?? null),
        subject: subject ?? null,
        body: decodedBody ?? null,
        attachment_filename: attachment_filename || [],
        attachmentId: attachmentId || [],
      };

      const hasCoverLetter =
        containsKeyword({
          text: decodedBody,
          keywords: [
            // classic openers / closers
            "cover letter",
            "dear hiring manager",
            "dear sir or madam",
            "dear team",
            "dear recruiter",
            "dear [company]",
            "i am writing to",
            "i am excited to apply",
            "i am reaching out",
            "i am interested in",
            "thank you for considering",
            "thank you for your time",
            "sincerely yours",
            "best regards",

            // self-introduction / intent
            "with x years of experience",
            "with hands-on experience in",
            "i bring to the table",
            "i offer",
            "i am eager to",
            "i am passionate about",
            "i am confident that",
            "i would love the opportunity",
            "i am looking forward to",
            "contribute to your team",
            "add value to your organization",
            "aligns with my career goals",

            // skill highlights
            "proficient in",
            "expertise in",
            "skilled at",
            "experience working with",
            "experience includes",
            "hands-on knowledge of",
            "demonstrated ability in",
            "proven track record",
            "strong background in",
            "solid understanding of",

            // achievements & impact
            "improved",
            "increased",
            "reduced",
            "achieved",
            "delivered",
            "optimized",
            "enhanced",
            "streamlined",
            "boosted",
            "spearheaded",
            "led the development",
            "successfully launched",
            "production-ready apps",
            "real-world projects",

            // soft skills
            "team-oriented",
            "detail-oriented",
            "self-motivated",
            "fast learner",
            "adaptable",
            "collaborative",
            "multitask",
            "problem-solving",
            "critical thinking",
            "communication skills",

            // company-centric phrases
            "your company’s mission",
            "your innovative projects",
            "your dynamic environment",
            "your development team",
            "your engineering culture",
            "your product roadmap",
            "your commitment to excellence",
          ],
        }) &&
        decodedBody.length >= 300 &&
        decodedBody.trim().split(/\s+/).length >= 50;

      const hasResume =
        attachmentId?.length && attachment_filename?.length
          ? containsKeyword({
              text: attachment_filename?.[0] || "",
              keywords: ["resume", "cv"],
            }) ||
            containsKeyword({
              text: decodedBody || "",
              keywords: [
                "resume",
                "Resume",
                "resume attached",
                "cv attached",
                "please find my resume",
                "attached is my resume",
                "attached my resume",
                "resume:",
                "Resume:",
              ],
            }) ||
            containsKeyword({
              text: decodedBody || "",
              keywords: ["resume", "Resume", "cv", "CV"],
            })
          : containsKeyword({
              text: decodedBody || "",
              keywords: ["resume", "Resume", "cv", "CV"],
            });

      const potentialJobTitle = decodedBody
        .split("Job Opening:")
        .splice(1)
        .join(" ")
        .split("[")[0];

      const fastResult = fastParseEmail(subject ?? "", decodedBody);

      if (
        fastResult &&
        Object.keys(fastResult).length > 0 &&
        fastResult.category &&
        fastResult.category !== "unclear"
      ) {
        return {
          ...emailMetaData,
          hasCoverLetter,
          hasResume,
          position: fastResult?.job_title.trim() ?? potentialJobTitle ?? "unclear",
          category: fastResult.category || "unclear",
          experienceStatus: fastResult.experience_status || "unclear",
        };
      }

      try {
        const agent = mastra.getAgent("contextQAAgent");
        const result = await agent.generate(
          "Extract job application details from emails with varying structures",
          {
            instructions: `
You are a job-application parser.  
Input variables:  
- SUBJECT: ${subject?.trim()}  
- BODY: ${decodedBody.trim()}  
- HINT_TITLE: ${potentialJobTitle ? `'${potentialJobTitle}'` : "None"}

Return **only** valid JSON:  
{ "job_title": "<title>", "experience_status": "<status>", "category": "<category>" }

1. JOB_TITLE  
   a. Patterns (stop at first hit):  
      • ^Application for (.+?)(?:\\s*\\(|\\s*Role|$)  
      • New application received for the position of (.+?)(?:\\s*\\[|\\s*at|$)  
      • Job Opening: (.+?)(?:\\s*\\[|\\s*at|$)  
      • applying for the (.+?) role|position  
      • interest in any suitable (.+?) opportunities  
   b. Clean: trim; drop everything from '(' or '[' onward.  
   c. Fallback: if no match →  
      • extract last word before "developer", "engineer", "programmer", "designer", etc.  
      • else use HINT_TITLE if it appears verbatim in body.  

2. EXPERIENCE_STATUS  
   • "experienced" if regex matches:  
     \\b(?:\\d+(?:\\.\\d+)?)\\s*(?:\\+|years?)\\b  OR  \\bbuilt \\d+ apps?\\b  OR  \\bthroughout my career\\b  
   • "fresher" if “recent graduate”, “intern”, “entry-level” appear and no numeric years.  
   • else "unclear".

3. CATEGORY  
   • "Developer" if title OR body contains: developer, engineer, programmer, flutter, react, backend, frontend, full-stack, node, laravel, php, mobile, app, software.  
   • "Web Designer" for designer, ui/ux, web design.  
   • "Recruiter" for recruiter, hr, talent acquisition.  
   • "Sales/Marketing" for sales, marketing, business development.  
   • else "unclear".

Return **only** the JSON object—no explanation.
`,
            maxSteps: 10,
            maxTokens: 100,
          }
        );
        const generatedResult: {
          job_title: string;
          experience_status: string;
          category: string;
        } = extractJsonFromResult(result.text);

        return {
          ...emailMetaData,
          hasCoverLetter,
          hasResume,
          position: generatedResult?.job_title || "unclear",
          category: generatedResult?.category || "unclear",
          experienceStatus: generatedResult?.experience_status || "unclear",
        };
      } catch (err) {
        console.log(
          "Error occured while extracting candidate details from email body",
          err
        );

        // Wait 60 000 ms before the thread continues
        console.log("Waiting 1 minute before the thread continues");
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            console.log("Resuming thread after 1 minute wait");
            resolve();
          }, 60_000);
        });
        return null;
      }
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
  missingCoverLetterEmails: z.array(ExtractEmailMetaDataOutput),
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
        missingCoverLetterEmails: [],
        unclearPositionEmails: [],
        confirmEmails: [],
      });
    }

    const missingResumeEmails: typeof inputData = [];
    const missingCoverLetterEmails: typeof inputData = [];
    const unclearPositionEmails: typeof inputData = [];
    const multipleMissingDetailsEmails: typeof inputData = [];
    const confirmEmails: typeof inputData = [];

    inputData.forEach((email) => {
      if (!email) {
        return;
      }
      const missingResume = !email.hasResume;
      const missingCoverLetter = !email.hasCoverLetter;
      const unclearPosition = !email.position || email.position === "unclear";
      const missingDetailsCount = [
        missingResume,
        missingCoverLetter,
        unclearPosition,
      ].filter(Boolean).length;

      if (missingDetailsCount > 1) {
        multipleMissingDetailsEmails.push(email);
      } else if (missingResume) {
        missingResumeEmails.push(email);
      } else if (missingCoverLetter) {
        missingCoverLetterEmails.push(email);
      } else if (unclearPosition) {
        unclearPositionEmails.push(email);
      } else {
        confirmEmails.push(email);
      }
    });

    return SortEmailDataOutput.parse({
      multipleMissingDetailsEmails,
      missingResumeEmails,
      missingCoverLetterEmails,
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

const sendCoverLetterMissingEmail = createStep({
  id: "send-cover-letter-missing-email",
  description: "Sends rejection email to candidate for missing cover letter",
  inputSchema: SortEmailDataOutput,
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData: { missingCoverLetterEmails } }) => {
    if (!missingCoverLetterEmails || missingCoverLetterEmails.length === 0) {
      console.log(
        "No rejected email data found for sendCoverLetterMissingEmail step"
      );
      return "No rejected email data found";
    }

    for (let mail of missingCoverLetterEmails) {
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
        templateId: "templates-rejection-no_cover_letter",
        addLabelIds: ["Pre-Stage"],
      });
    }

    return "Cover letter missing emails sent successfully";
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
  execute: async ({ inputData: { confirmEmails }, mastra }) => {
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

          if (!templateId) {
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

        case "CREATIVE":
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

const recruitmentPreStageWorkflow = createWorkflow({
  id: "recruitment-pre-stage-workflow",
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
    sendCoverLetterMissingEmail,
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
  // .foreach(deduplicateNewlyArrivedMails)
  .foreach(extractEmailMetaData)
  .then(sortEmailData);
// .branch([
//   [
//     async ({ inputData: { missingResumeEmails } }) =>
//       missingResumeEmails.length > 0,
//     sendResumeMissingMail,
//   ],
//   [
//     async ({ inputData: { missingCoverLetterEmails } }) =>
//       missingCoverLetterEmails.length > 0,
//     sendCoverLetterMissingEmail,
//   ],
//   [
//     async ({ inputData: { unclearPositionEmails } }) =>
//       unclearPositionEmails.length > 0,
//     sendUnclearPositionEmail,
//   ],
//   [
//     async ({ inputData: { multipleMissingDetailsEmails } }) =>
//       multipleMissingDetailsEmails.length > 0,
//     sendMultipleRejectionReasonsMail,
//   ],
//   [
//     async ({ inputData: { confirmEmails } }) => confirmEmails.length > 0,
//     sendConfirmationEmail,
//   ],
// ]);

recruitmentPreStageWorkflow.commit();

export { recruitmentPreStageWorkflow };
