import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { gmailMcp } from "../mcpservers/gmail";
// import { config } from "dotenv";
// import path, { parse } from "path";
// import { fileURLToPath } from "url";

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// config({ path: path.resolve(__dirname, "../../../.env") });

const recruitmentMail = process.env.RECRUITMENT_MAIL;

const getGmailTrigger = createStep({
  id: "get-gmail-trigger",
  description:
    "Gets the Gmail trigger for the recruitment workflow including the history ID and the email ID",
  inputSchema: z.object({
    historyId: z
      .string()
      .describe("The Gmail history ID to use for the trigger"),
    emailAddress: z
      .string()
      .describe("The Gmail email address to use for the trigger"),
  }),
  outputSchema: z.object({
    historyId: z
      .string()
      .describe("The Gmail history ID to use for the trigger"),
    emailAddress: z
      .string()
      .describe("The Gmail email address to use for the trigger"),
  }),

  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error("Input data not found");
    }

    if (!recruitmentMail) {
      throw new Error("RECRUITMENT_MAIL environment variable is not set");
    }
    const { historyId, emailAddress } = inputData;

    return {
      historyId,
      emailAddress,
    };
  },
});

const emailIdsSchema = z.array(z.string()).describe("Array of email IDs");

const filterJobApplications = createStep({
  id: "filter-job-applications",
  description:
    "Filters job applications based on the subject and body of the email",
  inputSchema: z.object({
    historyId: z
      .string()
      .describe("The Gmail history ID to use for the trigger"),
    emailAddress: z
      .string()
      .describe("The Gmail email address to use for the trigger"),
  }),
  outputSchema: emailIdsSchema,
  execute: async ({ inputData, mastra }) => {
    if (!inputData) {
      throw new Error("Input data not found");
    }

    const { historyId, emailAddress } = inputData;

    console.log(
      "Filtering job applications for historyId:",
      historyId,
      "and emailAddress:",
      emailAddress
    );

    const gmailAgent = mastra?.getAgent("gmailAgent");

    if (!gmailAgent) {
      throw new Error("Gmail agent not found");
    }
    const response = await gmailAgent.generate(
      `Use gmail_search_emails to find recent job application emails in the last 24 hours. Search parameters: newer_than:1d, subject:application|applying|resume|job|position|cover|letter. Return Gmail message IDs as strings.`,
      {
        instructions: `You are a recruitment assistant with direct access to Gmail tools.

CRITICAL: When using gmail_search_emails tool:
- Use the search parameters exactly as provided
- Do not modify the search parameters
- Extract the Gmail MESSAGE ID (not email address) from each result
- MESSAGE ID looks like: "18c5f2a1b2d3e4f5" or "197e52c6ec8edd3e"
- DO NOT return email addresses like "vivek@ocode.co"
- DO NOT return sender addresses
- Return Gmail internal message IDs only
- Do not simulate or generate fake data
- Use the gmail_search_emails tool to search for emails

REQUIRED OUTPUT FORMAT:
["18c5f2a1b2d3e4f5", "197e52c6ec8edd3e", "1a2b3c4d5e6f7g8h"]

WHAT TO EXTRACT:
✓ Gmail message ID (alphanumeric string)
✗ Email addresses (vivek@ocode.co)
✗ Sender information
✗ Subject lines

Return the Gmail MESSAGE IDs fetched using the gmail_search_emails tool only.
If no emails found, return an empty array: []

Return only Gmail message IDs, not email addresses or sender information.`,
        maxSteps: 100,
        maxTokens: 1024,
        toolsets: await gmailMcp.getToolsets(),
      }
    );

    let result;
    try {
      result = JSON.parse(response.text);
    } catch (error) {
      console.error("Error processing email content:", error);
      return "[]";
    }
    return result;
  },
});

const FullEmailContentSchema = z.array(
  z.object({
    id: z.string(),
    threadId: z.string(),
    from: z.string(),
    to: z.string(),
    date: z.string(),
    labels: z.array(z.string()),
    subject: z.string(),
    body: z.string(),
    coverLetter: z.object({
      status: z.enum(["Provided", "Not Provided"]),
      location: z.enum(["body", "attachment", "Not Provided"]),
      attachmentId: z.string().optional(),
    }),
    resumeCV: z.object({
      status: z.enum(["Provided", "Not Provided"]),
      location: z.enum(["body", "attachment", "Not Provided"]),
      attachmentId: z.string().optional(),
    }),
  })
);

const fetchFullEmailContent = createStep({
  id: "fetch-full-email-content",
  description: "Fetches the full content of a job application email",
  inputSchema: emailIdsSchema,
  outputSchema: FullEmailContentSchema,
  execute: async ({ inputData, mastra }) => {
    if (!inputData) {
      throw new Error("Input data not found");
    }

    let parsedInput = inputData;

    if (!Array.isArray(parsedInput) || parsedInput.length === 0) {
      throw new Error("Input data must be a non-empty array of email IDs");
    }

    const serverBaseUrl = process.env.SERVER_BASE_URL;
    if (!serverBaseUrl) {
      throw new Error("SERVER_BASE_URL environment variable is not set");
    }

    try {
      const response = await fetch(`${serverBaseUrl}/validateEmailIds`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          emailIds: parsedInput,
        }),
      });

      if (!response.ok) {
        console.log(
          "Failed to validate email IDs:",
          response.status,
          response.statusText
        );
      }
      const data = await response.json();
      if (
        !data.validEmailIds ||
        !Array.isArray(data.validEmailIds) ||
        data.validEmailIds.length === 0
      ) {
        console.log("No valid email IDs found in the response");
        return "[]";
      }

      parsedInput = data.validEmailIds;
    } catch (error) {
      console.error("Error validating email IDs:", error);
    }

    console.log("Fetching full email content for IDs:", parsedInput);

    if (parsedInput.length === 0) {
      console.log("No valid email IDs found after validation");
      return "[]";
    }

    const gmailAgent = mastra?.getAgent("gmailAgent");

    if (!gmailAgent) {
      throw new Error("Gmail agent not found");
    }

    console.log("Using Gmail agent:", gmailAgent.id);

const response = await gmailAgent.generate(
  `For each email ID in ${JSON.stringify(parsedInput)}, use gmail_read_email to fetch content. IGNORE emails from ${recruitmentMail}. Return filtered email objects with cover letter and resume analysis.`,
  {
    instructions: `You are a recruitment assistant with direct access to Gmail tools.

CRITICAL FILTERING:
- IGNORE and SKIP any email where "from" field contains "${recruitmentMail}"
- DO NOT include emails sent from our recruitment address in the results
- Only process emails from external candidates
- If an email is from ${recruitmentMail}, skip it entirely and continue with next email

CRITICAL: When using gmail_read_email tool:
- Pass the email ID directly as a string for the messageId parameter
- Do NOT wrap messageId in additional objects
- Example: Use messageId: "197e52c6ec8edd3e" NOT messageId: {"messageId": "197e52c6ec8edd3e"}

PROCESSING STEPS:
1. For each email ID in ${JSON.stringify(parsedInput)}
2. Use gmail_read_email to fetch the email
3. Check if "from" field contains "${recruitmentMail}"
4. If YES → SKIP this email completely
5. If NO → Analyze content and include in results

RETURN FORMAT (only for non-recruitment emails):
[
  {
    "id": "email_id",
    "threadId": "thread_id",
    "from": "sender_email",
    "to": "recipient_email", 
    "date": "email_date",
    "labels": ["label1", "label2"],
    "subject": "email_subject",
    "body": "email_body_content",
    "coverLetter": {
      "status": "Provided" or "Not Provided",
      "location": "file_location" or "link" or "Not Provided",
      "attachmentId": "attachment_id" or "link" or "Not Provided"
    },
    "resumeCV": {
      "status": "Provided" or "Not Provided", 
      "location": "file_location" or "link" or "Not Provided",
      "attachmentId": "attachment_id" or "link" or "Not Provided"
    }
  }
]

ANALYSIS REQUIREMENTS:
- Analyze content and attachments for cover letter and resume status
- Check for links to resume files, attachments, or redirect URLs
- Verify file types for resumeCV analysis
- Set "Not Provided" if location/attachmentId unclear

CRITICAL: 
- EXCLUDE all emails from ${recruitmentMail}
- Only return external candidate emails
- Continue processing if individual emails fail to load`,
    maxSteps: 100,
    maxTokens: 1024,
    toolsets: await gmailMcp.getToolsets(),
  },
)


    console.log("Full email content response:", response.text);
    let parsedResult;

    try {
      parsedResult = JSON.parse(response.text);
    } catch (error) {
      console.error("Error processing email content:", error, response.text);
      return "[]";
    }
    return parsedResult;
  },
});

const emailEdgeCasesValidation = createStep({
  id: "email-edge-cases-validation",
  description:
    "Validates email content for edge cases (cover letter and resume not provided) and ensures proper formatting",
  inputSchema: FullEmailContentSchema,
  outputSchema: FullEmailContentSchema,
  execute: async ({ inputData: parsedInput, mastra }) => {
    if (!parsedInput) {
      throw new Error("Input data not found");
    }

    console.log("Validating email content for edge cases", parsedInput);

    if (!Array.isArray(parsedInput) || parsedInput.length === 0) {
      console.log("Input data is not an array or is empty");
      return [];
    }

    const gmailAgent = mastra?.getAgent("gmailAgent");

    if (!gmailAgent) {
      throw new Error("Gmail agent not found");
    }

    const verifiedFullEmails: typeof parsedInput = [];

    const promises = parsedInput.map(async (mail) => {
      if (!mail.id || !mail.threadId) {
        console.log("Email ID or thread ID not found");
        return;
      }

      if (!mail.from || !mail.to) {
        console.log("Email sender or recipient not found");
        return;
      }

      if(mail.from === recruitmentMail){
        console.log("Email sender is our own email");
        return;
      }

      if (
        mail.coverLetter.status === "Not Provided" &&
        mail.coverLetter.location === "Not Provided"
      ) {
        console.log("Cover letter not provided, generating a rejection email");

        const response = await gmailAgent.generate(
          `SECURITY CHECK FIRST - only reply if safe, thread ${mail.threadId}`,
          {
            instructions: `You are a recruitment assistant with Gmail access.

MANDATORY SECURITY VALIDATION (EXECUTE FIRST):

STEP 1: CHECK SENDER EMAIL
- Sender: "${mail.from}"
- Our email: "${recruitmentMail}"
- If "${mail.from}" contains "${recruitmentMail}" → STOP and return "BLOCKED: Own email"

STEP 2: CHECK SUBJECT FOR REPLIES
- Subject: "${mail.subject}"
- If subject starts with "Re: Re:" → STOP and return "BLOCKED: Multiple reply detected"
- If subject starts with "Re:" → STOP and return "BLOCKED: Already a reply"

STEP 3: CHECK EMAIL CONTENT
- If body contains "Best regards, Recruitment Team" → STOP and return "BLOCKED: Our own email content"

ONLY IF ALL SECURITY CHECKS PASS:
Then proceed with gmail_send_email for cover letter rejection.

EMAIL DATA:
From: ${mail.from}
Subject: ${mail.subject}
Body: ${mail.body}

CRITICAL ENFORCEMENT:
- DO NOT send email if any security check fails
- RETURN the block message immediately
- DO NOT proceed to gmail_send_email if blocked
- Security checks must PREVENT email sending, not just report it

IF SECURITY PASSES (sender is external candidate):
Use gmail_send_email with threading parameters for cover letter rejection.`,
            maxSteps: 100,
            maxTokens: 1024,
            toolsets: await gmailMcp.getToolsets(),
          }
        );

        console.log("Response from Gmail agent:", response.text);
        return;
      }

      if (
        mail.resumeCV.status === "Not Provided" &&
        mail.resumeCV.location === "Not Provided"
      ) {
        console.log("Resume/CV not provided, generating a rejection email");
        const response = await gmailAgent.generate(
          `USE gmail_send_email to REPLY in existing thread ${mail.threadId} with resume/CV rejection`,
          {
            instructions: `You are a recruitment assistant with Gmail access.

AVAILABLE TOOLS: gmail_send_email, gmail_draft_email, gmail_read_email, gmail_search_emails, gmail_modify_email, gmail_delete_email, gmail_list_email_labels, gmail_batch_modify_emails, gmail_batch_delete_emails, gmail_create_label, gmail_update_label, gmail_delete_label, gmail_get_or_create_label, gmail_download_attachment

CRITICAL THREADING WITH gmail_send_email:
- Use gmail_send_email function
- Set threadId parameter to: "${mail.threadId}"
- Set In-Reply-To header to: "${mail.id}"
- Set References header to: "${mail.id}"
- Subject must start with "Re: " to maintain thread

SECURITY CHECKS (MANDATORY):
1. Verify sender is NOT ${recruitmentMail}
2. Check if email has In-Reply-To header (already a reply)
3. If sender is ${recruitmentMail}, return "BLOCKED: Own email"
4. If has reply headers, return "BLOCKED: Already a reply"

EMAIL TO REPLY TO:
From: ${mail.from}
Subject: ${mail.subject}
Body: ${mail.body}
Message ID: ${mail.id}
Thread ID: ${mail.threadId}

GMAIL_SEND_EMAIL PARAMETERS:
- to: "${mail.from}"
- subject: "Re: ${mail.subject}"
- body: [generated rejection message]
- threadId: "${mail.threadId}"
- inReplyTo: "${mail.id}"
- references: "${mail.id}"

EXTRACTION:
- Name: Extract from "From" field before < symbol
- Position: Extract from subject/body

REPLY CONTENT:
Dear [Extracted Name],

Thank you for your interest in the [Extracted Position] role. We noticed your application was submitted without a resume/CV, which is required for this position.

We encourage you to reapply with a complete application including your resume/CV.

Best regards,
Recruitment Team

CRITICAL: 
- Use gmail_send_email with threadId parameter
- Include In-Reply-To and References headers
- Subject must start with "Re:"`,
            maxSteps: 100,
            maxTokens: 1024,
            toolsets: await gmailMcp.getToolsets(),
          }
        );

        console.log("Response from Gmail agent:", response.text);
        return;
      }

      verifiedFullEmails.push(mail);
    });

    try {
      const promiseResult = await Promise.allSettled(promises);
      console.log("Promises resolved:", promiseResult);
    } catch (error) {
      console.error("Error processing email content:", error);
      return [];
    }

    return verifiedFullEmails;
  },
});

const recruitmentWorkflow = createWorkflow({
  id: "recruitment-workflow",
  description: "Workflow to handle recruitment tasks triggered by Gmail events",
  inputSchema: z.object({
    historyId: z
      .string()
      .describe("The Gmail history ID to use for the trigger"),
    emailAddress: z
      .string()
      .describe("The Gmail email address to use for the trigger"),
  }),
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  steps: [
    getGmailTrigger,
    filterJobApplications,
    fetchFullEmailContent,
    emailEdgeCasesValidation,
  ],
})
  .then(getGmailTrigger)
  .then(filterJobApplications)
  .then(fetchFullEmailContent)
  .then(emailEdgeCasesValidation);

recruitmentWorkflow.commit();

export { recruitmentWorkflow };
