import { createStep, createWorkflow } from "@mastra/core";
import z from "zod";
import { gmailMcp } from "../mcpservers/gmail";
import { Agent } from "@mastra/core/agent";

const recruitmentMail = process.env.RECRUITMENT_MAIL;

if (!recruitmentMail) {
  throw new Error("RECRUITMENT_MAIL environment variable is not set");
}

interface PromptProps {
  instructions: string;
  maxSteps: number;
  maxTokens: number;
  toolsets: Record<string, Record<string, any>>;
}

const callAgent = async ({
  agent,
  fallbackAgent,
  task,
  prompt,
}: {
  agent: Agent;
  task: string;
  fallbackAgent: Agent;
  prompt: PromptProps;
}) => {
  try {
    const result = await agent.generate(task, prompt);

    const FinalOutput: string = result.text;
    return FinalOutput;
  } catch (e) {
    if (
      e instanceof Error &&
      (e.message.includes("You have reached the rate limit") ||
        e.message.includes("Rate limit reached for model") ||
        e.message.includes("Cannot connect to API"))
    ) {
      console.log("API rate limit exceeded, waiting for 1 minute to retry...");
      await new Promise((resolve) => setTimeout(resolve, 60000)); // Block and wait for 1 minute

      try {
        const retryResult = await agent.generate(task, prompt);

        const FinalOutput: string = retryResult.text;
        return FinalOutput;
      } catch (RetryError) {
        try {
          console.log("Retry after rate limit failed, trying fallback agent");
          const retryResult = await fallbackAgent.generate(task, prompt);

          const FinalOutput: string = retryResult.text;
          return FinalOutput;
        } catch (e) {
          console.error("Retry after rate limit also failed:", e, RetryError);
          return "ERROR: Retry after rate limit also failed";
        }
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

    const gmailMetaAgent = mastra?.getAgent("gmailMetaAgent");
    const gmailGroqAgent = mastra?.getAgent("gmailGroqAgent");

    if (!gmailMetaAgent) {
      throw new Error("Gmail Meta Agent not found");
    }
    if (!gmailGroqAgent) {
      throw new Error("Gmail Groq Agent not found");
    }

    const fetchNewMailsPrompt = {
      instructions: `Fetch new job application emails based on strict filtering criteria. Return ONLY an array of email IDs in JSON format. If no emails are found, return an empty array [].`,
      maxSteps: 50,
      maxTokens: 512,
      toolsets: await gmailMcp.getToolsets(),
    };

    try {
      const result = await callAgent({
        agent: gmailMetaAgent,
        fallbackAgent: gmailGroqAgent,
        task: `URGENT: Gmail Pub/Sub notification received! New email(s) arrived (historyId: ${historyId}). Search for job application emails among the newly arrived messages.`,
        prompt: fetchNewMailsPrompt,
      });

      console.log("STEP 1 (iteration): FETCH NEW EMAILS Output:", result);
      const parsedResult = JSON.parse(result);
      console.log(
        "STEP 1 (iteration): FETCH NEW EMAILS parsed Output:",
        parsedResult
      );
      return parsedResult;
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
      console.log(
        "Input data not found for deduplicateNewlyArrivedMails step",
        inputData
      );
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

type ProcessedEmailSchema = {
  name?: string;
  email?: string;
  position?: string;
  technologies?: string[];
  yearsOfExperience?: number;
  keyProjects?: string[];
  company?: string;
  originalSubject?: string;
  threadId?: string;
  messageId?: string;
  securityCheck: boolean;
  coverLetterText?: string;
  coverLetterStatus?: "PRESENT" | "MISSING";
  resumeFilename?: string;
  resumeAttachmentId?: string;
  resumeStatus?: "PRESENT" | "MISSING";
};

const ProcessedEmailOutput = z.object({
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  position: z.string().nullable().optional(),
  technologies: z.array(z.string()).optional(),
  yearsOfExperience: z.number().nullable().optional(),
  keyProjects: z.array(z.string()).optional(),
  company: z.string().nullable().optional(),
  originalSubject: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  messageId: z.string().optional(),
  securityCheck: z.boolean()?.optional(),
  coverLetterText: z.string().optional(),
  coverLetterStatus: z.enum(["PRESENT", "MISSING"]).optional(),
  resumeFilename: z.string().optional(),
  resumeStatus: z.enum(["PRESENT", "MISSING"]).optional(),
});

const processSecureEmail = createStep({
  id: "process-secure-email",
  description: "Processes a secure email using an agent with Gmail tools",
  inputSchema: z.string().describe("A single email ID"),
  outputSchema: ProcessedEmailOutput,
  execute: async ({ inputData: emailId, mastra }) => {
    if (!emailId || typeof emailId !== "string") {
      console.log("no new emails to process ");
      return ProcessedEmailOutput.parse({});
    }

    const gmailMetaAgent = mastra.getAgent("gmailMetaAgent");
    const gmailGroqAgent = mastra.getAgent("gmailGroqAgent");

    if (!gmailMetaAgent) {
      throw new Error("Gmail meta agent not found");
    }

    if (!gmailGroqAgent) {
      throw new Error("Gmail groq agent not found");
    }

    console.log("Processing security check for email: ", emailId);

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

    try {
      const securityCheckResult = await callAgent({
        agent: gmailMetaAgent,
        fallbackAgent: gmailGroqAgent,
        task: `Process this email using an agent with Gmail tools: ${emailId}`,
        prompt: securityCheckPrompt,
      });

      console.log("security check raw result:", securityCheckResult);

      const parsedSecurityCheckResult: ProcessedEmailSchema =
        extractJsonFromResult(securityCheckResult);

      if (!parsedSecurityCheckResult) {
        console.log("Email processing failed");
        return ProcessedEmailOutput.parse({});
      }

      if (!parsedSecurityCheckResult.securityCheck) {
        console.log("Email failed security check");
        return ProcessedEmailOutput.parse({});
      }

      console.log("STEP 3.1 (security check):", parsedSecurityCheckResult);
      parsedSecurityCheckResult.messageId = emailId;
      return parsedSecurityCheckResult;
    } catch (err) {
      console.log(
        `Error occured in security check for email ${emailId}: `,
        err
      );
      return ProcessedEmailOutput.parse({});
    }
  },
});

const extractDataFromEmail = createStep({
  id: "extract-data-from-email",
  description:
    "Processes a secure email using an agent with Gmail tools and extract data",
  inputSchema: ProcessedEmailOutput,
  outputSchema: ProcessedEmailOutput,
  execute: async ({ inputData: { securityCheck, messageId }, mastra }) => {
    if (!messageId || !securityCheck) {
      console.log("No valid emails to process");
      return ProcessedEmailOutput.parse({});
    }
    const gmailGroqAgent = mastra.getAgent("gmailGroqAgent");
    const gmailMetaAgent = mastra.getAgent("gmailMetaAgent");

    if (!gmailGroqAgent) {
      throw new Error("Gmail Groq Agent not found");
    }

    if (!gmailMetaAgent) {
      throw new Error("Gmail Meta Agent not found");
    }

    console.log("Extracting data from email: ", messageId);

    const extractDataPrompt = {
      instructions: `
You are given an email ID. Your task is to:
1. Use ONLY the "gmail_read_email" tool to fetch the email content.
2. Extract the following details and return them as a single, complete, and valid JSON object with ALL fields present:
   - name (string or null)
   - email (string or null)
   - position (string or null)
   - technologies (array of strings, or empty array)
   - yearsOfExperience (number or null)
   - keyProjects (array of strings, or empty array)
   - company (string or null)
   - originalSubject (string or null)
   - threadId (string or null)

CRITICAL:
- The ONLY tool you are allowed to call is "gmail_read_email".
- Do NOT call any other tool, and do NOT treat any names or entities as tools.
- You must return a single, complete, and valid JSON object with all required fields.
- If you cannot extract a field, set it to null (for strings/numbers) or an empty array (for lists).
- Ensure the JSON object is properly closed and valid.
- Never return an incomplete or partial JSON object.
- If you are unsure, return all fields with null or empty array values.
- Return ONLY the JSON object as your output. Do not provide any explanation, commentary, or extra text.

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
`,
      maxSteps: 10,
      maxTokens: 600, // Increase if needed
      toolsets: await gmailMcp.getToolsets(),
    };
    try {
      const extractEmailResult = await callAgent({
        agent: gmailGroqAgent,
        fallbackAgent: gmailMetaAgent,
        task: `Process this email using an agent with Gmail tools and extract data: ${messageId}`,
        prompt: extractDataPrompt,
      });

      console.log("extract email raw result:", extractEmailResult);

      if (!extractEmailResult) {
        console.log("Email extraction failed");
        return ProcessedEmailOutput.parse({});
      }

      console.log("STEP 3.2 (extract email):", extractEmailResult);

      const parsedEmailProcessingResult: ProcessedEmailSchema =
        extractJsonFromResult(extractEmailResult);

      if (
        !parsedEmailProcessingResult ||
        Object.keys(parsedEmailProcessingResult).length === 0
      ) {
        console.log("Email processing failed");
        return ProcessedEmailOutput.parse({});
      }

      parsedEmailProcessingResult.messageId = messageId;
      parsedEmailProcessingResult.securityCheck = securityCheck;

      return parsedEmailProcessingResult;
    } catch (err) {
      console.log("Error occured in extractDataFromEmail: ", err);
      return ProcessedEmailOutput.parse({});
    }
  },
});

const analyzeEmail = createStep({
  id: "analyze-email",
  description:
    "Analyzes a secure email using an agent with Gmail tools and extract data",
  inputSchema: ProcessedEmailOutput,
  outputSchema: ProcessedEmailOutput,
  execute: async ({
    inputData: {
      name,
      email,
      position,
      technologies,
      yearsOfExperience,
      keyProjects,
      company,
      originalSubject,
      threadId,
      securityCheck,
      messageId,
    },
    mastra,
  }) => {
    if (!messageId || !securityCheck) {
      console.log("No valid emails to process");
      return ProcessedEmailOutput.parse({});
    }

    const gmailMetaAgent = mastra.getAgent("gmailMetaAgent");
    const gmailGroqAgent = mastra.getAgent("gmailGroqAgent");

    if (!gmailMetaAgent) {
      throw new Error("Gmail Meta Agent not found");
    }

    if (!gmailGroqAgent) {
      throw new Error("Gmail Groq Agent not found");
    }

    console.log("Analyzing data from email: ", messageId);

    const analyzeEmailPrompt = {
      instructions: `
You are given an email ID. Your task is to analyze the email for two things: cover letter and resume (CV) presence.

**Part 1: Cover Letter Analysis**
- Use ONLY the "gmail_read_email" tool to fetch the email content.
- Analyze the email content to check if it contains a cover letter with:
  - a professional introduction,
  - experience details,
  - technologies,
  - and interest in the company.
- If ALL these are present, set "coverLetterStatus" to "PRESENT" in the output JSON.
- If ANY are missing, set "coverLetterStatus" to "MISSING".
- Extract and include the full cover letter text as "coverLetterText". If not found, set "coverLetterText" to an empty string.

**Part 2: Resume (CV) Analysis**
- Analyze the email attachments to check for a resume or CV:
  - The attachment must be a valid file (.pdf or .doc).
  - The filename must contain "resume" or "cv".
  - The email body must mention "resume" or "attached".
- If ALL these are present, set "resumeStatus" to "PRESENT" in the output JSON.
- If ANY are missing, set "resumeStatus" to "MISSING".
- If a resume is found, include its filename as "resumeFilename" and its attachment ID as "resumeAttachmentId". If not found, set both to empty strings.

**CRITICAL INSTRUCTIONS:**
- The ONLY tool you are allowed to call is "gmail_read_email". Do NOT call any other tool.
- After calling "gmail_read_email", do not call any other tool; switch to analysis mode.
- You MUST return a single, complete, and valid JSON object with ALL the following fields:
  - coverLetterText (string, empty if not found)
  - coverLetterStatus ("PRESENT" or "MISSING")
  - resumeFilename (string, empty if not found)
  - resumeAttachmentId (string, empty if not found)
  - resumeStatus ("PRESENT" or "MISSING")
- If you cannot extract a field, set it to an empty string or "MISSING" as appropriate.

**FINAL VALIDATION (MANDATORY):**
- Before returning your answer, carefully check that your JSON object:
  - Contains ALL required fields, even if empty or "MISSING".
  - Has all string values properly quoted.
  - Is properly closed with a curly brace.
  - Is valid JSON and can be parsed without error.
- If any field is missing, incomplete, or the JSON is not valid, correct it before returning.
- Return ONLY the JSON object as your output. Do NOT include any explanation, commentary, or extra text.

**Example output:**
{
  "coverLetterText": "Dear Team, I am excited to apply...",
  "coverLetterStatus": "PRESENT",
  "resumeFilename": "vivek_resume.pdf",
  "resumeAttachmentId": "att12345",
  "resumeStatus": "PRESENT"
}

**Example output if nothing is found:**
{
  "coverLetterText": "",
  "coverLetterStatus": "MISSING",
  "resumeFilename": "",
  "resumeAttachmentId": "",
  "resumeStatus": "MISSING"
}
`,
      maxSteps: 10,
      maxTokens: 600, // Increased for completeness
      toolsets: await gmailMcp.getToolsets(),
    };

    try {
      const analyzeEmailResult = await callAgent({
        agent: gmailMetaAgent,
        fallbackAgent: gmailGroqAgent,
        task: `Analyze this email using an agent with Gmail tools and extract data: ${messageId}`,
        prompt: analyzeEmailPrompt,
      });

      console.log("Analyze email raw result:", analyzeEmailResult);

      if (!analyzeEmailResult) {
        console.log("Email analysis failed");
        return ProcessedEmailOutput.parse({});
      }

      console.log("STEP 3.3 (Analyze email):", analyzeEmailResult);

      const parsedAnalyzeEmailResult: ProcessedEmailSchema =
        extractJsonFromResult(analyzeEmailResult);

      if (
        !parsedAnalyzeEmailResult ||
        Object.keys(parsedAnalyzeEmailResult).length === 0
      ) {
        console.log("Error parsing analyze email result");
        return ProcessedEmailOutput.parse({});
      }

      parsedAnalyzeEmailResult.messageId = messageId;
      parsedAnalyzeEmailResult.securityCheck = securityCheck;
      if (name) parsedAnalyzeEmailResult.name = name;
      if (email) parsedAnalyzeEmailResult.email = email;
      if (position) parsedAnalyzeEmailResult.position = position;
      parsedAnalyzeEmailResult.technologies = technologies;
      if (yearsOfExperience)
        parsedAnalyzeEmailResult.yearsOfExperience = yearsOfExperience;
      parsedAnalyzeEmailResult.keyProjects = keyProjects;
      if (company) parsedAnalyzeEmailResult.company = company;
      if (originalSubject)
        parsedAnalyzeEmailResult.originalSubject = originalSubject;
      if (threadId) parsedAnalyzeEmailResult.threadId = threadId;
      parsedAnalyzeEmailResult.messageId = messageId;
      parsedAnalyzeEmailResult.securityCheck = securityCheck;

      return parsedAnalyzeEmailResult;
    } catch (err) {
      console.log("Error occured in analyzeEmail: ", err);
      return ProcessedEmailOutput.parse({});
    }
  },
});

const ExtractInputDataInput = z.array(ProcessedEmailOutput);
const ExtractInputDataOutput = z.object({
  rejectEmails: z.array(ProcessedEmailOutput),
  confirmEmails: z.array(ProcessedEmailOutput),
});

type ExtractInputDataOutput = z.infer<typeof ExtractInputDataOutput>;

const sortEmailData = createStep({
  id: "sort-email-data",
  inputSchema: ExtractInputDataInput,
  outputSchema: ExtractInputDataOutput,
  description:
    "Sorts the input data into two arrays: rejectEmails and confirmEmails based on resumeStatus and coverLetterStatus",
  execute: async ({ inputData }) => {
    if (!inputData || inputData.length === 0) {
      return ExtractInputDataOutput.parse({
        rejectEmails: [],
        confirmEmails: [],
      });
    }

    const rejectEmails = inputData.filter(
      (email) =>
        email.resumeStatus === "MISSING" ||
        email.coverLetterStatus === "MISSING"
    );
    const confirmEmails = inputData.filter(
      (email) =>
        email.resumeStatus === "PRESENT" &&
        email.coverLetterStatus === "PRESENT"
    );

    return ExtractInputDataOutput.parse({
      rejectEmails,
      confirmEmails,
    });
  },
});

const sendRejectionEmail = createStep({
  id: "send-rejection-email",
  description: "Sends rejection email to candidate",
  inputSchema: z.object({
    rejectEmails: z.array(ProcessedEmailOutput),
    confirmEmails: z.array(ProcessedEmailOutput),
  }),
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData: { rejectEmails }, mastra }) => {
    if (!rejectEmails || rejectEmails.length === 0) {
      console.log("No rejected email data found for sendRejectionEmail step");
      return "No rejected email data found";
    }

    const gmailMetaAgent = mastra?.getAgent("gmailMetaAgent");
    const gmailGroqAgent = mastra?.getAgent("gmailGroqAgent");

    if (!gmailMetaAgent) {
      throw new Error("Gmail Meta Agent not found");
    }

    if (!gmailGroqAgent) {
      throw new Error("Gmail Groq Agent not found");
    }

    const sendRejectionPrompt = {
      instructions: `
You are an AI agent responsible for sending automated rejection emails to candidates. Your task is to analyze the provided screening data (which you already have) and perform the following two steps in order:

---
**STEP 1: GENERATE AND SEND REJECTION EMAIL**

- Parse the pre-screened candidate data in JSON format and extract:
  - Candidate's Name
  - Candidate's Email
  - Position
  - Technologies
  - Experience
  - Projects
  - Company
  - Original Subject
  - Thread ID
  - Message ID
  - Security Check
  - Resume Status (RESUME_STATUS)
  - Cover Letter Status (COVER_LETTER_STATUS)

**IMPORTANT PERSONALIZATION INSTRUCTIONS:**
- You MUST replace every placeholder in the email template (such as [NAME], [POSITION], [COMPANY], [RESUME_STATUS], [COVER_LETTER_STATUS]) with the corresponding value from the candidate’s data.
- If any field is missing in the data, use "N/A" as a fallback, but do your best to personalize with available information.
- The final email must not contain any empty placeholders or missing details.

- Use the REJECTION TEMPLATE below.
- The email must be sent as a reply in the same thread, using the provided threadId and inReplyTo messageId.
- Use new lines for line breaks in the email body.
- Ensure the subject is "Re: [ORIGINAL_SUBJECT]".

**REJECTION TEMPLATE:**
to: [CANDIDATE_EMAIL]
threadId: [THREAD_ID]
inReplyTo: [MESSAGE_ID]
Subject: Re: [ORIGINAL_SUBJECT]
Body:
Dear [NAME],

Thank you for your interest in [POSITION] at [COMPANY]. Unfortunately, we are unable to move forward with your application due to missing key documents. We noticed that your [RESUME_STATUS == "MISSING" ? "resume and" : ""][COVER_LETTER_STATUS == "MISSING" ? "cover letter" : ""] were not attached to your application.

Please know that this decision is not a reflection of your qualifications, and we wish you the best of luck in your job search.

Best,
Recruitment Team

---
**STEP 2: MODIFY EMAIL LABELS**

**LABEL HANDLING INSTRUCTIONS:**
- After sending the email, add the label "REJECTED_APPLICATIONS_DUE_TO_MISSING_DOCUMENTS" to the email.
- Remove the "INBOX" label from the email.

---
**FINAL OUTPUT INSTRUCTIONS (MANDATORY):**

- Your ENTIRE response MUST be ONLY the confirmation message: "Email sent to [CANDIDATE_EMAIL]".
- Do NOT include any conversational text, explanations, summaries, or markdown.
- Do NOT output the email content, template, or any other information.
- Double-check that your output is ONLY the confirmation message and nothing else.

**Example of FINAL OUTPUT:**
Email sent to [CANDIDATE_EMAIL]
`,
      maxSteps: 10,
      maxTokens: 600,
      toolsets: await gmailMcp.getToolsets(),
    };

    for (let mail of rejectEmails) {
      console.log("Sending rejection email to: ", mail.email);

      try {
        const sendMailResult = await callAgent({
          agent: gmailGroqAgent,
          fallbackAgent: gmailMetaAgent,
          task: `Send rejection email to ${JSON.stringify(mail)}`,
          prompt: sendRejectionPrompt,
        });

        console.log(" Email sent successfully", sendMailResult);
        return "Email sent successfully";
      } catch (e) {
        console.log("Error sending rejection email to: ", mail.email, e);
        return "Error sending rejection email";
      }
    }

    return "Email sent successfully";
  },
});

const sendConfirmationEmail = createStep({
  id: "send-confirmation-email",
  description: "Sends confirmation email to candidate",
  inputSchema: z.object({
    confirmEmails: z.array(ProcessedEmailOutput),
    rejectEmails: z.array(ProcessedEmailOutput),
  }),
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData: { confirmEmails }, mastra }) => {
    if (!confirmEmails || confirmEmails.length === 0) {
      console.log(
        "No confirmed email data found for sendConfirmationEmail step"
      );
      return "No confirmed email data found";
    }

    const gmailMetaAgent = mastra?.getAgent("gmailMetaAgent");
    const gmailGroqAgent = mastra?.getAgent("gmailGroqAgent");

    if (!gmailMetaAgent) {
      throw new Error("Gmail Meta Agent not found");
    }

    if (!gmailGroqAgent) {
      throw new Error("Gmail Groq Agent not found");
    }

    const sendConfirmationPrompt = {
      instructions: `
You are an AI agent responsible for sending automated confirmation emails to candidates. Your task is to analyze the provided screening data (which you already have) and perform the following two steps in order:

---
**STEP 1: GENERATE AND SEND CONFIRMATION EMAIL**

- Parse the pre-screened candidate data in JSON format and extract:
  - Candidate's Name
  - Candidate's Email
  - Position
  - Technologies
  - Experience
  - Projects
  - Company
  - Original Subject
  - Thread ID
  - Message ID
  - Security Check

**IMPORTANT PERSONALIZATION INSTRUCTIONS:**
- You MUST replace every placeholder in the email template (such as [NAME], [POSITION], [COMPANY], [TECHNOLOGIES], [PROJECTS]) with the corresponding value from the candidate’s data.
- For [TECHNOLOGIES], select and mention at least one specific technology from the candidate’s data.
- For [PROJECTS], select and mention at least one specific project from the candidate’s data.
- If any field is missing in the data, use "N/A" as a fallback, but do your best to personalize with available information.
- The final email must not contain any empty placeholders or missing details.

- Use the CONFIRMATION TEMPLATE below.
- The email must be sent as a reply in the same thread, using the provided threadId and inReplyTo messageId.
- Use new lines for line breaks in the email body.
- Ensure the subject is "Re: [ORIGINAL_SUBJECT]".

**CONFIRMATION TEMPLATE:**
to: [CANDIDATE_EMAIL]
threadId: [THREAD_ID]
inReplyTo: [MESSAGE_ID]
Subject: Re: [ORIGINAL_SUBJECT]
Body:
Dear [NAME],

Thank you for your interest in [POSITION] at [COMPANY]. We are pleased to inform you that we have received your application and it is currently being screened by our recruitment team. We appreciate your patience and will be in touch with you soon to discuss the next steps.

We were particularly impressed by your [TECHNOLOGIES] skills and your work on [PROJECTS]. We believe that your experience and skills would be a great fit for our team and we are excited to learn more about you.

Thank you again for your interest in [COMPANY]. We look forward to speaking with you soon.

Best,
Recruitment Team

---
**STEP 2: MODIFY EMAIL LABELS**

**LABEL HANDLING INSTRUCTIONS:**
- After sending the email, always check for the label named as the position in uppercase with spaces replaced by underscores, followed by "_APPLICATIONS" (e.g., "FRONTEND_DEVELOPER_APPLICATIONS").
- If the label exists, add it to the email and remove the "INBOX" label.
- If the label does not exist, create it, add it to the email, and remove the "INBOX" label.
- Remove the "INBOX" label from the email.

---
**FINAL OUTPUT INSTRUCTIONS (MANDATORY):**

- Your ENTIRE response MUST be ONLY the confirmation message: "Email sent to [CANDIDATE_EMAIL]".
- Do NOT include any conversational text, explanations, summaries, or markdown.
- Do NOT output the email content, template, or any other information.
- Double-check that your output is ONLY the confirmation message and nothing else.

**Example of FINAL OUTPUT:**
Email sent to [CANDIDATE_EMAIL]
`,
      maxSteps: 10,
      maxTokens: 600,
      toolsets: await gmailMcp.getToolsets(),
    };
    for (let mail of confirmEmails) {
      console.log("Sending confirmation email to: ", mail.email);

      try {
        const sendMailResult = await callAgent({
          agent: gmailGroqAgent,
          fallbackAgent: gmailMetaAgent,
          task: `Send confirmation email to ${mail.email}`,
          prompt: sendConfirmationPrompt,
        });

        console.log(" Email sent successfully", sendMailResult);
        return "Email sent successfully";
      } catch (e) {
        console.log("Error sending confirmation email to: ", mail.email, e);
        return "Error sending confirmation email";
      }
    }

    return "Email sent successfully";
  },
});

const recruitWorkflowV2 = createWorkflow({
  id: "recruit-V2",
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
  .foreach(processSecureEmail)
  .foreach(extractDataFromEmail)
  .foreach(analyzeEmail)
  .then(sortEmailData)
  .branch([
    [
      async ({ inputData: { rejectEmails } }) => rejectEmails.length > 0,
      sendRejectionEmail,
    ],
    [
      async ({ inputData: { confirmEmails } }) => confirmEmails.length > 0,
      sendConfirmationEmail,
    ],
  ]);
recruitWorkflowV2.commit();

export { recruitWorkflowV2 };
