import { createStep, createWorkflow } from "@mastra/core";
import z from "zod";
import {
  containsKeyword,
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
      q: `label:Stage1 Interview OR label:Pre-Stage`,
      labelIds: ["Stage1 Interview", "Pre-Stage", "Developer", "Recruiter"],
      maxResults: 20,
    };
    try {
      const searchResult = await gmailSearchEmails(searchInboxInput);
      return searchResult.filter(({ id, threadId }) => id && threadId);
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
        console.log("Email not filtered for email ID", id);
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
      interviewTime: z.string(),
      location: z.string(),
      agreement: z.string(),
      education: z.string().optional(),
      contact: z.string().optional(),
      linkedIn: z.string().optional(),
      facebook: z.string().optional(),
      callTime: z.string().optional(),
      resume: z.string().optional(),

      lastAppraisal: z.string().optional(),
      switchingReason: z.string().optional(),
      totalWorkExp: z.string().optional(),
      currLoc: z.string().optional(),
      github: z.string().optional(),
      stackOverflow: z.string().optional(),
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

      const gmailGroqAgent = mastra.getAgent("gmailGroqAgent");

      if (!gmailGroqAgent) throw Error("Groq Agent not found");

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

      if (!gmailGroqAgent) throw Error("Groq Agent not found");

      try {
        const result = await gmailGroqAgent.generate(
          `Extract key details from the following email body:\n\n${mail.body}`,
          {
            instructions: `
You are an AI agent tasked with analyzing email bodies and extracting specific key details.

Required fields: Always include these in the output JSON, even if the value is "N/A" (Not Applicable) or "unclear" (ambiguous).
- position: string
- currentCTC: string
- expectedCTC: string
- workExp: string
- interviewTime: string
- location: string
- agreement: string

Optional fields: Only include these in the output JSON if they are mentioned in the email body. If mentioned but the value is not clear, set to "unclear". If mentioned but the value is missing, set to "Not Provided". If not mentioned at all, omit the field from the output.
- education
- contact
- linkedIn
- facebook
- callTime
- resume
- lastAppraisal
- switchingReason
- totalWorkExp
- currLoc
- github
- stackOverflow

Return the result as a JSON object with the required fields and any optional fields that are present in the email body.
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
            "cover letter",
            "job application",
            "work experience",
            "skills",
            "education",
            "summary",
            "objective",
            "responsibilities",
            "keen interest",
            "strong background",
            "software development",
            "contribute positively",
            "scalable web applications",
            "optimizing database performance",
            "highly motivated",
            "detail-oriented",
            "achieving excellence",
            "qualifications",
            "dear hiring manager",
            "i am excited to apply",
            "thank you for considering",
            "my current role",
            "your team",
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

      // --------------------------------------------------------------------
      // Job position extraction

      try {
        const grokAgent = mastra.getAgent("gmailGroqAgent");

        const result = await grokAgent.generate(
          "Analyze the email subject, body and application to determine the most likely job title the candidate is applying for, experience status and category. Output only a JSON object with the job title, experience status and category or 'unclear'.",
          {
            instructions: `
      You are given the subject and body of a job application email. Your task is to determine the most likely job title the candidate is applying for, experience status and category.
      - Use explicit mentions, strong contextual clues, and careful reasoning to infer the job title, experience status and category.
      - Only infer a job title if there is clear, unambiguous evidence in the subject or body (such as direct statements, repeated references, or a clear match between skills/experience and a standard job title).
      - Do not guess or invent job titles that are not clearly supported by the content.
      - Do not use any tools, functions, or API calls. Only analyze the provided subject and body.
      - Normalize job titles to standard forms (e.g., "Full Stack Web Developer" and "Full Stack Developer" are equivalent).
      - If multiple job titles are possible, return the one most strongly indicated by the content.
      - If no job title can be reasonably and confidently inferred, return 'unclear'.
      - Determine the category based on the job title and body of the email. If unsure, return 'unclear'.
      - The category can be one of the following values: Developer, Web Designer, Recruiter, Sales / Marketing
      - Output only a JSON object in the following format: {"job_title": "<job title or 'unclear'>", "experience_status": "<fresher or experienced or 'unclear'>", "category": "<Developer or Web Designer or Recruiter or Sales / Marketing or 'unclear'>"}
      Examples:
      Subject: "Applying for full stack developer"
      Body: "I am writing to express my interest in the Full Stack Web Developer role. My background in both front-end and back-end development positions me to contribute effectively to your team."
      Output: {"job_title": "Full Stack Developer", "experience_status": "experienced", "category": "Developer"}

      Subject: "Application for Web Designer"
      Body: "I am interested in the Web Designer role."
      Output: {"job_title": "Web Designer", "experience_status": "unclear", "category": "Web Designer"}

      Subject: "Application for Recruiter Position"
      Body: "I am writing to express my interest in a position at your company. My experience is in recruitment."
      Output: {"job_title": "Recruiter", "experience_status": "unclear", "category": "Recruiter"}

      Subject: "Job application"
      Body: "I am writing to express my interest in a position at your company. My experience is in sales and marketing."
      Output: {"job_title": "Sales / Marketing", "experience_status": "unclear", "category": "Sales / Marketing"}

      Subject: ${mail.subject}
      Body: ${mail.body}
    `,
            maxSteps: 10,
            maxTokens: 50,
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
          generatedResult.job_title === "unclear" ||
          !generatedResult.job_title
        ) {
          incompleteApplicationsData.push({
            ...emailMetaData,
            hasCoverLetter,
            hasResume,
            job_title: generatedResult?.job_title || "unclear",
            experience_status: generatedResult?.experience_status || "unclear",
            category: generatedResult?.category || "unclear",
          });
        } else {
          applicantsData.push({
            ...emailMetaData,
            hasCoverLetter,
            hasResume,
            job_title: generatedResult.job_title || "unclear",
            experience_status: generatedResult.experience_status || "unclear",
            category: generatedResult.category || "unclear",
          });
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
  execute: async ({ inputData: { applicantsWithKeys } }) => {
    for (let mail of applicantsWithKeys) {
      if (!mail.userEmail) continue;

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

      console.log("mail with key details", mail);
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

      const applicationCategory =
        mail.category !== "unclear" && mail.category
          ? mail.category
          : "Unclear Applications";

      switch (mail.category) {
        case "Developer":
          const templateId =
            mail.experience_status === "experienced"
              ? "templates-request_key_details-developer-experienced"
              : mail.experience_status === "fresher"
                ? "templates-request_key_details-developer-fresher"
                : null;

          if (!templateId || !mail.job_title || mail.job_title === "unclear") {
            await modifyEmailLabels({
              emailId: mail.id,
              addLabelIds: ["Unclear Applications"],
              removeLabelIds: ["Pre-Stage"],
            });
            continue;
          }

          await sendThreadReplyEmail({
            name: mail.name || "",
            position: mail.job_title || "unclear",
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
            position: mail.job_title || "unclear",
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
            position: mail.job_title || "unclear",
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
            position: mail.job_title || "unclear",
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
            addLabelIds: ["Unclear Applications"],
            removeLabelIds: ["Pre-Stage"],
          });
          break;
      }
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

      if (missingDetailsCount > 1) {
        await sendThreadReplyEmail({
          name: mail.name || "",
          position: mail.job_title || "unclear",
          userEmail: mail.userEmail,
          subject: mail.subject,
          threadId: mail.threadId,
          emailId: mail.id,
          inReplyTo: mail.messageId,
          references: [mail.messageId],
          templateId: "templates-rejection-missing_multiple_details",
          addLabelIds: ["Pre-Stage"],
        });
      } else if (missingResume) {
        await sendThreadReplyEmail({
          name: mail.name || "",
          position: mail.job_title || "unclear",
          userEmail: mail.userEmail,
          subject: mail.subject,
          threadId: mail.threadId,
          emailId: mail.id,
          inReplyTo: mail.messageId,
          references: [mail.messageId],
          templateId: "templates-rejection-no_resume",
          addLabelIds: ["Pre-Stage"],
        });
      } else if (missingCoverLetter) {
        await sendThreadReplyEmail({
          name: mail.name || "",
          position: mail.job_title || "unclear",
          userEmail: mail.userEmail,
          subject: mail.subject,
          threadId: mail.threadId,
          emailId: mail.id,
          inReplyTo: mail.messageId,
          references: [mail.messageId],
          templateId: "templates-rejection-no_cover_letter",
          addLabelIds: ["Pre-Stage"],
        });
      } else if (unclearPosition) {
        await sendThreadReplyEmail({
          name: mail.name || "",
          position: mail.job_title || "unclear",
          userEmail: mail.userEmail,
          subject: mail.subject,
          threadId: mail.threadId,
          emailId: mail.id,
          inReplyTo: mail.messageId,
          references: [mail.messageId],
          templateId: "templates-rejection-no_clear_job_position",
          addLabelIds: ["Pre-Stage"],
        });
      } else {
        continue;
      }
    }

    return "applicants rejected successfully and migrated to rejected applicants";
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
// .branch([
//   [
//     async ({ inputData: { applicants } }) => applicants.length > 0,
//     analyseApplicants,
//   ],
//   [
//     async ({ inputData: { incompleteApplications } }) =>
//       incompleteApplications.length > 0,
//     analyseIncompleteApplications,
//   ],
// ])
// .then(mergeResults)
// .branch([
//   [
//     async ({ inputData: { applicantsWithKeys } }) =>
//       applicantsWithKeys.length > 0,
//     migrateApplicantsWithKeyDetails,
//   ],
//   [
//     async ({ inputData: { rejectedWithoutKeys } }) =>
//       rejectedWithoutKeys.length > 0,
//     informToResend,
//   ],
//   [
//     async ({ inputData: { incompleteApplicationsData } }) =>
//       incompleteApplicationsData.length > 0,
//     informToReApply,
//   ],
//   [
//     async ({ inputData: { applicantsData } }) => applicantsData.length > 0,
//     migrateConfirmedApplicants,
//   ],
// ]);

trackReplyMailsWorkflow.commit();

export { trackReplyMailsWorkflow };
