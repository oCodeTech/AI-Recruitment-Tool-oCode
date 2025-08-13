import { createStep, createWorkflow } from "@mastra/core";
import z from "zod";
import {
  containsKeyword,
  getAttachment,
  getEmailContent,
  getLabelNames,
  getThreadMessages,
  gmailSearchEmails,
  modifyEmailLabels,
  sendThreadReplyEmail,
} from "../../utils/gmail";
import { redis } from "../../queue/connection";
import {
  extractEmailAndName,
  extractJsonFromResult,
} from "./recruitment-pre-stage-workflow";
import { decodeEmailBody } from "../../utils/gmail";
import {
  extractDetailedCandidateInfo,
  extractTextFromAttachment,
  extractTextFromDOCX,
  extractTextFromPDF,
  fastParseEmail,
} from "../../utils/emailUtils";

interface ApplicantKeyDetails {
  position: string;
  currentCTC: string;
  expectedCTC: string;
  workExp: string;
  interviewTime: string;
  location: string;
  education?: string;
  contact?: string;
  linkedIn?: string;
  facebook?: string;
  callTime?: string;
  resume?: string;
  agreement: string;

  // tech experienced
  lastAppraisal?: string;
  switchingReason?: string;
  totalWorkExp?: string;
  currLoc?: string;
  github?: string;
  stackOverflow?: string;
}

const recruitmentMail = process.env.RECRUITMENT_MAIL;
const consultingMail = process.env.CONSULTING_MAIL;

if (!recruitmentMail) {
  throw new Error("RECRUITMENT_MAIL environment variable is not set");
}

if (!consultingMail) {
  throw new Error("CONSULTING_MAIL environment variable is not set");
}

const AgentTrigger = createStep({
  id: "agent-trigger",
  description:
    "Triggers the agent when new reply mails arrive to handle recruitment tasks",
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
      q: `label:"Stage1 Interview" OR label:"Pre-Stage"`,
      maxResults: 20,
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
    .array(
      z.object({
        id: z.string().nullable().optional(),
        threadId: z.string().nullable().optional(),
      })
    )
    .describe("Email ID and thread ID array to deduplicate"),
  outputSchema: z
    .array(
      z.object({
        id: z.string().nullable().optional(),
        threadId: z.string().nullable().optional(),
      })
    )
    .describe("Email ID and thread ID deduplicated"),

  execute: async ({ inputData }) => {
    if (!inputData) {
      console.log(
        "Email ID or thread ID not found for deduplicate-newly-arrived-mails step"
      );
      return [];
    }

    const deduplicatedEmails: { id: string; threadId: string }[] = [];
    for (let mail of inputData) {
      if (!mail || !mail.id || !mail.threadId) continue;

      const { id, threadId } = mail;

      try {
        const alreadyProcessed = await redis.get(
          `processed_thread:${threadId}`
        );
        if (alreadyProcessed) {
          console.log(`Thread ID ${threadId} already processed, skipping`);

          continue;
        }

        await redis.set(`processed_thread:${threadId}`, "1", "EX", 3600);
        deduplicatedEmails.push({
          id,
          threadId,
        });
      } catch (err) {
        console.log(err);
        continue;
      }
    }

    return deduplicatedEmails;
  },
});

const ExtractEmailMetaDataOutput = z
  .object({
    id: z.string(),
    messageId: z.string(),
    threadId: z.string(),
    username: z.string(),
    userEmail: z.string(),
    subject: z.string(),
    body: z.string(),
    labels: z.array(z.string()),
  })
  .nullable()
  .describe("Extracted email metadata");

const extractEmailMetaData = createStep({
  id: "extract-email-meta-data",
  description: "Extracts email metadata by email ID and thread ID",
  inputSchema: z.object({
    id: z.string().nullable().optional(),
    threadId: z.string().nullable().optional(),
  }),
  outputSchema: ExtractEmailMetaDataOutput,
  execute: async ({ inputData: { id, threadId } }) => {
    if (!id || !threadId) {
      console.log(
        "Email ID or thread ID not found for extract-email-meta-data step",
        { id, threadId }
      );
      return null;
    }

    try {
      const originalEmail = await getEmailContent(id!);
      const originalMessageId = originalEmail?.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "message-id"
      )?.value;

      if (!originalMessageId) {
        console.error(
          `Message ID ${originalMessageId} not found for email ID ${id}`
        );
        return null;
      }

      const threadMessages = (await getThreadMessages(threadId!)) || [];

      const latestThreadEmail = threadMessages[threadMessages.length - 1];
      if (!latestThreadEmail || !originalEmail) {
        console.error("Latest thread email or original email not found");
        return null;
      }

      const labels = await getLabelNames(originalEmail.labelIds || []);

      const userAddress = latestThreadEmail.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "from"
      )?.value;

      const replyToAddress = latestThreadEmail.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "reply-to"
      )?.value;

      const { email: userEmail, name: username } =
        userAddress?.includes(consultingMail) && replyToAddress
          ? extractEmailAndName(replyToAddress)
          : extractEmailAndName(userAddress);

      if (!userEmail?.includes("@gmail.com")) {
        console.log("Email is not from Gmail, skipping", userEmail);
        return null;
      }

      const subject = latestThreadEmail.payload?.headers?.find(
        (h) => h.name && h.name.toLowerCase() === "subject"
      )?.value;

      const plainTextPart =
        latestThreadEmail.payload?.parts
          ?.find((p) => p.mimeType === "multipart/alternative")
          ?.parts?.find((p2) => p2.mimeType === "text/plain") ||
        latestThreadEmail.payload?.parts?.find(
          (p) => p.mimeType === "text/plain"
        );

      const decodedBody = decodeEmailBody(plainTextPart).split("On")[0];

      if (
        userEmail === recruitmentMail ||
        username === recruitmentMail ||
        !userEmail ||
        !username ||
        !subject ||
        !decodedBody
      ) {
        return null;
      }

      const emailMetaData = {
        id,
        messageId: originalMessageId,
        userEmail: userEmail,
        username: username,
        subject: subject,
        body: decodedBody,
        threadId: threadId || latestThreadEmail.threadId || "",
        labels: labels || [],
      };

      const filteredEmails = emailMetaData.labels.some(
        (label) => label === "Pre-Stage" || label === "Stage1 Interview"
      );

      if (!filteredEmails) {
        console.log(
          "Email is not a reply to a stage1 interview, skipping",
          labels
        );
        return null;
      }
      return emailMetaData;
    } catch (err) {
      console.log(err);
      return null;
    }
  },
});

const sortReplyEmailsOutput = z.object({
  applicants: z.array(ExtractEmailMetaDataOutput),
  incompleteApplications: z.array(ExtractEmailMetaDataOutput),
});

const sortReplyEmails = createStep({
  id: "sort-reply-emails",
  description: "Sorts emails by thier labels",
  inputSchema: z.array(ExtractEmailMetaDataOutput),
  outputSchema: sortReplyEmailsOutput,
  execute: async ({ inputData }) => {
    if (!inputData || !inputData.length) {
      return {
        applicants: [],
        incompleteApplications: [],
      };
    }

    try {
      const applicants = inputData.filter(
        (email) => email && email.labels.includes("Stage1 Interview")
      );
      const incompleteApplications = inputData.filter(
        (email) => email && email.labels.includes("Pre-Stage")
      );

      return {
        applicants,
        incompleteApplications,
      };
    } catch (err) {
      console.log(err);
      return {
        applicants: [],
        incompleteApplications: [],
      };
    }
  },
});

const analyseApplicantsOutput = z.object({
  id: z.string(),
  messageId: z.string(),
  threadId: z.string(),
  labels: z.array(z.string()),
  userEmail: z.string().nullable(),
  name: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string(),
  keyDetails: z
    .object({
      position: z.string(),
      currentCTC: z.string(),
      expectedCTC: z.string(),
      workExp: z.string(),
    })
    .optional(),
});

const analyseApplicants = createStep({
  id: "analyse-applicants",
  description: "analyses applicants",
  inputSchema: sortReplyEmailsOutput,
  outputSchema: z.object({
    applicantsData: z.array(analyseApplicantsOutput),
    incompleteApplicationsData: z.array(analyseApplicantsOutput),
  }),
  execute: async ({ inputData: { applicants }, mastra }) => {
    if (!applicants || !applicants.length) {
      throw Error("Applicant mails not found");
    }

    const applicantsData: z.infer<typeof analyseApplicantsOutput>[] = [];
    const incompleteApplicationsData: z.infer<
      typeof analyseApplicantsOutput
    >[] = [];

    for (let mail of applicants) {
      if (!mail || !mail.threadId) continue;

      const agent = mastra.getAgent("contextQAAgent");

      if (!agent) {
        throw Error("ContextQA Agent not found at analyse-applicants step");
      }

      const emailMetaData: z.infer<typeof analyseApplicantsOutput> = {
        id: mail.id || "",
        threadId: mail.threadId,
        messageId: mail.messageId || "",
        labels: mail.labels,
        userEmail: mail.userEmail,
        name: mail.username,
        subject: mail.subject,
        body: mail.body,
      };

      const message = await getEmailContent(mail.id);

      const attachmentIds =
        message.payload?.parts
          ?.filter((p) => p.body?.attachmentId)
          .map((p) => p.body?.attachmentId) || [];

      let attachmentContent = "";

      for (let attachmentId of attachmentIds) {
        if (!attachmentId) continue;
        const attachmentData = await getAttachment(attachmentId);
        attachmentContent += attachmentData;
      }

      const fastExtractedDetails = extractDetailedCandidateInfo(
        mail.subject,
        mail.body,
        attachmentContent
      );

      const missingKeyDetails = fastExtractedDetails
        ? Object.entries(fastExtractedDetails).some(([key, value]) => {
            const requiredFields = [
              "position",
              "currentCTC",
              "expectedCTC",
              "workExp",
            ];
            return requiredFields.includes(key) && value === "unclear";
          })
        : true; 

      if (!missingKeyDetails && fastExtractedDetails) {
        emailMetaData.keyDetails = fastExtractedDetails;
        console.log("Fast extracted details", fastExtractedDetails);
        new Promise((resolve) => setTimeout(resolve, 1000));
        applicantsData.push(emailMetaData);
        continue;
      }

      try {
        const result = await agent.generate(
          `Extract key details from the following email body:\n\n${mail.body}`,
          {
            instructions: `
        You are an AI agent tasked with analyzing email bodies and extracting specific key details.

        Required fields: Always include these in the output JSON, even if the value is "N/A" (Not Applicable) or "unclear" (ambiguous).
        - position: string
        - currentCTC: string
        - expectedCTC: string
        - workExp: string
       

        Return the result as a JSON object with the required fields that are present in the email body.
            `,
            maxSteps: 20,
            maxTokens: 1000,
          }
        );
        const extractedDetails: ApplicantKeyDetails = extractJsonFromResult(
          result.text
        );

        const missingKeyDetails = extractedDetails
          ? Object.values(extractedDetails).some(
              (value) => value === "Not Provided" || value === "unclear"
            )
          : true;

        if (missingKeyDetails) {
          incompleteApplicationsData.push(emailMetaData);
          continue;
        }

        if (!extractedDetails) {
          incompleteApplicationsData.push(emailMetaData);
          continue;
        }

        emailMetaData.keyDetails = extractedDetails;

        applicantsData.push(emailMetaData);
      } catch (e) {
        console.error("Error extracting key details from email:", e);
        incompleteApplicationsData.push(emailMetaData);
      }
    }
    return {
      applicantsData,
      incompleteApplicationsData,
    };
  },
});

const analyseApplicantionOutput = z.object({
  id: z.string(),
  threadId: z.string(),
  messageId: z.string(),
  labels: z.array(z.string()),
  userEmail: z.string().nullable(),
  name: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  attachment_filename: z.array(z.string().nullable().optional()).nullable(),
  attachmentId: z.array(z.string().nullable().optional()).nullable(),
  hasCoverLetter: z.boolean(),
  hasResume: z.boolean(),
  job_title: z.string().nullable(),
  experience_status: z.string().nullable(),
  category: z.string().nullable(),
});

const analyseIncompleteApplications = createStep({
  id: "analyse-incomplete-applications",
  description: "analyses incomplete applications",
  inputSchema: sortReplyEmailsOutput,
  outputSchema: z.object({
    applicantsData: z.array(analyseApplicantionOutput),
    incompleteApplicationsData: z.array(analyseApplicantionOutput),
  }),
  execute: async ({ inputData: { incompleteApplications }, mastra }) => {
    if (!incompleteApplications || !incompleteApplications.length) {
      return {
        applicantsData: [],
        incompleteApplicationsData: [],
      };
    }

    const applicantsData: z.infer<typeof analyseApplicantionOutput>[] = [];
    const incompleteApplicationsData: z.infer<
      typeof analyseApplicantionOutput
    >[] = [];

    for (let mail of incompleteApplications) {
      if (!mail || !mail.threadId) continue;

      const threadMessages = (await getThreadMessages(mail.threadId)) || [];

      if (threadMessages.length === 0) continue;

      const latestThreadMessage = threadMessages[threadMessages.length - 1];
      // --------------------------------------------------------------------
      // DATA EXTRACTION

      const attachment_filename = latestThreadMessage.payload?.parts
        ?.filter((p) => p.filename)
        .map((p) => p.filename);
      const attachmentId = latestThreadMessage.payload?.parts
        ?.filter((p) => p.body?.attachmentId)
        .map((p) => p.body?.attachmentId);

      const hasCoverLetter =
        containsKeyword({
          text: mail.body,
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
        mail.body.length >= 300 &&
        mail.body.trim().split(/\s+/).length >= 50;

      const hasResume =
        attachmentId?.length && attachment_filename?.length
          ? containsKeyword({
              text: attachment_filename?.[0] || "",
              keywords: ["resume", "cv"],
            }) ||
            containsKeyword({
              text: mail.body || "",
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
              text: mail.body || "",
              keywords: ["resume", "Resume", "cv", "CV"],
            })
          : containsKeyword({
              text: mail.body || "",
              keywords: ["resume", "Resume", "cv", "CV"],
            });

      const emailMetaData = {
        id: mail.id,
        threadId: mail.threadId,
        messageId: mail.messageId,
        labels: mail.labels,
        userEmail: mail.userEmail,
        name: mail.username,
        subject: mail.subject,
        body: mail.body,
        attachment_filename: attachment_filename || [],
        attachmentId: attachmentId || [],
        hasCoverLetter,
        hasResume,
        job_title: "unclear",
        category: "unclear",
        experience_status: "unclear",
      };

      if (!hasCoverLetter && !hasResume) {
        incompleteApplicationsData.push(emailMetaData);
        continue;
      }

      const potentialJobTitle = mail.body
        .split("Job Opening:")
        .splice(1)
        .join(" ")
        .split("[")[0];

      const fastResult = fastParseEmail(mail.subject, mail.body);

      if (
        fastResult &&
        Object.keys(fastResult).length > 0 &&
        fastResult.category &&
        fastResult.category !== "unclear"
      ) {
        applicantsData.push({
          ...emailMetaData,
          job_title:
            fastResult?.job_title.trim() ?? potentialJobTitle ?? "unclear",
          category: fastResult.category || "unclear",
          experience_status: fastResult.experience_status || "unclear",
        });
        continue;
      }

      try {
        const agent = mastra.getAgent("contextQAAgent");

        if (!agent) {
          throw new Error(
            "contextQAAgent not found at analyseIncompleteApplications step"
          );
        }

        const result = await agent.generate(
          "Extract job application details from emails with varying structures",
          {
            instructions: `
You are a job-application parser.  
Input variables:  
- SUBJECT: ${mail.subject?.trim()}  
- BODY: ${mail.body.trim()}  
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

        if (
          !hasCoverLetter ||
          !hasResume ||
          generatedResult?.job_title === "unclear" ||
          !generatedResult?.job_title
        ) {
          incompleteApplicationsData.push({
            ...emailMetaData,
            hasCoverLetter,
            hasResume,
            job_title: generatedResult?.job_title || "unclear",
            experience_status: generatedResult?.experience_status || "unclear",
            category: generatedResult?.category || "unclear",
          });
          continue;
        } else {
          applicantsData.push({
            ...emailMetaData,
            hasCoverLetter,
            hasResume,
            job_title: generatedResult.job_title || "unclear",
            experience_status: generatedResult.experience_status || "unclear",
            category: generatedResult.category || "unclear",
          });
          continue;
        }
      } catch (err) {
        console.log("error occured while extracting job title", err);
        incompleteApplicationsData.push({
          ...emailMetaData,
          hasCoverLetter,
          hasResume,
          job_title: null,
        });
      }
    }

    return {
      applicantsData,
      incompleteApplicationsData,
    };
  },
});

const mergeResults = createStep({
  id: "merge-results",
  description: "Merges the results of the two branches",
  inputSchema: z.object({
    "analyse-incomplete-applications": z.object({
      applicantsData: z.array(analyseApplicantionOutput),
      incompleteApplicationsData: z.array(analyseApplicantionOutput),
    }),
    "analyse-applicants": z.object({
      applicantsData: z.array(analyseApplicantsOutput),
      incompleteApplicationsData: z.array(analyseApplicantsOutput),
    }),
  }),
  outputSchema: z
    .object({
      applicantsWithKeys: z.array(analyseApplicantsOutput),
      rejectedWithoutKeys: z.array(analyseApplicantsOutput),
      applicantsData: z.array(analyseApplicantionOutput),
      incompleteApplicationsData: z.array(analyseApplicantionOutput),
    })
    .describe("Final output of the recruitment workflow"),
  execute: async ({ inputData }) => {
    if (Object.keys(inputData).length === 0) {
      return {
        applicantsWithKeys: [],
        rejectedWithoutKeys: [],
        applicantsData: [],
        incompleteApplicationsData: [],
      };
    }
    const analyseIncompleteApplications =
      inputData["analyse-incomplete-applications"];
    const analyseApplicants = inputData["analyse-applicants"];

    const applicantsData =
      analyseIncompleteApplications?.applicantsData?.length > 0
        ? analyseIncompleteApplications.applicantsData
        : [];
    const incompleteApplicationsData =
      analyseIncompleteApplications?.incompleteApplicationsData?.length > 0
        ? analyseIncompleteApplications.incompleteApplicationsData
        : [];

    const applicantsWithKeys =
      analyseApplicants?.applicantsData?.length > 0
        ? analyseApplicants.applicantsData
        : [];

    const rejectedWithoutKeys =
      analyseApplicants?.incompleteApplicationsData?.length > 0
        ? analyseApplicants.incompleteApplicationsData
        : [];

    return {
      applicantsWithKeys,
      rejectedWithoutKeys,
      applicantsData,
      incompleteApplicationsData,
    };
  },
});

const migrateApplicantsWithKeyDetails = createStep({
  id: "migrate-applicants-with-key-details",
  description: "Migrates applicants with key details to next phase",
  inputSchema: z.object({
    applicantsWithKeys: z.array(analyseApplicantsOutput),
    rejectedWithoutKeys: z.array(analyseApplicantsOutput),
    applicantsData: z.array(analyseApplicantionOutput),
    incompleteApplicationsData: z.array(analyseApplicantionOutput),
  }),
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData: { applicantsWithKeys }, mastra }) => {
    for (let mail of applicantsWithKeys) {
      if (!mail.userEmail) continue;

      const keyDetails = mail.keyDetails;
      if (!keyDetails || Object.values(keyDetails).some((v) => !v)) continue;

      const agent = mastra.getAgent("contextQAAgent");

      if (!agent) {
        throw new Error(
          "Agent not found at migrateApplicantsWithKeyDetails step"
        );
      }

      const threadMessages = await getThreadMessages(mail.threadId);

      if (!threadMessages || !threadMessages.length) continue;

      let resumeAttachment = null;

      for (const message of threadMessages) {
        const attachmentIds = (message.payload?.parts || [])
          .filter((p) =>
            containsKeyword({
              text: p.filename || "",
              keywords: ["resume", "Resume", "cv", "CV"],
            })
          )
          .map((p) => ({
            id: p.body?.attachmentId,
            filename: p.filename,
          }));

        console.log("attachmentIds", attachmentIds);
        for (const { id, filename } of attachmentIds) {
          if (!id || !filename) continue;
          try {
            const attachment = await getAttachment(id);
            resumeAttachment = {
              filename,
              attachment: attachment.data,
            };
            break;
          } catch (err) {
            console.error("Error getting attachment", err);
          }
        }

        if (resumeAttachment) break;
      }

      if (!resumeAttachment || !resumeAttachment.attachment) {
        console.log("No resume attachment found", resumeAttachment);
        continue;
      }

      let parsedResumeContent = null;

      const testparsingResumeContent = await extractTextFromAttachment({
        filename: resumeAttachment.filename,
        attachment: resumeAttachment.attachment,
      });

      console.log("testparsingResumeContent", testparsingResumeContent);

      // if (
      //   resumeAttachment.filename.includes(".pdf") &&
      //   resumeAttachment.attachment
      // ) {
      //   // For PDF attachments
      //   const base64String = resumeAttachment.attachment;
      //   const buffer = Buffer.from(
      //     base64String.replace(/-/g, "+").replace(/_/g, "/") +
      //       "=".repeat((4 - (base64String.length % 4)) % 4),
      //     "base64"
      //   );
      //   console.log("resume pdf detected", resumeAttachment.filename);
      //   parsedResumeContent = await extractTextFromPDF(buffer);
      //   console.log(
      //     "Resume content parsed via PDF function:",
      //     parsedResumeContent
      //   );

      //   continue;
      // } else if (
      //   (resumeAttachment.filename.includes(".doc") ||
      //     resumeAttachment.filename.includes(".docx")) &&
      //   resumeAttachment.attachment
      // ) {
      //   // For DOCX attachments
      //   const base64Data = resumeAttachment.attachment
      //     .replace(/-/g, "+")
      //     .replace(/_/g, "/");
      //   const padding = "=".repeat((4 - (base64Data.length % 4)) % 4);
      //   const base64WithPadding = base64Data + padding;
      //   const docBinary = Buffer.from(base64WithPadding, "base64");
      //   parsedResumeContent = await extractTextFromDOCX(docBinary);
      // } else {
      //   console.log("Unable to parse resume, skipping this mail");
      //   continue;
      // }

      // if (!parsedResumeContent) {
      //   console.log("Unable to parse resume, skipping this mail");
      //   continue;
      // }

      // console.log("Resume content:", parsedResumeContent);

      //     try {
      //       const resumeText = parsedResumeContent;
      //       const currentCTC = keyDetails.currentCTC;
      //       const expectedCTC = keyDetails.expectedCTC;
      //       const jobPosition = keyDetails.position;
      //       const workExperience = keyDetails.workExp;

      //       const result = await agent.generate(
      //         `Resume Text: ${resumeText}

      //  Candidate Details:
      //  - Current CTC: ${currentCTC}
      //  - Expected CTC: ${expectedCTC}
      //  - Job Position Applying For: ${jobPosition}
      //  - Work Experience: ${workExperience}

      //  Analyze the candidate profile and generate interview questions as per the instructions.`,
      //         {
      //           instructions: `You are an AI recruitment assistant that must return ONLY a valid JSON response with no additional text.

      //   Process:
      //   1. Evaluate provided key details:
      //      - Check if currentCTC, expectedCTC, jobPosition, and workExperience are meaningful
      //      - Consider values as UNMEANINGFUL if: null, undefined, empty string, "N/A", "NA", "na", "n/a", or similar placeholders
      //      - For any UNMEANINGFUL values, extract the information from the resume text instead

      //   2. Use the job position (either provided or extracted from resume) to search the vector database for current openings

      //   3. If no matching opening found, return JSON with "jobOpeningFound": false

      //   4. If opening found:
      //      a. Extract key details from:
      //         - Provided candidate details (if meaningful)
      //         - Resume text (for any unmeaningful provided details or additional context)
      //         - Focus on:
      //           * Technical skills and proficiency levels
      //           * Project experience with relevant technologies
      //           * Work history including roles, responsibilities, and achievements
      //           * Current CTC and expected CTC (from provided details or resume)
      //           * Educational background and certifications
      //      b. Compare candidate qualifications against the retrieved job requirements
      //      c. Generate 5-8 pre-round interview questions based on:
      //         - Candidate's skills and experience from resume
      //         - Requirements from matched job description
      //         - No hallucinated content - only use information from resume and retrieved job description

      //   Output Schema (guaranteed JSON response):
      //   {
      //     "jobOpeningFound": boolean,
      //     "jobTitle": string,
      //     "jobDescription": string,
      //     "interviewQuestions": [string]
      //   }

      //   Rules:
      //   - If no job opening: jobOpeningFound=false, jobTitle="", jobDescription="", interviewQuestions=[]
      //   - If job found: jobOpeningFound=true, populate all fields
      //   - Interview questions must be specific to the job position and candidate's profile
      //   - Never add explanations outside the JSON
      //   - Never hallucinate job details or candidate experiences
      //   - Questions should cover technical skills, project experience, problem-solving, and role-specific knowledge
      //   - Prioritize provided key details when meaningful, otherwise extract from resume text`,
      //           maxSteps: 10,
      //           maxTokens: 1000,
      //         }
      //       );

      //       console.log(
      //         "result of ai screening of candidate profile:",
      //         result.text
      //       );
      //     } catch (err) {
      //       console.log("error occured while extracting job title", err);
      //     }

      // const applicationCategory = mail.keyDetails?.position
      //   ? `${mail.keyDetails?.position?.replaceAll(" ", "_").toUpperCase()}_APPLICANTS`
      //   : "";

      // const confirmationMailResp = await sendThreadReplyEmail({
      //   name: mail.name || "",
      //   position: mail.keyDetails?.position || "unclear",
      //   userEmail: mail.userEmail,
      //   subject: mail.subject,
      //   threadId: mail.threadId,
      //   emailId: mail.emailId,
      //   templateId: "templates-confirmation-job_application_received",
      //   addLabelIds: [applicationCategory, "APPLICANTS"],
      //   removeLabelIds: [
      //
      //     "INCOMPLETE_APPLICATIONS",
      //   ],
      // });
    }

    return "applicants with key details migrated successfully";
  },
});

const informToResend = createStep({
  id: "inform-to-resend",
  description: "informs the applicant to re-apply with required details",
  inputSchema: z.object({
    applicantsWithKeys: z.array(analyseApplicantsOutput),
    rejectedWithoutKeys: z.array(analyseApplicantsOutput),
    applicantsData: z.array(analyseApplicantionOutput),
    incompleteApplicationsData: z.array(analyseApplicantionOutput),
  }),
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData: { rejectedWithoutKeys } }) => {
    for (let mail of rejectedWithoutKeys) {
      if (!mail.userEmail) continue;

      await sendThreadReplyEmail({
        name: mail.name || "",
        position: mail.keyDetails?.position || "unclear",
        userEmail: mail.userEmail,
        subject: mail.subject,
        threadId: mail.threadId,
        emailId: mail.id,
        inReplyTo: mail.messageId,
        references: [mail.messageId],
        templateId: "templates-request_key_details-resend_key_details",
        addLabelIds: ["Stage1 Interview"],
      });
    }

    return "Applicants informed to re-apply with required details mails sent";
  },
});

const migrateConfirmedApplicants = createStep({
  id: "migrate-confirmed-applicants",
  description: "Migrates confirmed applicants",
  inputSchema: z.object({
    applicantsWithKeys: z.array(analyseApplicantsOutput),
    rejectedWithoutKeys: z.array(analyseApplicantsOutput),
    applicantsData: z.array(analyseApplicantionOutput),
    incompleteApplicationsData: z.array(analyseApplicantionOutput),
  }),
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData: { applicantsData } }) => {
    for (let mail of applicantsData) {
      if (!mail.userEmail) continue;

      console.log("mail with all details in pre stage reply mail", mail);

      // const applicationCategory =
      //   mail.category !== "unclear" && mail.category
      //     ? mail.category
      //     : "Unclear Applications";

      // switch (mail.category) {
      //   case "Developer":
      //     const templateId =
      //       mail.experience_status === "experienced"
      //         ? "templates-request_key_details-developer-experienced"
      //         : mail.experience_status === "fresher"
      //           ? "templates-request_key_details-developer-fresher"
      //           : null;

      //     if (!templateId || !mail.job_title || mail.job_title === "unclear") {
      //       await modifyEmailLabels({
      //         emailId: mail.id,
      //         addLabelIds: ["Unclear Applications"],
      //         removeLabelIds: ["Pre-Stage"],
      //       });
      //       continue;
      //     }

      //     await sendThreadReplyEmail({
      //       name: mail.name || "",
      //       position: mail.job_title || "unclear",
      //       userEmail: mail.userEmail,
      //       subject: mail.subject,
      //       threadId: mail.threadId,
      //       emailId: mail.id,
      //       inReplyTo: mail.messageId,
      //       references: [mail.messageId],
      //       templateId: templateId,
      //       addLabelIds: [applicationCategory, "Stage1 Interview"],
      //       removeLabelIds: ["Pre-Stage"],
      //     });

      //     break;

      //   case "Recruiter":
      //     await sendThreadReplyEmail({
      //       name: mail.name || "",
      //       position: mail.job_title || "unclear",
      //       userEmail: mail.userEmail,
      //       subject: mail.subject,
      //       threadId: mail.threadId,
      //       emailId: mail.id,
      //       inReplyTo: mail.messageId,
      //       references: [mail.messageId],
      //       templateId: "templates-request_key_details-non-tech",
      //       addLabelIds: [applicationCategory, "Stage1 Interview"],
      //       removeLabelIds: ["Pre-Stage"],
      //     });
      //     break;

      //   case "Sales / Marketing":
      //     await sendThreadReplyEmail({
      //       name: mail.name || "",
      //       position: mail.job_title || "unclear",
      //       userEmail: mail.userEmail,
      //       subject: mail.subject,
      //       threadId: mail.threadId,
      //       emailId: mail.id,
      //       inReplyTo: mail.messageId,
      //       references: [mail.messageId],
      //       templateId: "templates-request_key_details-non-tech",
      //       addLabelIds: [applicationCategory, "Stage1 Interview"],
      //       removeLabelIds: ["Pre-Stage"],
      //     });
      //     break;

      //   case "CREATIVE":
      //     await sendThreadReplyEmail({
      //       name: mail.name || "",
      //       position: mail.job_title || "unclear",
      //       userEmail: mail.userEmail,
      //       subject: mail.subject,
      //       threadId: mail.threadId,
      //       emailId: mail.id,
      //       inReplyTo: mail.messageId,
      //       references: [mail.messageId],
      //       templateId: "templates-request_key_details-creative",
      //       addLabelIds: [applicationCategory, "Stage1 Interview"],
      //       removeLabelIds: ["Pre-Stage"],
      //     });
      //     break;

      //   default:
      //     await modifyEmailLabels({
      //       emailId: mail.id,
      //       addLabelIds: ["Unclear Applications"],
      //       removeLabelIds: ["Pre-Stage"],
      //     });
      //     break;
      // }
    }

    return "applicants confirmed and migrated";
  },
});

const informToReApply = createStep({
  id: "inform-to-re-apply",
  description: "informs the applicant to re-apply with required details",
  inputSchema: z.object({
    applicantsWithKeys: z.array(analyseApplicantsOutput),
    rejectedWithoutKeys: z.array(analyseApplicantsOutput),
    applicantsData: z.array(analyseApplicantionOutput),
    incompleteApplicationsData: z.array(analyseApplicantionOutput),
  }),
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData: { incompleteApplicationsData } }) => {
    for (let mail of incompleteApplicationsData) {
      if (!mail.userEmail) continue;

      const missingResume = !mail.hasResume;
      const missingCoverLetter = !mail.hasCoverLetter;
      const unclearPosition = !mail.job_title || mail.job_title === "unclear";
      const missingDetailsCount = [
        missingResume,
        missingCoverLetter,
        unclearPosition,
      ].filter(Boolean).length;

      console.log(
        "application with missing details in pre stage workflow",
        mail
      );
      console.log("missingDetailsCount", missingDetailsCount);

      // if (missingDetailsCount > 1) {
      //   await sendThreadReplyEmail({
      //     name: mail.name || "",
      //     position: mail.job_title || "unclear",
      //     userEmail: mail.userEmail,
      //     subject: mail.subject,
      //     threadId: mail.threadId,
      //     emailId: mail.id,
      //     inReplyTo: mail.messageId,
      //     references: [mail.messageId],
      //     templateId: "templates-rejection-missing_multiple_details",
      //     addLabelIds: ["Pre-Stage"],
      //   });
      // } else if (missingResume) {
      //   await sendThreadReplyEmail({
      //     name: mail.name || "",
      //     position: mail.job_title || "unclear",
      //     userEmail: mail.userEmail,
      //     subject: mail.subject,
      //     threadId: mail.threadId,
      //     emailId: mail.id,
      //     inReplyTo: mail.messageId,
      //     references: [mail.messageId],
      //     templateId: "templates-rejection-no_resume",
      //     addLabelIds: ["Pre-Stage"],
      //   });
      // } else if (missingCoverLetter) {
      //   await sendThreadReplyEmail({
      //     name: mail.name || "",
      //     position: mail.job_title || "unclear",
      //     userEmail: mail.userEmail,
      //     subject: mail.subject,
      //     threadId: mail.threadId,
      //     emailId: mail.id,
      //     inReplyTo: mail.messageId,
      //     references: [mail.messageId],
      //     templateId: "templates-rejection-no_cover_letter",
      //     addLabelIds: ["Pre-Stage"],
      //   });
      // } else if (unclearPosition) {
      //   await sendThreadReplyEmail({
      //     name: mail.name || "",
      //     position: mail.job_title || "unclear",
      //     userEmail: mail.userEmail,
      //     subject: mail.subject,
      //     threadId: mail.threadId,
      //     emailId: mail.id,
      //     inReplyTo: mail.messageId,
      //     references: [mail.messageId],
      //     templateId: "templates-rejection-no_clear_job_position",
      //     addLabelIds: ["Pre-Stage"],
      //   });
      // } else {
      //   continue;
      // }
    }

    return "applicants rejected successfully and migrated to rejected applicants";
  },
});

const markApplicationAsUnclear = createStep({
  id: "mark-application-as-unclear",
  description: "marks applications as unclear application in Gmail",
  inputSchema: z.object({
    applicantsWithKeys: z.array(analyseApplicantsOutput),
    rejectedWithoutKeys: z.array(analyseApplicantsOutput),
    applicantsData: z.array(analyseApplicantionOutput),
    incompleteApplicationsData: z.array(analyseApplicantionOutput),
  }),
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData: { rejectedWithoutKeys } }) => {
    const mailsToMarkAsUnclear = rejectedWithoutKeys.filter(
      (mail) => mail.id && mail.threadId
    );

    for (let mail of mailsToMarkAsUnclear) {
      const existingLabels = mail.labels?.filter(
        (label) =>
          !["Inbox", "Unread", "ALL", "INBOX", "UNREAD"].includes(label) &&
          label !== "Unclear Applications"
      ) || ["Stage1 Interview"];

      await modifyEmailLabels({
        emailId: mail.id,
        threadId: mail.threadId,
        addLabelIds: ["Unclear Applications"],
        removeLabelIds: existingLabels,
      });
    }

    return "applicants marked as unclear";
  },
});

const trackReplyMailsWorkflow = createWorkflow({
  id: "track-reply-mails-workflow",
  description:
    "Workflow to handle recruitment tasks with an agent triggered by Gmail events",
  inputSchema: z.boolean().describe("Signal to start the workflow"),
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  steps: [AgentTrigger],
  retryConfig: {
    attempts: 5,
    delay: 5000,
  },
})
  .then(AgentTrigger)
  // .then(deduplicateNewlyArrivedMails)
  .foreach(extractEmailMetaData)
  .then(sortReplyEmails)
  .branch([
    [
      async ({ inputData: { applicants } }) => applicants.length > 0,
      analyseApplicants,
    ],
    [
      async ({ inputData: { incompleteApplications } }) =>
        incompleteApplications.length > 0,
      analyseIncompleteApplications,
    ],
  ])
  .then(mergeResults)
  .branch([
    [
      async ({ inputData: { applicantsWithKeys } }) =>
        applicantsWithKeys.length > 0,
      migrateApplicantsWithKeyDetails,
    ],
    [
      async ({ inputData: { applicantsData } }) => applicantsData.length > 0,
      migrateConfirmedApplicants,
    ],
    [
      async ({ inputData: { rejectedWithoutKeys } }) =>
        rejectedWithoutKeys.length > 0,
      markApplicationAsUnclear,
    ],
    [
      async ({ inputData: { incompleteApplicationsData } }) =>
        incompleteApplicationsData.length > 0,
      informToReApply,
    ],
    // [
    //   async ({ inputData: { rejectedWithoutKeys } }) =>
    //     rejectedWithoutKeys.length > 0,
    //   informToResend,
    // ],
  ]);

trackReplyMailsWorkflow.commit();

export { trackReplyMailsWorkflow };
