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
      q: `label:"Stage1 Interview" OR label:"Pre-Stage" -label:Rejected -label:High Salary Expectation`,
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
      let resumeWebUrl = "";
      for (const message of threadMessages) {
        const attachmentIds = (message.payload?.parts || [])
          .filter((p) =>
            containsKeyword({
              text: p.filename || "",
              keywords: ["resume", "Resume", "cv", "CV"],
            })
          )
          .map((p) => ({
            id: p.body?.attachmentId ? p.body.attachmentId : "",
            filename: p.filename || "",
          }));
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

        const plainTextPart =
          message.payload?.parts
            ?.find((p) => p.mimeType === "multipart/alternative")
            ?.parts?.find((p2) => p2.mimeType === "text/plain") ||
          message.payload?.parts?.find((p) => p.mimeType === "text/plain");

        const decodedBody = decodeEmailBody(plainTextPart).split("On")[0];

        const urlRegex = /https?:\/\/[^\s]+/g;
        const urls = decodedBody.match(urlRegex);
        resumeWebUrl = urls?.find((url) => url.endsWith(".pdf")) || "";

        if (resumeAttachment || resumeWebUrl) break;
      }

      let parsedResumeContent = null;
      if (resumeAttachment) {
        const resumeExtractionResult = await extractTextFromAttachment({
          filename: resumeAttachment?.filename ?? "",
          attachment: resumeAttachment?.attachment ?? "",
          webUrl: resumeWebUrl,
        });

        if (!resumeExtractionResult) {
          console.warn("Unable to parse resume, skipping this mail");
          continue;
        }

        parsedResumeContent = resumeExtractionResult;
      } else if (resumeWebUrl) {
        const resumeExtractionResult = await extractTextFromAttachment({
          webUrl: resumeWebUrl,
        });

        if (!resumeExtractionResult) {
          console.warn("Unable to parse resume, skipping this mail");
          continue;
        }
        parsedResumeContent = resumeExtractionResult;
      } else {
        console.warn("Unable to parse resume, skipping this mail");
        continue;
      }

      if (!parsedResumeContent) {
        console.warn("Unable to parse resume, skipping this mail");
        continue;
      }

      try {
        const { currentCTC, expectedCTC, position, workExp } = keyDetails;

        // Validate input details
        const isMeaningful = (value: string) =>
          value &&
          value.trim() &&
          !["N/A", "NA", "na", "n/a", "null", "undefined"].includes(
            value.toLowerCase()
          );

        const meaningfulCurrentCTC = isMeaningful(currentCTC)
          ? currentCTC
          : "Not provided";
        const meaningfulExpectedCTC = isMeaningful(expectedCTC)
          ? expectedCTC
          : "Not provided";
        const meaningfulJobPosition = isMeaningful(position)
          ? position
          : "Not provided";
        const meaningfulWorkExperience = isMeaningful(workExp)
          ? workExp
          : "Not provided";

        try {
          // Prepare candidate details
          const resumeText =
            parsedResumeContent || "No resume content provided.";
          const currentCTC = meaningfulCurrentCTC;
          const expectedCTC = meaningfulExpectedCTC;
          const jobPosition = meaningfulJobPosition;
          const workExperience = meaningfulWorkExperience;

          // Construct the prompt for the agent with detailed task description
          const prompt = `TASK: Advanced Recruitment AI Screening Assistant

You are tasked with performing a comprehensive candidate screening process using multiple tools. This involves four main steps:

1. FIND RELEVANT JOB OPENINGS:
   - Use the RAG system to search for job openings that match the candidate's applied position
   - The candidate has applied for: ${jobPosition}
   - Compare the job requirements with the candidate's qualifications

2. EXTRACT KEY TECHNOLOGIES:
   - From the job opening and candidate's resume, identify key technologies, frameworks, and skills
   - Focus on the most important technologies (limit to top 3-4 to conserve tokens)

3. GET LATEST DOCUMENTATION:
   - For each key technology, use the context7_resolve-library-id tool to get the library ID
   - Then use context7_get-library-docs to retrieve the latest documentation
   - This ensures questions are based on current best practices and features

4. GENERATE TARGETED INTERVIEW QUESTIONS:
   - Create questions that assess the candidate's knowledge of the latest features
   - Questions should test both theoretical understanding and practical application
   - Consider the candidate's experience level and projects mentioned in the resume

CANDIDATE INFORMATION:
Resume Content: ${resumeText}
Current CTC: ${currentCTC}
Expected CTC: ${expectedCTC}
Job Position Applying For: ${jobPosition}
Work Experience: ${workExperience}

Your goal is to produce a JSON response that indicates whether a relevant job opening was found and includes interview questions based on the latest documentation.`;

          // Call the agent to generate a response with clear instructions
          const result = await agent.generate(prompt, {
            instructions: `Follow these instructions precisely to complete the advanced recruitment screening task:

STEP 1: SEARCH FOR JOB OPENINGS
- Use the rag_query_documents tool to search for job openings matching "${jobPosition}"
- Pass the exact job position as the query parameter
- Wait for the tool results before proceeding

STEP 2: ANALYZE SEARCH RESULTS
- Case A: No job openings found
  * Return this exact JSON: {"jobOpeningFound": false, "jobTitle": "", "jobDescription": "", "interviewQuestions": []}
  * Do not proceed to further steps

- Case B: Job openings found
  * Select the most relevant job opening from the results
  * Extract the exact job title and description from the document
  * Identify key technologies, frameworks, and skills required for the position
  * Also note technologies mentioned in the candidate's resume
  * Proceed to Step 3

- Case C: rag_query_documents tool fails or is unavailable
  * Use the provided job position "${jobPosition}" and candidate's resume to identify key technologies
  * Proceed to Step 3

STEP 3: GET LATEST DOCUMENTATION
- For each key technology (limit to top 3-4 most important ones):
  * Use context7_resolve-library-id to get the library ID for the technology
  * Then use context7_get-library-docs to retrieve the latest documentation
  * Focus on recent updates, best practices, and advanced features
- If any documentation tool fails, proceed with available information

STEP 4: GENERATE INTERVIEW QUESTIONS
- Create 5-8 targeted interview questions based on:
  * Job requirements from Step 2
  * Candidate's skills and experience from the resume
  * Latest documentation and best practices from Step 3
- Questions should test:
  * Knowledge of recent features and updates
  * Practical application of technologies
  * Problem-solving abilities in relevant domains
  * Understanding of best practices

STEP 5: FORMAT RESPONSE
- Return this JSON format: {"jobOpeningFound": true, "jobTitle": "[EXACT JOB TITLE]", "jobDescription": "[EXACT JOB DESCRIPTION]", "interviewQuestions": ["QUESTION 1", "QUESTION 2", ...]}
- If you couldn't get job opening details, use: {"jobOpeningFound": true, "jobTitle": "${jobPosition}", "jobDescription": "Position based on candidate's application", "interviewQuestions": ["QUESTION 1", "QUESTION 2", ...]}

CRITICAL REQUIREMENTS:
- Return ONLY valid JSON with no additional text, explanations, or formatting
- Ensure proper JSON syntax (correct quotes, commas, brackets)
- Questions must be specific to both job requirements and candidate's profile
- Incorporate insights from the latest documentation when available
- Always return a valid JSON response, even if some tools fail

EXAMPLE RESPONSES:
1. No job found: {"jobOpeningFound": false, "jobTitle": "", "jobDescription": "", "interviewQuestions": []}
2. Job found with documentation: {"jobOpeningFound": true, "jobTitle": "React Developer", "jobDescription": "Develop web applications using React", "interviewQuestions": ["How would you implement React Hooks in a complex component?", "What are the performance implications of the new React concurrent features?"]}
3. Tools failed: {"jobOpeningFound": true, "jobTitle": "Python Developer", "jobDescription": "Position based on candidate's application", "interviewQuestions": ["Describe your experience with Python frameworks?"]}

PERFORMANCE NOTES:
- Prioritize getting documentation for the most important technologies only
- Focus on generating high-quality, role-specific questions
- Ensure questions assess both technical skills and practical application
- Keep questions concise and directly related to the job requirements`,
            maxSteps: 5, // Increased to accommodate multiple tool calls
            maxTokens: 1000, // Increased to handle more detailed responses
            temperature: 0.3,
          });

          // Try to parse the result as JSON with enhanced error handling
        console.log("AI response:", result.text);
        } catch (err) {
          console.error("Error occurred while AI screening:", err);

          // Provide a fallback response in case of error
          const fallbackResponse = {
            jobOpeningFound: true,
            jobTitle: keyDetails.position || "Unknown Position",
            jobDescription: "Position based on candidate's application",
            interviewQuestions: [
              "Can you describe your relevant experience?",
              "What technical skills do you bring to this role?",
              "How do you handle challenging situations at work?",
            ],
          };

          console.log("Fallback response:", JSON.stringify(fallbackResponse));
        }
        //   // Try to parse the result as JSON
        //   let parsedResult;
        //   try {
        //     // First, clean the response to remove any non-JSON content
        //     let cleanResponse = result.text;

        //     // Remove any numbered list formatting if present
        //     cleanResponse = cleanResponse.replace(/^\d+\.\s*/gm, "");
        //     cleanResponse = cleanResponse.replace(/^\s*\n\s*/gm, "");

        //     // Try to find JSON object in the response
        //     const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
        //     if (jsonMatch) {
        //       parsedResult = JSON.parse(jsonMatch[0]);
        //     } else {
        //       throw new Error("No JSON found in response");
        //     }

        //     console.log(
        //       "result of ai screening of candidate profile:",
        //       JSON.stringify(parsedResult)
        //     );
        //   } catch (parseError) {
        //     console.error("Failed to parse AI response as JSON:", parseError);
        //     console.log("Raw response:", result.text);

        //     // Try to extract questions from the response if JSON parsing fails
        //     const questions = result.text
        //       .split("\n")
        //       .filter((line) => line.trim())
        //       .map((line) => line.replace(/^\d+\.\s*/, "").trim())
        //       .filter((q) => q.length > 10 && q.includes("?"))
        //       .slice(0, 8);

        //     // Create a valid JSON response
        //     parsedResult = {
        //       jobOpeningFound: true,
        //       jobTitle: meaningfulJobPosition,
        //       jobDescription: "Position based on candidate's application",
        //       interviewQuestions:
        //         questions.length > 0
        //           ? questions
        //           : [
        //               "Can you describe your relevant experience?",
        //               "What technical skills do you bring to this role?",
        //               "How do you handle challenging situations at work?",
        //             ],
        //     };
        //     console.log(
        //       "Extracted questions response:",
        //       JSON.stringify(parsedResult)
        //     );
        //   }
        // } catch (err) {
        //   console.error(
        //     "Error occurred while generating interview questions:",
        //     err
        //   );

        // Fallback response in case of error
        const fallbackResponse = {
          jobOpeningFound: true,
          jobTitle: keyDetails.position || "Unknown Position",
          jobDescription: "Position based on candidate's application",
          interviewQuestions: [
            "Can you describe your relevant experience?",
            "What technical skills do you bring to this role?",
            "How do you handle challenging situations at work?",
          ],
        };
        console.log("Fallback response:", JSON.stringify(fallbackResponse));
      } catch (err) {
        console.error(
          "Error occurred while generating interview questions:",
          err
        );
        const fallbackResponse = {
          jobOpeningFound: true,
          jobTitle: keyDetails.position || "Unknown Position",
          jobDescription: "Position based on candidate's application",
          interviewQuestions: [
            "Can you describe your relevant experience?",
            "What technical skills do you bring to this role?",
            "How do you handle challenging situations at work?",
          ],
        };
        console.log("Fallback response:", JSON.stringify(fallbackResponse));
      }

      const applicationCategory = mail.keyDetails?.position
        ? `${mail.keyDetails?.position?.replaceAll(" ", "_").toUpperCase()}_APPLICANTS`
        : "";

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
