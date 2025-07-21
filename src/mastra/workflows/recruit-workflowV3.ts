import { createStep, createWorkflow } from "@mastra/core";
import z from "zod";
import {
  containsKeyword,
  getDraftTemplates,
  getEmailContent,
  gmailSearchEmails,
  modifyEmailLabels,
  sendEmail,
} from "../../utils/gmail";
import { redis } from "../../queue/connection";
import { gmail_v1 } from "googleapis";

const recruitmentMail = process.env.RECRUITMENT_MAIL;

if (!recruitmentMail) {
  throw new Error("RECRUITMENT_MAIL environment variable is not set");
}
const decodeEmailBody = (
  encodedBody: gmail_v1.Schema$MessagePart | undefined
) => {
  const bodyEncoded = encodedBody?.body?.data || "";
  return Buffer.from(bodyEncoded, "base64").toString("utf8");
};

const extractJsonFromResult = (result: string) => {
  try {
    return result ? JSON.parse(result.match(/{.*}/s)?.[0] ?? "{}") : null;
  } catch (e) {
    console.log("Error parsing result:", e);
    return null;
  }
};
const AgentTrigger = createStep({
  id: "agent-trigger",
  description:
    "Triggers the agent when new mails arrive to handle recruitment tasks",
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
      query: "label:inbox is:unread",
      labelIds: ["INBOX", "UNREAD"],
      maxResults: 100,
    };

    try {
      const searchResult = await gmailSearchEmails(searchInboxInput);

      return searchResult;
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
    .object({
      emailId: z.string().nullable().optional(),
      threadId: z.string().nullable().optional(),
    })
    .describe("Email ID and thread ID to deduplicate"),
  outputSchema: z
    .object({
      emailId: z.string(),
      threadId: z.string(),
    })
    .nullable()

    .describe("Email ID and thread ID deduplicated"),
  execute: async ({ inputData: { emailId, threadId } }) => {
    if (!emailId || !threadId) {
      console.log(
        "Email ID or thread ID not found for deduplicate-newly-arrived-mails step"
      );
      return null;
    }

    try {
      const alreadyProcessed = await redis.get(`processed_email:${emailId}`);
      if (alreadyProcessed) {
        console.log(`Email ID ${emailId} already processed, skipping`);
        return null;
      }

      await redis.set(`processed_email:${emailId}`, "1", "EX", 3600);
      return {
        emailId,
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
    emailId: z.string(),
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
  })
  .nullable()
  .describe("Extracted email metadata");

const extractEmailMetaData = createStep({
  id: "extract-email-meta-data",
  description: "Extracts email metadata by email ID and thread ID",
  inputSchema: z
    .object({
      emailId: z.string(),
      threadId: z.string(),

      // temp for testing
      // emailId: z.string().nullable().optional(),
      // threadId: z.string().nullable().optional(),
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
      const { emailId, threadId } = inputData;

      const email = await getEmailContent(emailId!);

      const userEmail = email.payload?.headers
        ?.find((h) => h.name === "From")
        ?.value?.split("<")[1]
        .replace(">", "");
      const name = email.payload?.headers
        ?.find((h) => h.name === "From")
        ?.value?.split("<")[0]
        .trim();
      const subject = email.payload?.headers?.find(
        (h) => h.name === "Subject"
      )?.value;

      const plainTextPart =
        email.payload?.parts
          ?.find((p) => p.mimeType === "multipart/alternative")
          ?.parts?.find((p2) => p2.mimeType === "text/plain") ||
        email.payload?.parts?.find((p) => p.mimeType === "text/plain");

      const decodedBody = decodeEmailBody(plainTextPart);

      const attachment_filename = email.payload?.parts
        ?.filter((p) => p.filename)
        .map((p) => p.filename);
      const attachmentId = email.payload?.parts
        ?.filter((p) => p.body?.attachmentId)
        .map((p) => p.body?.attachmentId);

      const emailMetaData = {
        emailId: emailId || email.id || "",
        threadId: threadId || email.threadId || "",
        userEmail: userEmail ?? null,
        name: name ?? null,
        subject: subject ?? null,
        body: decodedBody ?? null,
        attachment_filename: attachment_filename || [],
        attachmentId: attachmentId || [],
      };

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

        return {
          ...emailMetaData,
          hasCoverLetter,
          hasResume,
          position: jobPosition.job_title || "unclear",
        };
      } catch (err) {
        console.log("error occured while extracting job title", err);
        return {
          ...emailMetaData,
          hasCoverLetter,
          hasResume,
          position: null,
        };
      }
    } catch (err) {
      console.log(err);
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
      try {
        const rejectionTemplateMail = await getDraftTemplates({
          userId: "me",
          q: "is:draft label:templates-rejection-missing_multiple_details",
        });

        if (!rejectionTemplateMail) {
          console.log("No rejection template found");
          return "No rejection template found";
        }

        const plainTextPart = rejectionTemplateMail.payload?.parts?.find(
          (p) => p.mimeType === "text/plain"
        );
        const rejectionMailTemplate = decodeEmailBody(plainTextPart);

        const rejectionMail = rejectionMailTemplate
          .replaceAll("[Candidate Name]", mail.name ? mail.name : "Candidate")
          .replaceAll(
            "[Job Title]",
            mail.position && mail.position !== "unclear"
              ? mail.position
              : "applied"
          )
          .replaceAll("[Company Name]", "Ocode Technologies");

        const sendMailResp = await sendEmail({
          to: mail.userEmail,
          subject: `Re: ${mail.subject}`,
          body: rejectionMail,
          threadId: mail.threadId,
        });

        if (sendMailResp.id && sendMailResp.labelIds?.includes("SENT")) {
          await modifyEmailLabels({
            emailId: mail.emailId,
            addLabelIds: ["REJECTED_APPLICATIONS_DUE_TO_MISSING_DOCUMENTS"],
            removeLabelIds: ["INBOX"],
          });
        }
      } catch (err) {
        console.log(err);
      }
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
      try {
        const rejectionTemplateMail = await getDraftTemplates({
          userId: "me",
          q: "is:draft label:templates-rejection-no_resume",
        });

        if (!rejectionTemplateMail) {
          console.log("No rejection template found");
          return "No rejection template found";
        }

        const plainTextPart = rejectionTemplateMail.payload?.parts?.find(
          (p) => p.mimeType === "text/plain"
        );
        const rejectionMailTemplate = decodeEmailBody(plainTextPart);

        const rejectionMail = rejectionMailTemplate
          .replaceAll("[Candidate Name]", mail.name ? mail.name : "Candidate")
          .replaceAll(
            "[Job Title]",
            mail.position && mail.position !== "unclear"
              ? mail.position
              : "applied"
          )
          .replaceAll("[Company Name]", "Ocode Technologies");

        const sendMailResp = await sendEmail({
          to: mail.userEmail,
          subject: `Re: ${mail.subject}`,
          body: rejectionMail,
          threadId: mail.threadId,
        });

        if (sendMailResp.id && sendMailResp.labelIds?.includes("SENT")) {
          await modifyEmailLabels({
            emailId: mail.emailId,
            addLabelIds: ["REJECTED_APPLICATIONS_DUE_TO_MISSING_DOCUMENTS"],
            removeLabelIds: ["INBOX"],
          });
        }
      } catch (err) {
        console.log(err);
      }
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
      try {
        const rejectionTemplateMail = await getDraftTemplates({
          userId: "me",
          q: "is:draft label:templates-rejection-no_cover_letter",
        });

        if (!rejectionTemplateMail) {
          console.log("No rejection template found");
          return "No rejection template found";
        }

        const plainTextPart = rejectionTemplateMail.payload?.parts?.find(
          (p) => p.mimeType === "text/plain"
        );
        const rejectionMailTemplate = decodeEmailBody(plainTextPart);
        const rejectionMail = rejectionMailTemplate
          .replaceAll("[Candidate Name]", mail.name ? mail.name : "Candidate")
          .replaceAll(
            "[Job Title]",
            mail.position && mail.position !== "unclear"
              ? mail.position
              : "applied"
          )
          .replaceAll("[Company Name]", "Ocode Technologies");

        const sendMailResp = await sendEmail({
          to: mail.userEmail,
          subject: `Re: ${mail.subject}`,
          body: rejectionMail,
          threadId: mail.threadId,
        });

        if (sendMailResp.id && sendMailResp.labelIds?.includes("SENT")) {
          await modifyEmailLabels({
            emailId: mail.emailId,
            addLabelIds: ["REJECTED_APPLICATIONS_DUE_TO_MISSING_DOCUMENTS"],
            removeLabelIds: ["INBOX"],
          });
        }
      } catch (err) {
        console.log(err);
      }
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
      try {
        const rejectionTemplateMail = await getDraftTemplates({
          userId: "me",
          q: "is:draft label:templates-rejection-no_clear_job_position",
        });

        if (!rejectionTemplateMail) {
          console.log("No rejection template found");
          return "No rejection template found";
        }

        const plainTextPart = rejectionTemplateMail.payload?.parts?.find(
          (p) => p.mimeType === "text/plain"
        );
        const rejectionMailTemplate = decodeEmailBody(plainTextPart);

        const rejectionMail = rejectionMailTemplate
          .replaceAll("[Candidate Name]", mail.name ? mail.name : "Candidate")
          .replaceAll(
            "[Job Title]",
            mail.position && mail.position !== "unclear"
              ? mail.position
              : "applied"
          )
          .replaceAll("[Company Name]", "Ocode Technologies");

        const sendMailResp = await sendEmail({
          to: mail.userEmail,
          subject: `Re: ${mail.subject}`,
          body: rejectionMail,
          threadId: mail.threadId,
        });

        if (sendMailResp.id && sendMailResp.labelIds?.includes("SENT")) {
          await modifyEmailLabels({
            emailId: mail.emailId,
            addLabelIds: ["REJECTED_APPLICATIONS_DUE_TO_MISSING_DOCUMENTS"],
            removeLabelIds: ["INBOX"],
          });
        }
      } catch (err) {
        console.log(err);
      }
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
      try {
        const confirmationTemplateMail = await getDraftTemplates({
          userId: "me",
          q: "is:draft label:templates-confirmation-job_application_received",
        });

        if (!confirmationTemplateMail) {
          console.log("No confirmation template found");
          return "No confirmation template found";
        }

        const plainTextPart = confirmationTemplateMail.payload?.parts?.find(
          (p) => p.mimeType === "text/plain"
        );
        const confirmationMailTemplate = decodeEmailBody(plainTextPart);

        const confirmationMail = confirmationMailTemplate
          .replaceAll("[Candidate Name]", mail.name ? mail.name : "Candidate")
          .replaceAll(
            "[Job Title]",
            mail.position && mail.position !== "unclear"
              ? mail.position
              : "applied"
          )
          .replaceAll("[Company Name]", "Ocode Technologies");

        const sendMailResp = await sendEmail({
          to: mail.userEmail,
          subject: `Re: ${mail.subject}`,
          body: confirmationMail,
          threadId: mail.threadId,
        });

        if (sendMailResp.id && sendMailResp.labelIds?.includes("SENT")) {
          await modifyEmailLabels({
            emailId: mail.emailId,
            addLabelIds: [
              `${mail.position?.replaceAll(" ", "_").toUpperCase()}_APPLICANTS`,
            ],
            removeLabelIds: ["INBOX"],
          });
        }
      } catch (err) {
        console.log(err);
      }
    }

    return "Confirmation emails sent successfully";
  },
});

const recruitWorkflowV3 = createWorkflow({
  id: "recruit-V3",
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
      async ({ inputData: { missingCoverLetterEmails } }) =>
        missingCoverLetterEmails.length > 0,
      sendCoverLetterMissingEmail,
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

recruitWorkflowV3.commit();


const executeRecruitWorkflow = async () => {
  try {
    const workflowId = "recruitWorkflowV3";

    const res = await fetch(
      `http://localhost:4112/api/workflows/${workflowId}/start-async`,
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
    return;
  }
};

export { recruitWorkflowV3, executeRecruitWorkflow };
