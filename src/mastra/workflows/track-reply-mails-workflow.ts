import { createStep, createWorkflow } from "@mastra/core";
import z from "zod";
import {
  containsKeyword,
  getEmailContent,
  getLabelNames,
  getThreadMessages,
  gmailSearchEmails,
  sendThreadReplyEmail,
} from "../../utils/gmail";
import { redis } from "../../queue/connection";
import { decodeEmailBody, extractJsonFromResult } from "./recruit-workflowV3";

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

if (!recruitmentMail) {
  throw new Error("RECRUITMENT_MAIL environment variable is not set");
}

const AgentTrigger = createStep({
  id: "agent-trigger",
  description:
    "Triggers the agent when new reply mails arrive to handle recruitment tasks",
  inputSchema: z.boolean().describe("Signal to start the workflow"),
  outputSchema: z
    .array(
      z.object({
        emailId: z.string().nullable().optional(),
        threadId: z.string().nullable().optional(),
      })
    )
    .describe("Array of email IDs and thread IDs"),
  execute: async ({ inputData }) => {
    if (!inputData) {
      console.error("No signal found for agent-trigger step");
      return [{ emailId: "", threadId: "" }];
    }

    const searchInboxInput = {
      userId: "me",
      q: `label:APPLICANTS OR label:INCOMPLETE_APPLICATIONS`,
      maxResults: 100,
    };
    try {
      const searchResult = await gmailSearchEmails(searchInboxInput);
      return searchResult.filter(
        ({ emailId, threadId }) => emailId && threadId
      );
    } catch (err) {
      console.log(err);
      return [{ emailId: "", threadId: "" }];
    }
  },
});

const deduplicateNewlyArrivedMails = createStep({
  id: "deduplicate-newly-arrived-mails",
  description: "Deduplicates newly arrived emails",
  inputSchema: z
    .array(
      z.object({
        emailId: z.string().nullable().optional(),
        threadId: z.string().nullable().optional(),
      })
    )
    .describe("Email ID and thread ID array to deduplicate"),
  outputSchema: z
    .array(
      z.object({
        emailId: z.string().nullable().optional(),
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

    const deduplicatedEmails: { emailId: string; threadId: string }[] = [];
    for (let mail of inputData) {
      if (!mail || !mail.emailId || !mail.threadId) continue;

      const { emailId, threadId } = mail;

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
          emailId,
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
    emailId: z.string(),
    threadId: z.string(),
    labels: z.array(z.string()),
  })
  .nullable()
  .describe("Extracted email metadata");

const extractEmailMetaData = createStep({
  id: "extract-email-meta-data",
  description: "Extracts email metadata by email ID and thread ID",
  inputSchema: z.object({
    emailId: z.string().nullable().optional(),
    threadId: z.string().nullable().optional(),
  }),
  outputSchema: ExtractEmailMetaDataOutput,
  execute: async ({ inputData }) => {
    if (!inputData || Object.values(inputData).some((v) => !v || !v.trim())) {
      console.log(
        "Email ID or thread ID not found for extract-email-meta-data step",
        inputData
      );
      return null;
    }

    try {
      const { emailId, threadId } = inputData;

      const originalEmail = await getEmailContent(emailId!);
      const threadMessages = (await getThreadMessages(threadId!)) || [];

      const latestThreadEmail = threadMessages[threadMessages.length - 1];
      if (!latestThreadEmail || !originalEmail) {
        return null;
      }

      const labels = await getLabelNames(originalEmail.labelIds || []);

      const userEmail = latestThreadEmail.payload?.headers
        ?.find((h) => h.name === "From")
        ?.value?.split("<")[1]
        ?.replace(">", "");

      const username = latestThreadEmail.payload?.headers
        ?.find((h) => h.name === "From")
        ?.value?.split("<")[0]
        .trim();

      if (userEmail === recruitmentMail || username === recruitmentMail)
        return null;

      const emailMetaData = {
        emailId: latestThreadEmail.id || emailId || "",
        threadId: latestThreadEmail.threadId || threadId || "",
        labels: labels || [],
      };

      const filteredEmails = emailMetaData.labels.some(
        (label) =>
          label === "INCOMPLETE_APPLICATIONS" ||
          label === "APPLICANTS"
      );

      if (!filteredEmails) {
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
  rejectedApplicants: z.array(ExtractEmailMetaDataOutput),
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
        rejectedApplicants: [],
      };
    }

    try {
      const applicants = inputData.filter(
        (email) => email && email.labels.includes("APPLICANTS")
      );
      const rejectedApplicants = inputData.filter(
        (email) =>
          email &&
          email.labels.includes(
            "INCOMPLETE_APPLICATIONS"
          )
      );

      return {
        applicants,
        rejectedApplicants,
      };
    } catch (err) {
      console.log(err);
      return {
        applicants: [],
        rejectedApplicants: [],
      };
    }
  },
});

const analyzeApplicantsOutput = z.object({
  emailId: z.string(),
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

const analyzeApplicants = createStep({
  id: "analyze-applicants",
  description: "Analyzes applicants",
  inputSchema: sortReplyEmailsOutput,
  outputSchema: z.object({
    applicantsData: z.array(analyzeApplicantsOutput),
    rejectedApplicantsData: z.array(analyzeApplicantsOutput),
  }),
  execute: async ({ inputData: { applicants }, mastra }) => {
    if (!applicants || !applicants.length) {
      throw Error("Applicant mails not found");
    }

    const applicantsData: z.infer<typeof analyzeApplicantsOutput>[] = [];
    const rejectedApplicantsData: z.infer<typeof analyzeApplicantsOutput>[] =
      [];

    for (let mail of applicants) {
      if (!mail || !mail.threadId) continue;

      const threadMessages = (await getThreadMessages(mail.threadId)) || [];

      if (threadMessages.length === 0) continue;

      const latestThreadMessage = threadMessages[threadMessages.length - 1];

      // --------------------------------------------------------------------
      // DATA EXTRACTION

      const userEmail = latestThreadMessage.payload?.headers
        ?.find((h) => h.name === "From")
        ?.value?.split("<")[1]
        ?.replace(">", "");

      const name = latestThreadMessage.payload?.headers
        ?.find((h) => h.name === "From")
        ?.value?.split("<")[0]
        .trim();

      if (userEmail === recruitmentMail || name === recruitmentMail) continue;

      const subject = latestThreadMessage.payload?.headers?.find(
        (h) => h.name === "Subject"
      )?.value;

      const plainTextPart =
        latestThreadMessage.payload?.parts
          ?.find((p) => p.mimeType === "multipart/alternative")
          ?.parts?.find((p2) => p2.mimeType === "text/plain") ||
        latestThreadMessage.payload?.parts?.find(
          (p) => p.mimeType === "text/plain"
        );

      const decodedBody = decodeEmailBody(plainTextPart);

      const gmailGroqAgent = mastra.getAgent("gmailGroqAgent");

      const emailMetaData: z.infer<typeof analyzeApplicantsOutput> = {
        emailId: latestThreadMessage.id || "",
        threadId: latestThreadMessage.threadId || "",
        labels: mail.labels,
        userEmail: userEmail ?? null,
        name: name ?? null,
        subject: subject ?? null,
        body: decodedBody ?? null,
      };

      if (!gmailGroqAgent) throw Error("Groq Agent not found");

      try {
        const result = await gmailGroqAgent.generate(
          `Extract key details from the following email body:\n\n${
            decodedBody.split("On")[0]
          }`,
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

        const missingKeyDetails = Object.values(extractedDetails).some(
          (value) => value === "Not Provided" || value === "unclear"
        );

        if (missingKeyDetails) {
          rejectedApplicantsData.push(emailMetaData);
          continue;
        }

        emailMetaData.keyDetails = extractedDetails;

        applicantsData.push(emailMetaData);
      } catch (e) {
        console.error("Error extracting key details from email:", e);
        rejectedApplicantsData.push(emailMetaData);
      }
    }
    return {
      applicantsData,
      rejectedApplicantsData,
    };
  },
});

const analyzeApplicantionOutput = z.object({
  emailId: z.string(),
  threadId: z.string(),
  labels: z.array(z.string()),
  userEmail: z.string().nullable(),
  name: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  attachment_filename: z.array(z.string().nullable().optional()).nullable(),
  attachmentId: z.array(z.string().nullable().optional()).nullable(),
  hasCoverLetter: z.boolean(),
  hasResume: z.boolean(),
  position: z.string().nullable(),
});

const analyzeRejectedApplicants = createStep({
  id: "analyze-rejected-applicants",
  description: "Analyzes rejected applicants",
  inputSchema: sortReplyEmailsOutput,
  outputSchema: z.object({
    applicantsData: z.array(analyzeApplicantionOutput),
    rejectedApplicantsData: z.array(analyzeApplicantionOutput),
  }),
  execute: async ({ inputData: { rejectedApplicants }, mastra }) => {
    if (!rejectedApplicants || !rejectedApplicants.length) {
      return {
        applicantsData: [],
        rejectedApplicantsData: [],
      };
    }

    const applicantsData: z.infer<typeof analyzeApplicantionOutput>[] = [];
    const rejectedApplicantsData: z.infer<typeof analyzeApplicantionOutput>[] =
      [];

    for (let mail of rejectedApplicants) {
      if (!mail || !mail.threadId) continue;

      const threadMessages = (await getThreadMessages(mail.threadId)) || [];

      if (threadMessages.length === 0) continue;

      const latestThreadMessage = threadMessages[threadMessages.length - 1];
      // --------------------------------------------------------------------
      // DATA EXTRACTION

      const userEmail = latestThreadMessage.payload?.headers
        ?.find((h) => h.name === "From")
        ?.value?.split("<")[1]
        ?.replace(">", "");

      const name = latestThreadMessage.payload?.headers
        ?.find((h) => h.name === "From")
        ?.value?.split("<")[0]
        .trim();

      if (userEmail === recruitmentMail || name === recruitmentMail) continue;

      const subject = latestThreadMessage.payload?.headers?.find(
        (h) => h.name === "Subject"
      )?.value;

      const plainTextPart =
        latestThreadMessage.payload?.parts
          ?.find((p) => p.mimeType === "multipart/alternative")
          ?.parts?.find((p2) => p2.mimeType === "text/plain") ||
        latestThreadMessage.payload?.parts?.find(
          (p) => p.mimeType === "text/plain"
        );

      const decodedBody = decodeEmailBody(plainTextPart);

      const attachment_filename = latestThreadMessage.payload?.parts
        ?.filter((p) => p.filename)
        .map((p) => p.filename);
      const attachmentId = latestThreadMessage.payload?.parts
        ?.filter((p) => p.body?.attachmentId)
        .map((p) => p.body?.attachmentId);

      const hasCoverLetter = containsKeyword({
        text: decodedBody,
        keywords: [
          "cover letter",
          "resume",
          "cv",
          "job application",
          "job",
          "application",
          "work experience",
          "skills",
          "education",
          "about me",
          "summary",
          "objective",
          "job description",
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
        ],
      });
      const hasResume =
        attachmentId?.length && attachment_filename?.length
          ? containsKeyword({
              text: attachment_filename?.[0] || "",
              keywords: ["resume", "cv"],
            }) ||
            containsKeyword({
              text: decodedBody || "",
              keywords: [
                "resume attached",
                "cv attached",
                "please find my resume",
                "attached is my resume",
              ],
            })
          : false;

      const emailMetaData = {
        emailId: latestThreadMessage.id || "",
        threadId: latestThreadMessage.threadId || "",
        labels: mail.labels,
        userEmail: userEmail ?? null,
        name: name ?? null,
        subject: subject ?? null,
        body: decodedBody ?? null,
        attachment_filename: attachment_filename || [],
        attachmentId: attachmentId || [],
        hasCoverLetter,
        hasResume,
        position: "unclear",
      };

      if (!hasCoverLetter && !hasResume) {
        rejectedApplicantsData.push(emailMetaData);
        continue;
      }

      // --------------------------------------------------------------------
      // Job position extraction

      try {
        const grokAgent = mastra.getAgent("gmailGroqAgent");

        const result = await grokAgent.generate(
          "Analyze the email subject and body to determine the most likely job title the candidate is applying for. Output only a JSON object with the job title or 'unclear'.",
          {
            instructions: `
      You are given the subject and body of a job application email. Your task is to determine the most likely job title the candidate is applying for.
      - Use explicit mentions, strong contextual clues, and careful reasoning to infer the job title.
      - Only infer a job title if there is clear, unambiguous evidence in the subject or body (such as direct statements, repeated references, or a clear match between skills/experience and a standard job title).
      - Do not guess or invent job titles that are not clearly supported by the content.
      - Do not use any tools, functions, or API calls. Only analyze the provided subject and body.
      - Normalize job titles to standard forms (e.g., "Full Stack Web Developer" and "Full Stack Developer" are equivalent).
      - If multiple job titles are possible, return the one most strongly indicated by the content.
      - If no job title can be reasonably and confidently inferred, return 'unclear'.
      - Output only a JSON object in the following format: {"job_title": "<job title or 'unclear'>"}
      Examples:
      Subject: "Applying for full stack developer"
      Body: "I am writing to express my interest in the Full Stack Web Developer role. My background in both front-end and back-end development positions me to contribute effectively to your team."
      Output: {"job_title": "Full Stack Developer"}

      Subject: "Application for Data Scientist"
      Body: "I am interested in the Data Scientist role."
      Output: {"job_title": "Data Scientist"}

      Subject: "Job application"
      Body: "I am writing to express my interest in a position at your company. My experience is in software development and I have worked as a Frontend Developer."
      Output: {"job_title": "Frontend Developer"}

      Subject: "Job application"
      Body: "I am writing to express my interest in a position at your company. I have experience in several areas of technology."
      Output: {"job_title": "unclear"}

      Subject: "Question about your company"
      Body: "I am interested in learning more about your services."
      Output: {"job_title": "unclear"}

      Subject: ${subject}
      Body: ${decodedBody}
    `,
            maxSteps: 10,
            maxTokens: 50,
          }
        );
        const jobPosition: { job_title: string } = extractJsonFromResult(
          result.text
        );

        if (
          !hasCoverLetter ||
          !hasResume ||
          jobPosition.job_title === "unclear" ||
          !jobPosition.job_title
        ) {
          rejectedApplicantsData.push({
            ...emailMetaData,
            hasCoverLetter,
            hasResume,
            position: jobPosition.job_title || "unclear",
          });
        } else {
          applicantsData.push({
            ...emailMetaData,
            hasCoverLetter,
            hasResume,
            position: jobPosition.job_title || "unclear",
          });
        }
      } catch (err) {
        console.log("error occured while extracting job title", err);
        rejectedApplicantsData.push({
          ...emailMetaData,
          hasCoverLetter,
          hasResume,
          position: null,
        });
      }
    }

    return {
      applicantsData,
      rejectedApplicantsData,
    };
  },
});

const mergeResults = createStep({
  id: "merge-results",
  description: "Merges the results of the two branches",
  inputSchema: z.object({
    "analyze-rejected-applicants": z.object({
      applicantsData: z.array(analyzeApplicantionOutput),
      rejectedApplicantsData: z.array(analyzeApplicantionOutput),
    }),
    "analyze-applicants": z.object({
      applicantsData: z.array(analyzeApplicantsOutput),
      rejectedApplicantsData: z.array(analyzeApplicantsOutput),
    }),
  }),
  outputSchema: z
    .object({
      applicantsWithKeys: z.array(analyzeApplicantsOutput),
      rejectedWithoutKeys: z.array(analyzeApplicantsOutput),
      applicantsData: z.array(analyzeApplicantionOutput),
      rejectedApplicantsData: z.array(analyzeApplicantionOutput),
    })
    .describe("Final output of the recruitment workflow"),
  execute: async ({ inputData }) => {
    if (Object.keys(inputData).length === 0) {
      return {
        applicantsWithKeys: [],
        rejectedWithoutKeys: [],
        applicantsData: [],
        rejectedApplicantsData: [],
      };
    }
    const analyzeRejectedApplicants = inputData["analyze-rejected-applicants"];
    const analyzeApplicants = inputData["analyze-applicants"];

    const applicantsData =
      analyzeRejectedApplicants?.applicantsData?.length > 0
        ? analyzeRejectedApplicants.applicantsData
        : [];
    const rejectedApplicantsData =
      analyzeRejectedApplicants?.rejectedApplicantsData?.length > 0
        ? analyzeRejectedApplicants.rejectedApplicantsData
        : [];

    const applicantsWithKeys =
      analyzeApplicants?.applicantsData?.length > 0
        ? analyzeApplicants.applicantsData
        : [];

    const rejectedWithoutKeys =
      analyzeApplicants?.rejectedApplicantsData?.length > 0
        ? analyzeApplicants.rejectedApplicantsData
        : [];

    return {
      applicantsWithKeys,
      rejectedWithoutKeys,
      applicantsData,
      rejectedApplicantsData,
    };
  },
});

const migrateApplicantsWithKeyDetails = createStep({
  id: "migrate-applicants-with-key-details",
  description: "Migrates applicants with key details to next phase",
  inputSchema: z.object({
    applicantsWithKeys: z.array(analyzeApplicantsOutput),
    rejectedWithoutKeys: z.array(analyzeApplicantsOutput),
    applicantsData: z.array(analyzeApplicantionOutput),
    rejectedApplicantsData: z.array(analyzeApplicantionOutput),
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
    applicantsWithKeys: z.array(analyzeApplicantsOutput),
    rejectedWithoutKeys: z.array(analyzeApplicantsOutput),
    applicantsData: z.array(analyzeApplicantionOutput),
    rejectedApplicantsData: z.array(analyzeApplicantionOutput),
  }),
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData: { rejectedWithoutKeys } }) => {
    for (let mail of rejectedWithoutKeys) {
      if (!mail.userEmail) continue;

      const confirmationMailResp = await sendThreadReplyEmail({
        name: mail.name || "",
        position: mail.keyDetails?.position || "unclear",
        userEmail: mail.userEmail,
        subject: "Missing Details for Your Application",
        threadId: mail.threadId,
        emailId: mail.emailId,
        templateId: "templates-request_key_details-resend_key_details",
      });
    }

    return "Applicants informed to re-apply with required details mails sent";
  },
});

const migrateConfirmedApplicants = createStep({
  id: "migrate-confirmed-applicants",
  description: "Migrates confirmed applicants",
  inputSchema: z.object({
    applicantsWithKeys: z.array(analyzeApplicantsOutput),
    rejectedWithoutKeys: z.array(analyzeApplicantsOutput),
    applicantsData: z.array(analyzeApplicantionOutput),
    rejectedApplicantsData: z.array(analyzeApplicantionOutput),
  }),
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData: { applicantsData } }) => {
    for (let mail of applicantsData) {
      if (!mail.userEmail) continue;

      const applicationCategory = mail.position
        ? `${mail.position?.replaceAll(" ", "_").toUpperCase()}_APPLICANTS`
        : "";

      const confirmationMailResp = await sendThreadReplyEmail({
        name: mail.name || "",
        position: mail.position || "unclear",
        userEmail: mail.userEmail,
        subject: mail.subject,
        threadId: mail.threadId,
        emailId: mail.emailId,
        templateId: "templates-confirmation-job_application_received",
        addLabelIds: [applicationCategory, "APPLICANTS"],
        removeLabelIds: ["INCOMPLETE_APPLICATIONS"],
      });

      console.log("confirmationMailResp", confirmationMailResp);
    }

    return "applicants confirmed and migrated";
  },
});

const informToReApply = createStep({
  id: "inform-to-re-apply",
  description: "informs the applicant to re-apply with required details",
  inputSchema: z.object({
    applicantsWithKeys: z.array(analyzeApplicantsOutput),
    rejectedWithoutKeys: z.array(analyzeApplicantsOutput),
    applicantsData: z.array(analyzeApplicantionOutput),
    rejectedApplicantsData: z.array(analyzeApplicantionOutput),
  }),
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData: { rejectedApplicantsData } }) => {
    for (let mail of rejectedApplicantsData) {
      if (!mail.userEmail) continue;

      const missingResume = !mail.hasResume;
      const missingCoverLetter = !mail.hasCoverLetter;
      const unclearPosition = !mail.position || mail.position === "unclear";
      const missingDetailsCount = [
        missingResume,
        missingCoverLetter,
        unclearPosition,
      ].filter(Boolean).length;

      if (missingDetailsCount > 1) {
        await sendThreadReplyEmail({
          name: mail.name || "",
          position: mail.position || "unclear",
          userEmail: mail.userEmail,
          subject: mail.subject,
          threadId: mail.threadId,
          emailId: mail.emailId,
          templateId: "templates-rejection-missing_multiple_details",
          addLabelIds: ["INCOMPLETE_APPLICATIONS"],
        });
      } else if (missingResume) {
        await sendThreadReplyEmail({
          name: mail.name || "",
          position: mail.position || "unclear",
          userEmail: mail.userEmail,
          subject: mail.subject,
          threadId: mail.threadId,
          emailId: mail.emailId,
          templateId: "templates-rejection-no_resume",
          addLabelIds: ["INCOMPLETE_APPLICATIONS"],
        });
      } else if (missingCoverLetter) {
        await sendThreadReplyEmail({
          name: mail.name || "",
          position: mail.position || "unclear",
          userEmail: mail.userEmail,
          subject: mail.subject,
          threadId: mail.threadId,
          emailId: mail.emailId,
          templateId: "templates-rejection-no_cover_letter",
          addLabelIds: ["INCOMPLETE_APPLICATIONS"],
        });
      } else if (unclearPosition) {
        await sendThreadReplyEmail({
          name: mail.name || "",
          position: mail.position || "unclear",
          userEmail: mail.userEmail,
          subject: mail.subject,
          threadId: mail.threadId,
          emailId: mail.emailId,
          templateId: "templates-rejection-no_clear_job_position",
          addLabelIds: ["INCOMPLETE_APPLICATIONS"],
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
  // .foreach(extractEmailMetaData)
  // .then(sortReplyEmails)
  // .branch([
  //   [
  //     async ({ inputData: { applicants } }) => applicants.length > 0,
  //     analyzeApplicants,
  //   ],
  //   [
  //     async ({ inputData: { rejectedApplicants } }) =>
  //       rejectedApplicants.length > 0,
  //     analyzeRejectedApplicants,
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
  //     async ({ inputData: { rejectedApplicantsData } }) =>
  //       rejectedApplicantsData.length > 0,
  //     informToReApply,
  //   ],
  //   [
  //     async ({ inputData: { applicantsData } }) => applicantsData.length > 0,
  //     migrateConfirmedApplicants,
  //   ],
  // ]);

trackReplyMailsWorkflow.commit();

export { trackReplyMailsWorkflow };
