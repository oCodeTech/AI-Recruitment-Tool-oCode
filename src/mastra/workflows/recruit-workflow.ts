import { createStep, createWorkflow } from "@mastra/core";
import z from "zod";
import { gmailMcp } from "../mcpservers/gmail";
import { Agent } from "@mastra/core/agent";

const recruitmentMail = process.env.RECRUITMENT_MAIL;

if (!recruitmentMail) {
  throw new Error("RECRUITMENT_MAIL environment variable is not set");
}

const callAgent = async (
  agent: Agent,
  task: string,
  prompt: {
    instructions: string;
    maxSteps: number;
    maxTokens: number;
    toolsets: Record<string, Record<string, any>>;
  }
) => {
  try {
    const result = await agent.generate(task, prompt);

    const FinalOutput: string = result.text;
    return FinalOutput;
  } catch (e) {
    if (
      e instanceof Error &&
      e.message.includes("You have reached the rate limit")
    ) {
      console.log("API rate limit exceeded, waiting for 1 minute to retry...");
      await new Promise((resolve) => setTimeout(resolve, 60000)); // Block and wait for 1 minute

      try {
        const retryResult = await agent.generate(task, prompt);

        const FinalOutput: string = retryResult.text;
        return FinalOutput;
      } catch (retryError) {
        console.error("Retry after rate limit also failed:", retryError);
        return "ERROR: Retry after rate limit also failed";
      }
    } else if (
      e instanceof Error &&
      e.message.includes("Model tried to call unavailable tool")
    ) {
      console.log(
        "Model tried to call unavailable tool, waiting for 1 minute to retry..."
      );
      await new Promise((resolve) => setTimeout(resolve, 60000)); // Block and wait for 1 minute

      try {
        const retryResult = await agent.generate(task, prompt);

        const FinalOutput: string = retryResult.text;
        return FinalOutput;
      } catch (retryError) {
        console.error(
          "Retry after model tried to call unavailable tool also failed:",
          retryError
        );
        return "ERROR: Retry after model tried to call unavailable tool also failed";
      }
    } else {
      console.error("Unexpected error occurred:", e);
      return "ERROR: Unexpected error occurred";
    }
  }
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
  inputSchema: z.object({
    historyId: z
      .string()
      .describe("The Gmail history ID to use for the trigger"),
  }),
  outputSchema: z.array(z.string()).describe("Array of email IDs"),
  execute: async ({ inputData, mastra }) => {
    if (
      !inputData ||
      typeof inputData !== "object" ||
      Object.keys(inputData).length === 0
    ) {
      console.error("Input data not found for agent-trigger step");
      return;
    }

    const { historyId } = inputData;
    if (typeof historyId !== "string") {
      throw new Error(
        "Input data must contain 'historyId' and 'emailAddress' strings"
      );
    }

    const gmailAgent = mastra?.getAgent("gmailAgent");

    if (!gmailAgent) {
      throw new Error("Gmail agent not found");
    }

    const fetchNewMailsPrompt = {
      instructions: `You are an expert Gmail Assistant, designed to efficiently and accurately identify job application emails from newly arrived messages, ensuring only valid data is processed. Your primary function is to sift through recent emails and extract the Gmail message IDs of potential job applications, adhering to strict filtering criteria with utmost accuracy.

Here's the process you will follow:

**1. Email Retrieval:**

* Utilize the gmail_search_emails tool with a precise query to focus on emails in the inbox. The query should incorporate keywords related to job applications to narrow down the search.

**2. Job Application Identification:**

* Analyze the emails based on the following indicators:
  * **Subject:** Look for terms like "application," "applying," "resume," "job," "position," "cover letter," "hiring," "interview," "candidate," and "recruitment."
  * **Sender:** Identify emails from HR departments, recruiters, and job boards.
  * **Content:** Scan for job-related keywords within the email body.

**3. Critical Filtering (Exclusion Criteria):**

* Apply the following filters to exclude irrelevant emails:
  * **Sender:** Exclude emails originating from ${recruitmentMail} (our internal recruitment email address).
  * **Sender Domain:** Exclude emails from domains containing "recruitment," "hr@," or "hiring@" if they match our domain.
  * **Subject:** Exclude emails with subjects starting with "Re:" (replies to existing threads).
  * **Body:** Exclude emails containing phrases like:
    * "Best regards, Recruitment Team"
    * "We encourage you to reapply"
    * "Thank you for your interest in the"
    * "Our recruitment team will review"
    * "Missing documents"
    * "Complete application"

**4. Message ID Extraction:**

* From the emails that pass all filtering criteria, extract ONLY the Gmail message IDs (as strings).

**5. Output Formatting (CRITICAL):**

* Return the results in a specific JSON array format: ["messageId1", "messageId2", "messageId3"].
* If no valid job application emails are found, return an empty array: [].
* **ABSOLUTELY NO** additional text, explanations, descriptions, or processing details should be included in the output.

**Constraints:**

* Focus on all emails in the inbox.
* The only available tool is gmail_search_email.
* Ensure the provided message IDs are correct and correspond to valid job application emails.
* Exclude all emails from ${recruitmentMail}.
* Exclude all replies and recruitment team emails.

**Example Outputs:**

* Valid: ["1a2b3c4d5e", "6f7g8h9i0j"]
* Valid: ["abc123"]
* Valid: []
* Invalid: "Found 2 emails: ['abc123', 'def456']"
* Invalid: "Search complete. Results: ['abc123']"
* Invalid: "After filtering: ['abc123', 'def456']"
* Invalid: Any text before or after the array

**Task:**

Given the Gmail Pub/Sub notification with historyId: ${historyId}, execute the search and filtering process to identify job application emails and return the message IDs in the specified JSON array format, ensuring all data is accurate and not fabricated.`,
      maxSteps: 50,
      maxTokens: 512,
      toolsets: await gmailMcp.getToolsets(),
    };

    try {
      const result = await callAgent(
        gmailAgent,
        `URGENT: Gmail Pub/Sub notification received! New email(s) arrived (historyId: ${historyId}). Search for job application emails among the newly arrived messages.`,
        fetchNewMailsPrompt
      );

      console.log("STEP 1 (iteration): FETCH NEW EMAILS Output:", result);
      // const parsedResult = JSON.parse(result);
      // console.log("STEP 1 (iteration): FETCH NEW EMAILS parsed Output:", parsedResult);
      return result;
    } catch (err) {
      console.error("Error in agent-trigger step:", err);
      return [];
    }
  },
});

const deduplicateNewlyArrivedMails = createStep({
  id: "deduplicate-newly-arrived-mails",
  description: "Deduplicates newly arrived emails",
  inputSchema: z.array(z.string()).describe("Array of email IDs"),
  outputSchema: z.array(z.string()).describe("Array of email IDs"),
  execute: async ({ inputData }) => {
    if (
      !inputData ||
      typeof inputData !== "object" ||
      Object.keys(inputData).length === 0
    ) {
      console.log("Input data not found for deduplicateNewlyArrivedMails step", inputData);
      return [];
    }

    console.log("Deduplicating newly arrived email...", inputData);

    try {
      const serverBaseUrl = process.env.SERVER_BASE_URL;
      if (!serverBaseUrl) {
        throw new Error("SERVER_BASE_URL environment variable is not set");
      }
      const response = await fetch(`${serverBaseUrl}/validateEmailIds`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          emailIds: inputData,
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
        console.log("No valid email IDs found in the response", data);
        return [];
      }
      console.log("STEP 2: Valid email IDs:", data.validEmailIds);
      return data.validEmailIds;
    } catch (error) {
      console.error("Error validating email IDs:", error);
      return [];
    }
  },
});

const ProcessedEmailOutput = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  position: z.string().optional(),
  technologies: z.array(z.string()).optional(),
  yearsOfExperience: z.number().optional(),
  keyProjects: z.array(z.string()).optional(),
  company: z.string().optional(),
  originalSubject: z.string().optional(),
  threadId: z.string().optional(),
  messageId: z.string().optional(),
  securityCheck: z.boolean()?.optional(),
  coverLetterText: z.string().optional(),
  coverLetterStatus: z.enum(["PRESENT", "MISSING"]).optional(),
  resumeFilename: z.string().optional(),
  resumeStatus: z.enum(["PRESENT", "MISSING"]).optional(),
});

type ProcessedEmailSchema = {
  name: string;
  email: string;
  position: string;
  technologies: string[];
  yearsOfExperience: number;
  keyProjects: string[];
  company: string;
  originalSubject: string;
  threadId: string;
  messageId?: string;
  securityCheck: boolean;
  coverLetterText?: string;
  coverLetterStatus?: "PRESENT" | "MISSING";
  resumeFilename?: string;
  resumeAttachmentId?: string;
  resumeStatus?: "PRESENT" | "MISSING";
};

const processRecruitmentEmail = createStep({
  id: "process-recruitment-email",
  description: "Processes recruitment email using an agent with Gmail tools",
  inputSchema: z.string().describe("A single email ID"),
  outputSchema: ProcessedEmailOutput,
  execute: async ({ inputData: emailId, mastra }) => {
    if (!emailId || typeof emailId !== "string") {
      console.log("no new emails to process ");
      return ProcessedEmailOutput.parse({});
    }

    const gmailAgent = mastra.getAgent("gmailAgent");

    if (!gmailAgent) {
      throw new Error("Gmail agent not found");
    }

    console.log("Processing recruitment emails...", emailId);

    

    const securityCheckPrompt = {
      instructions: `
Please perform the following security checks:
- At least 2 job-related keywords (applying, resume, developer, job, etc.)
- Sent to ${recruitmentMail}
- Not sent from our recruitment team (${recruitmentMail})
- Not spam or bot
- No malicious link

Output: Return a JSON object with a securityCheck property with the boolean value representing the result of the checks.
Example:
{
  securityCheck: true
}

Available tools for use: ${await gmailMcp.getToolsets()}.
`,
      maxSteps: 10,
      maxTokens: 200,
      toolsets: await gmailMcp.getToolsets(),
    };

const extractDataPrompt = {
  instructions: `
You are given an email ID. Your task is to:
1. Use ONLY the "gmail_read_email" tool to fetch the email content.
2. Extract the following details from the email and return them as a JSON object:
   - name
   - email
   - position
   - technologies
   - years of experience
   - key projects
   - company
   - original subject
   - threadId

CRITICAL:
- The ONLY tool you are allowed to call is "gmail_read_email".
- Do NOT call any other tool, and do NOT treat any names or entities as tools.
- If you attempt to call a tool that is not "gmail_read_email", the task will fail.
- After reading the email, you must output ONLY a valid JSON object with the extracted details. Do not include any explanation, commentary, or extra text.

Example tool call:
Call: gmail_read_email
Input: { "emailId": "the-email-id" }

Example output:
{
  "name": "John Doe",
  "email": "john.doe@example.com",
  "position": "Software Engineer",
  "technologies": ["JavaScript", "React"],
  "yearsOfExperience": 5,
  "keyProjects": ["project1", "project2"],
  "company": "ACME Inc.",
  "originalSubject": "Job application for Software Engineer",
  "threadId": "thread-id-1234"
}

If any field is missing in the email, set its value to null (for strings/numbers) or an empty array (for lists).
Return ONLY the JSON object as your output.
`,
  maxSteps: 10,
  maxTokens: 400,
  toolsets: await gmailMcp.getToolsets(), // Restrict to only this tool if possible
};

    const analyzeEmailPrompt = {
      instructions: `This step has two parts: cover letter and resume analysis.

In the first part, please analyze the email content and check if it contains a cover letter with a professional introduction, experience details, technologies, and interest in the company. If it does, please return "PRESENT" in the output JSON object with the key "coverLetterStatus". If it does not, please return "MISSING".
Analyze the email content to determine if a cover letter is present and contains all the required details. If found, set the key "coverLetterStatus" to "PRESENT". If not found, set the key "coverLetterStatus" to "MISSING".

In the second part, please analyze the email attachments and check if it contains a resume CV with a valid attachment (.pdf/.doc), filename has "resume" or "cv", body mentions resume/attached. If it does, please return "PRESENT" in the output JSON object with the key "resumeStatus". If it does not, please return "MISSING".
Analyze the email attachments to determine if a resume CV is present and contains all the required details. If found, set the key "resumeStatus" to "PRESENT". If not found, set the key "resumeStatus" to "MISSING".

Output: Return a JSON object with the following format:
{
  coverLetterText: string,
  coverLetterStatus: "PRESENT" | "MISSING",
  resumeFilename: string,
  resumeAttachmentId: string
  resumeStatus: "PRESENT" | "MISSING"
}

Available tools for use: ${await gmailMcp.getToolsets()}. After calling gmail_read_email, do not call any other tool, shift to analytics mode.
`,
      maxSteps: 10,
      maxTokens: 400,
      toolsets: await gmailMcp.getToolsets(),
    };

    try {
      const securityCheckResult = await callAgent(
        gmailAgent,
        `Process this email using an agent with Gmail tools: ${emailId}.`,
        securityCheckPrompt
      );

      console.log("security check raw result:", securityCheckResult);

      const parsedSecurityCheckResult: ProcessedEmailSchema =
        extractJsonFromResult(securityCheckResult);

      console.log("STEP 3.1 (security check):", parsedSecurityCheckResult);

      if (!parsedSecurityCheckResult) {
        console.log("Email processing failed");
        return ProcessedEmailOutput.parse({});
      }

      if (!parsedSecurityCheckResult.securityCheck) {
        console.log("Email failed security check");
        return ProcessedEmailOutput.parse({});
      }

      const extractEmailResult = await callAgent(
        gmailAgent,
        `Process this email using an agent with Gmail tools: ${emailId}.`,
        extractDataPrompt
      );

      console.log("extract email raw result:", extractEmailResult);

      if (!extractEmailResult) {
        console.log("Email extraction failed");
        return ProcessedEmailOutput.parse({});
      }

      console.log("STEP 3.2 (extract email):", extractEmailResult);

      const parsedEmailProcessingResult: ProcessedEmailSchema =
        extractJsonFromResult(extractEmailResult);

      parsedEmailProcessingResult.messageId = emailId;

      const analyzeEmailResult = await callAgent(
        gmailAgent,
        `Process this email using an agent with Gmail tools: ${emailId}.`,
        analyzeEmailPrompt
      );

      const parsedAnalyzeEmailResult: ProcessedEmailSchema =
        extractJsonFromResult(analyzeEmailResult);

      console.log("STEP 3.3 (analyze email):", parsedAnalyzeEmailResult);

      if (!parsedAnalyzeEmailResult) {
        console.log("Email analysis failed");
        return ProcessedEmailOutput.parse({});
      }

      parsedEmailProcessingResult.coverLetterText =
        parsedAnalyzeEmailResult.coverLetterText;
      parsedEmailProcessingResult.coverLetterStatus =
        parsedAnalyzeEmailResult.coverLetterStatus;
      parsedEmailProcessingResult.resumeFilename =
        parsedAnalyzeEmailResult.resumeFilename;
      parsedEmailProcessingResult.resumeAttachmentId =
        parsedAnalyzeEmailResult.resumeAttachmentId;
      parsedEmailProcessingResult.resumeStatus =
        parsedAnalyzeEmailResult.resumeStatus;

      return parsedEmailProcessingResult;
    } catch (err) {
      console.log("Error occured in processRecruitmentEmail: ", err);
      return ProcessedEmailOutput.parse({});
    }
  },
});

const sendRejectionEmail = createStep({
  id: "send-rejection-email",
  description: "Sends rejection email to candidate",
  inputSchema: ProcessedEmailOutput,
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData: processedEmail, mastra }) => {
    if (
      !processedEmail ||
      ProcessedEmailOutput.safeParse(processedEmail).success === false ||
      !processedEmail.securityCheck
    ) {
      console.log("No processed email data found for sendRejectionEmail step");
      return "No processed email data found";
    }

    const gmailAgent = mastra?.getAgent("gmailAgent");

    if (!gmailAgent) {
      throw new Error("Gmail agent not found");
    }

    console.log("processed email", processedEmail);

    return "Email sent successfully";
  },
});
const sendConfirmationEmail = createStep({
  id: "send-confirmation-email",
  description: "Sends confirmation email to candidate",
  inputSchema: ProcessedEmailOutput,
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData: processedEmail, mastra }) => {
    if (
      !processedEmail ||
      ProcessedEmailOutput.safeParse(processedEmail).success === false ||
      !processedEmail.securityCheck
    ) {
      console.log(
        "No processed email data found for sendConfirmationEmail step"
      );
      return "No processed email data found";
    }

    const gmailAgent = mastra?.getAgent("gmailAgent");

    if (!gmailAgent) {
      throw new Error("Gmail agent not found");
    }

    console.log("processed email", processedEmail);

    return "Email sent successfully";
  },
});

// const sendReplyEmails = createStep({
//   id: "send-reply-emails",
//   description: "Sends reply emails to candidates",
//   inputSchema: z.string().describe("Output of the agent analysis of the email"),
//   outputSchema: z.string().describe("Final output of the recruitment workflow"),
//   execute: async ({ inputData, mastra }) => {
//     if (!inputData || typeof inputData !== "string") {
//       console.log("No input data found for sendReplyEmails step");
//       return "No input data found";
//     }

//     const gmailAgent = mastra?.getAgent("gmailAgent");

//     if (!gmailAgent) {
//       throw new Error("Gmail agent not found");
//     }

//     const sendReplyPrompt = {
//       instructions: `You are an AI agent responsible for sending automated recruitment email replies. Your task is to analyze the provided screening data (which you already have) and send a befitting email to the candidate.

// ---

// DETAILED INSTRUCTIONS:

// STEP 1: PARSE PROVIDED SCREENING DATA
//  - You are provided with the following pre-screened data. Parse it to extract all necessary details:
//      - Cover Letter Score (from "STEP 3 COMPLETE - PRESENT (Score X/5)")
//      - Resume Score (from "STEP 4 COMPLETE - PRESENT (Score X/4)")
//      - Candidate's Name (from JSON)
//      - Candidate's Email (from JSON)
//      - Position (from JSON)
//      - Technologies (from JSON)
//      - Experience (from JSON)
//      - Projects (from JSON)
//      - Company (from JSON)
//      - Original Subject (from JSON)
//      - Thread ID (from JSON)

// STEP 2: DETERMINE REPLY DECISION
//  - Based on the extracted scores, decide the type of reply:
//      - If Cover Letter Score ≥ 3 AND Resume Score ≥ 2: The decision is "ACCEPTANCE".
//      - Otherwise: The decision is "REJECTION".

// STEP 3: GENERATE PERSONALIZED EMAIL BODY AND SUBJECT
//  - Use the appropriate template based on the decision from STEP 2.
//  - Send a formatted email to the candidate. Use new lines for line breaks.
//  - Replace all placeholders (e.g., [NAME], [POSITION]) with the actual extracted data.
//  - For the ACCEPTANCE TEMPLATE:
//      - If 'experience' is "Not specified" or empty, omit the phrase "your [EXPERIENCE] years of experience".
//      - If 'projects' is "Not specified" or empty, omit the phrase "and your work on [PROJECTS]".
//      - Construct the sentence to flow naturally based on the presence of 'experience' and 'projects' data.
//      - Generate a personalized acceptance message for the candidate using the extracted data and the template.
//      - Use new lines for line breaks.
// - For the REJECTION TEMPLATE:
//      - Mention the key documents that are missing (e.g., resume, cover letter).
//      - Generate a personalized rejection message for the candidate using the extracted data and the template.
//      - Use new lines for line breaks.

//  ACCEPTANCE TEMPLATE:
//  Subject: Re: [ORIGINAL_SUBJECT]
//  Body: Dear [NAME],
//  Thank you for applying to [POSITION] at [COMPANY]. We appreciate your [EXPERIENCE] years of experience with [TECHNOLOGIES] and your work on [PROJECTS]. Our team will review and respond shortly.
//  Best,
//  Recruitment Team

//  REJECTION TEMPLATE:
//  Subject: Re: [ORIGINAL_SUBJECT]
//  Body: Dear [NAME],
//  Thank you for your interest in [POSITION] at [COMPANY]. Your application is missing key documents. Please resubmit with full materials.
//  Best,
//  Recruitment Team

// STEP 4: SEND EMAIL
//  - Use the 'gmail_send_email' tool to send the generated email.
//  - Parameters for gmail_send_email:
//      - "to": ["extracted_candidate_email"]
//      - "subject": "generated_subject"
//      - "body": "generated_personalized_message"
//      - "mimeType": "text/plain"
//      - "threadId": "extracted_threadId"
//      - "inReplyTo": "original_email_message_id" // This should be the messageId of the email you just screened
//      - "cc": []
//      - "bcc": []
//      - "attachments": []

// FINAL OUTPUT:
// Your ENTIRE response MUST be ONLY the confirmation message of the email being sent. Do NOT include any conversational text, step-by-step descriptions, analysis summaries, or markdown outside of the confirmation.

// Example of FINAL OUTPUT: "Email sent to [CANDIDATE_EMAIL]"

// CRITICAL RULES:
// - You MUST parse the provided input data to get all necessary details.
// - You MUST make a decision (ACCEPTANCE/REJECTION) based on the cover letter and resume scores.
// - You MUST generate a personalized email using the correct template and extracted data.
// - You MUST call the 'gmail_send_email' tool with the correct parameters.
// - Your final output MUST be ONLY the confirmation message, nothing else.
// - Do NOT generate any code (Python, JavaScript, etc.) in the final output.
// - Do NOT include the 'gmail_send_email' tool call itself in the final output, only the confirmation.
// - Do NOT perform any email reading or analysis; use the provided data directly.
// `,
//       maxSteps: 5, // Sufficient steps for parsing, decision, and sending
//       maxTokens: 400, // Sufficient for parsing and generating a confirmation
//       toolsets: await gmailMcp.getToolsets(),
//     };
//     try {
//       const result = await gmailAgent.generate(
//         `Send reply email to candidate by analyzing email details: ${JSON.stringify(inputData)}.`,
//         sendReplyPrompt
//       );
//       const FinalOutput = result.text;
//       console.log("STEP 4 (iteration): SEND EMAIL Output:", FinalOutput);
//       return FinalOutput;
//     } catch (e) {
//       if (
//         e instanceof Error &&
//         e.message.includes("You have reached the rate limit")
//       ) {
//         console.log(
//           "API rate limit exceeded, waiting for 1 minute to retry..."
//         );
//         await new Promise((resolve) => setTimeout(resolve, 60000)); // Block and wait for 1 minute

//         try {
//           const retryResult = await gmailAgent.generate(
//             `Send reply email to candidate by analyzing email details: ${JSON.stringify(inputData)}.`,

//             sendReplyPrompt
//           );

//           const FinalOutput: string = retryResult.text;
//           console.log("STEP 4 (iteration): SEND EMAIL Output:", FinalOutput);
//           return FinalOutput;
//         } catch (retryError) {
//           console.error("Retry after rate limit also failed:", retryError);
//           return "ERROR: Retry after rate limit also failed";
//         }
//       } else if (
//         e instanceof Error &&
//         e.message.includes("Model tried to call unavailable tool")
//       ) {
//         console.log(
//           "Model tried to call unavailable tool, waiting for 1 minute to retry..."
//         );
//         await new Promise((resolve) => setTimeout(resolve, 60000)); // Block and wait for 1 minute

//         try {
//           const retryResult = await gmailAgent.generate(
//             `Send reply email to candidate by analyzing email details: ${JSON.stringify(inputData)}.`,

//             sendReplyPrompt
//           );

//           const FinalOutput: string = retryResult.text;
//           console.log("STEP 4 (iteration): SEND EMAIL Output:", FinalOutput);
//           return FinalOutput;
//         } catch (retryError) {
//           console.error(
//             "Retry after model tried to call unavailable tool also failed:",
//             retryError
//           );
//           return "ERROR: Retry after model tried to call unavailable tool also failed";
//         }
//       } else {
//         console.error("Unexpected error occurred:", e);
//         return "ERROR: Unexpected error occurred";
//       }
//     }
//   },
// });

// const processRecruitmentEmails = createStep({
//   id: "process-recruitment-emails",
//   description: "Processes recruitment emails using an agent with Gmail tools",
//   inputSchema: z.string().describe("A single email ID"),
//   outputSchema: z
//     .string()
//     .describe("Output of the agent analysis of the email"),
//   execute: async ({ inputData: emailId, mastra }) => {
//     if (!emailId || typeof emailId !== "string") {
//       console.log("no new emails to process ");
//       return "no new emails to process";
//     }

//     const gmailAgent = mastra.getAgent("gmailAgent");

//     if (!gmailAgent) {
//       throw new Error("Gmail agent not found");
//     }

//     console.log("Processing recruitment emails...", emailId);

//     const processRecruitmentEmailsPrompt = {
//       instructions: `RECRUITMENT WORKFLOW – EMAIL: ${emailId} TO: ${recruitmentMail}

// STEP 1: DATA EXTRACTION
// Call: gmail_read_email({"messageId": "${emailId}"})
// Extract: name, email, position, technologies, years of experience, key projects, company, original subject, threadId.
// Output: "STEP 1 COMPLETE"

// STEP 2: SECURITY CHECK
// Ensure:
// - At least 2 job-related keywords (applying, resume, developer, job, etc.)
// - Sent to ${recruitmentMail}
// - Not spam or bot
// - No malicious links
// Output: "STEP 2 COMPLETE - VALID: YES/NO"

// STEP 3: COVER LETTER SCORING (0–5)
// 1pt: professional intro
// 1pt: experience details
// 1pt: technologies
// 1pt: ≥200 characters
// 1pt: interest in company
// Score ≥3 = PRESENT, else MISSING
// Output: "STEP 3 COMPLETE - PRESENT/MISSING (Score X/5)"

// STEP 4: RESUME SCORING (0–4)
// 1pt: valid attachment (.pdf/.doc)
// 1pt: filename has "resume" or "cv"
// 1pt: body mentions resume/attached
// 1pt: LinkedIn/GitHub/portfolio link
// Score ≥2 = PRESENT, else MISSING
// Output: "STEP 4 COMPLETE - PRESENT/MISSING (Score X/4)"

// STEP 5: DATA CONFIRMATION
// Print extracted values (no placeholders): name, email, position, technologies, experience, projects, company, subject, threadId
// Output: "STEP 5 COMPLETE"

// STEP 6: OUTPUT FORMAT
// Your ENTIRE response MUST be ONLY this JSON object. No other text, no explanations, no code, no markdown outside the JSON block.:

// {
//   "name": "actual_candidate_name",
//   "email": "actual_email_address",
//   "position": "actual_position",
//   "technologies": "actual_technologies",
//   "experience": "actual_experience",
//   "projects": "actual_projects",
//   "company": "actual_company",
//   "subject": "actual_subject",
//   "threadId": "actual_thread_id",
//   "isValid": true,
//   "hasAttachment": false,
//   "hasCoverLetter": true,
//   "hasResume": false
// }

// ⚠️ DO NOT include additional content. No explanations, markdown, summaries, or tool calls beyond STEP 1.
// Only return the JSON object as specified in STEP 6.`,
//       maxSteps: 35,
//       maxTokens: 550, // Slightly safer than 800 to avoid hitting 8192 again
//       toolsets: await gmailMcp.getToolsets(),
//     };

//     try {
//       const result = await gmailAgent.generate(
//         `Process recruitment workflow for email ID: ${JSON.stringify(emailId)}. Send rejection emails from ${recruitmentMail} to candidates missing documents.`,

//         processRecruitmentEmailsPrompt
//       );
//       const FinalOutput = result.text;
//       console.log("STEP 3 (iteration): Email screening Output:", FinalOutput);
//       return FinalOutput;
//     } catch (e) {
//       if (
//         e instanceof Error &&
//         e.message.includes("You have reached the rate limit")
//       ) {
//         console.log(
//           "API rate limit exceeded, waiting for 1 minute to retry..."
//         );
//         await new Promise((resolve) => setTimeout(resolve, 60000)); // Block and wait for 1 minute

//         try {
//           const retryResult = await gmailAgent.generate(
//             `Process recruitment workflow for email ID: ${JSON.stringify(emailId)}. Send rejection emails from ${recruitmentMail} to candidates missing documents.`,

//             processRecruitmentEmailsPrompt
//           );

//           const FinalOutput: string = retryResult.text;
//           console.log(
//             "STEP 3 (iteration): Email screening Output:",
//             FinalOutput
//           );
//           return FinalOutput;
//         } catch (retryError) {
//           console.error("Retry after rate limit also failed:", retryError);
//           return "ERROR: Retry after rate limit also failed";
//         }
//       } else if (
//         e instanceof Error &&
//         e.message.includes("Model tried to call unavailable tool")
//       ) {
//         console.log(
//           "Model tried to call unavailable tool, waiting for 1 minute to retry..."
//         );
//         await new Promise((resolve) => setTimeout(resolve, 60000)); // Block and wait for 1 minute

//         try {
//           const retryResult = await gmailAgent.generate(
//             `Process recruitment workflow for email ID: ${JSON.stringify(emailId)}. Send rejection emails from ${recruitmentMail} to candidates missing documents.`,

//             processRecruitmentEmailsPrompt
//           );

//           const FinalOutput: string = retryResult.text;
//           console.log(
//             "STEP 3 (iteration): Email screening Output:",
//             FinalOutput
//           );
//           return FinalOutput;
//         } catch (retryError) {
//           console.error(
//             "Retry after model tried to call unavailable tool also failed:",
//             retryError
//           );
//           return "ERROR: Retry after model tried to call unavailable tool also failed";
//         }
//       } else {
//         console.error("Unexpected error occurred:", e);
//         return "ERROR: Unexpected error occurred";
//       }
//     }
//   },
// });

// const sendReplyEmails = createStep({
//   id: "send-reply-emails",
//   description: "Sends reply emails to candidates",
//   inputSchema: z.string().describe("Output of the agent analysis of the email"),
//   outputSchema: z.string().describe("Final output of the recruitment workflow"),
//   execute: async ({ inputData, mastra }) => {
//     if (!inputData || typeof inputData !== "string") {
//       console.log("No input data found for sendReplyEmails step");
//       return "No input data found";
//     }

//     const gmailAgent = mastra?.getAgent("gmailAgent");

//     if (!gmailAgent) {
//       throw new Error("Gmail agent not found");
//     }

//     const sendReplyPrompt = {
//       instructions: `You are an AI agent responsible for sending automated recruitment email replies. Your task is to analyze the provided screening data (which you already have) and send a befitting email to the candidate.

// ---

// DETAILED INSTRUCTIONS:

// STEP 1: PARSE PROVIDED SCREENING DATA
//  - You are provided with the following pre-screened data. Parse it to extract all necessary details:
//      - Cover Letter Score (from "STEP 3 COMPLETE - PRESENT (Score X/5)")
//      - Resume Score (from "STEP 4 COMPLETE - PRESENT (Score X/4)")
//      - Candidate's Name (from JSON)
//      - Candidate's Email (from JSON)
//      - Position (from JSON)
//      - Technologies (from JSON)
//      - Experience (from JSON)
//      - Projects (from JSON)
//      - Company (from JSON)
//      - Original Subject (from JSON)
//      - Thread ID (from JSON)

// STEP 2: DETERMINE REPLY DECISION
//  - Based on the extracted scores, decide the type of reply:
//      - If Cover Letter Score ≥ 3 AND Resume Score ≥ 2: The decision is "ACCEPTANCE".
//      - Otherwise: The decision is "REJECTION".

// STEP 3: GENERATE PERSONALIZED EMAIL BODY AND SUBJECT
//  - Use the appropriate template based on the decision from STEP 2.
//  - Send a formatted email to the candidate. Use new lines for line breaks.
//  - Replace all placeholders (e.g., [NAME], [POSITION]) with the actual extracted data.
//  - For the ACCEPTANCE TEMPLATE:
//      - If 'experience' is "Not specified" or empty, omit the phrase "your [EXPERIENCE] years of experience".
//      - If 'projects' is "Not specified" or empty, omit the phrase "and your work on [PROJECTS]".
//      - Construct the sentence to flow naturally based on the presence of 'experience' and 'projects' data.
//      - Generate a personalized acceptance message for the candidate using the extracted data and the template.
//      - Use new lines for line breaks.
// - For the REJECTION TEMPLATE:
//      - Mention the key documents that are missing (e.g., resume, cover letter).
//      - Generate a personalized rejection message for the candidate using the extracted data and the template.
//      - Use new lines for line breaks.

//  ACCEPTANCE TEMPLATE:
//  Subject: Re: [ORIGINAL_SUBJECT]
//  Body: Dear [NAME],
//  Thank you for applying to [POSITION] at [COMPANY]. We appreciate your [EXPERIENCE] years of experience with [TECHNOLOGIES] and your work on [PROJECTS]. Our team will review and respond shortly.
//  Best,
//  Recruitment Team

//  REJECTION TEMPLATE:
//  Subject: Re: [ORIGINAL_SUBJECT]
//  Body: Dear [NAME],
//  Thank you for your interest in [POSITION] at [COMPANY]. Your application is missing key documents. Please resubmit with full materials.
//  Best,
//  Recruitment Team

// STEP 4: SEND EMAIL
//  - Use the 'gmail_send_email' tool to send the generated email.
//  - Parameters for gmail_send_email:
//      - "to": ["extracted_candidate_email"]
//      - "subject": "generated_subject"
//      - "body": "generated_personalized_message"
//      - "mimeType": "text/plain"
//      - "threadId": "extracted_threadId"
//      - "inReplyTo": "original_email_message_id" // This should be the messageId of the email you just screened
//      - "cc": []
//      - "bcc": []
//      - "attachments": []

// FINAL OUTPUT:
// Your ENTIRE response MUST be ONLY the confirmation message of the email being sent. Do NOT include any conversational text, step-by-step descriptions, analysis summaries, or markdown outside of the confirmation.

// Example of FINAL OUTPUT: "Email sent to [CANDIDATE_EMAIL]"

// CRITICAL RULES:
// - You MUST parse the provided input data to get all necessary details.
// - You MUST make a decision (ACCEPTANCE/REJECTION) based on the cover letter and resume scores.
// - You MUST generate a personalized email using the correct template and extracted data.
// - You MUST call the 'gmail_send_email' tool with the correct parameters.
// - Your final output MUST be ONLY the confirmation message, nothing else.
// - Do NOT generate any code (Python, JavaScript, etc.) in the final output.
// - Do NOT include the 'gmail_send_email' tool call itself in the final output, only the confirmation.
// - Do NOT perform any email reading or analysis; use the provided data directly.
// `,
//       maxSteps: 5, // Sufficient steps for parsing, decision, and sending
//       maxTokens: 400, // Sufficient for parsing and generating a confirmation
//       toolsets: await gmailMcp.getToolsets(),
//     };
//     try {
//       const result = await gmailAgent.generate(
//         `Send reply email to candidate by analyzing email details: ${JSON.stringify(inputData)}.`,
//         sendReplyPrompt
//       );
//       const FinalOutput = result.text;
//       console.log("STEP 4 (iteration): SEND EMAIL Output:", FinalOutput);
//       return FinalOutput;
//     } catch (e) {
//       if (
//         e instanceof Error &&
//         e.message.includes("You have reached the rate limit")
//       ) {
//         console.log(
//           "API rate limit exceeded, waiting for 1 minute to retry..."
//         );
//         await new Promise((resolve) => setTimeout(resolve, 60000)); // Block and wait for 1 minute

//         try {
//           const retryResult = await gmailAgent.generate(
//             `Send reply email to candidate by analyzing email details: ${JSON.stringify(inputData)}.`,

//             sendReplyPrompt
//           );

//           const FinalOutput: string = retryResult.text;
//           console.log("STEP 4 (iteration): SEND EMAIL Output:", FinalOutput);
//           return FinalOutput;
//         } catch (retryError) {
//           console.error("Retry after rate limit also failed:", retryError);
//           return "ERROR: Retry after rate limit also failed";
//         }
//       } else if (
//         e instanceof Error &&
//         e.message.includes("Model tried to call unavailable tool")
//       ) {
//         console.log(
//           "Model tried to call unavailable tool, waiting for 1 minute to retry..."
//         );
//         await new Promise((resolve) => setTimeout(resolve, 60000)); // Block and wait for 1 minute

//         try {
//           const retryResult = await gmailAgent.generate(
//             `Send reply email to candidate by analyzing email details: ${JSON.stringify(inputData)}.`,

//             sendReplyPrompt
//           );

//           const FinalOutput: string = retryResult.text;
//           console.log("STEP 4 (iteration): SEND EMAIL Output:", FinalOutput);
//           return FinalOutput;
//         } catch (retryError) {
//           console.error(
//             "Retry after model tried to call unavailable tool also failed:",
//             retryError
//           );
//           return "ERROR: Retry after model tried to call unavailable tool also failed";
//         }
//       } else {
//         console.error("Unexpected error occurred:", e);
//         return "ERROR: Unexpected error occurred";
//       }
//     }
//   },
// });

const extractInputData = createStep({
  id: "extract-input-data",
  inputSchema: ProcessedEmailOutput,
  outputSchema: ProcessedEmailOutput,
  description:
    "Extracts input data from the processed email output array and returns it",
  execute: async ({ inputData }) => {
    return inputData;
  },
});

const recruitWorkflow = createWorkflow({
  id: "recruit-workflow",
  description:
    "Workflow to handle recruitment tasks with an agent triggered by Gmail events",
  inputSchema: z.object({
    historyId: z
      .string()
      .describe("The Gmail history ID to use for the trigger"),
  }),
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  steps: [
    AgentTrigger,
    deduplicateNewlyArrivedMails,
    processRecruitmentEmail,
    sendRejectionEmail,
    sendConfirmationEmail,
  ],
  retryConfig: {
    attempts: 5,
    delay: 5000,
  },
})
  .then(AgentTrigger)
  .then(deduplicateNewlyArrivedMails)
  .foreach(processRecruitmentEmail)
  .foreach(extractInputData)
 .branch([
  [
    ({inputData: {coverLetterStatus, resumeStatus}}: {inputData: ProcessedEmailSchema}) => coverLetterStatus === "MISSING" || resumeStatus
    === "MISSING",
    sendRejectionEmail
  ]
])
recruitWorkflow.commit();

export { recruitWorkflow };
