import { createStep, createWorkflow } from "@mastra/core";
import z from "zod";
import { gmailMcp } from "../mcpservers/gmail";

const recruitmentMail = process.env.RECRUITMENT_MAIL;

if (!recruitmentMail) {
  throw new Error("RECRUITMENT_MAIL environment variable is not set");
}

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
      throw new Error("Input data not found");
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
      instructions: `🚨 GMAIL PUB/SUB NOTIFICATION HANDLER 🚨

SITUATION: Gmail sent a push notification with historyId: ${historyId}
This means: NEW EMAIL(S) JUST ARRIVED in the Gmail inbox

YOUR MISSION: Find job application emails among the newly arrived messages

EXECUTION PLAN:
1. Use gmail_search_emails with query: "newer_than:5m in:inbox"
   (Search last 5 minutes since notification just arrived)

2. Look for job application indicators:
   - Subject contains: application, applying, resume, job, position, cover, letter, hiring, interview, candidate, recruitment
   - From: HR departments, recruiters, job boards
   - Content: job-related keywords

3. CRITICAL FILTERING - SKIP these emails:
   ❌ From: ${recruitmentMail} (our own recruitment email)
   ❌ From: emails containing "recruitment", "hr@", "hiring@" from same domain
   ❌ Subject: starts with "Re:" (replies to our emails)
   ❌ Body contains: "Best regards, Recruitment Team"
   ❌ Body contains: "We encourage you to reapply"
   ❌ Body contains: "Thank you for your interest in the"
   ❌ Body contains: "Our recruitment team will review"
   ❌ Body contains: "missing documents"
   ❌ Body contains: "complete application"

4. Extract ONLY the Gmail MESSAGE IDs (not email addresses!) from VALID candidate emails

ENHANCED SEARCH QUERY TO USE:
"newer_than:5m in:inbox (subject:application OR subject:job OR subject:resume OR subject:position OR subject:hiring OR subject:interview OR subject:candidate) -from:${recruitmentMail} -subject:Re:"

FILTERING ALGORITHM:
For each email found:
1. Check if from field contains "${recruitmentMail}" → SKIP
2. Check if subject starts with "Re:" → SKIP  
3. Check if body contains "Best regards, Recruitment Team" → SKIP
4. Check if body contains "We encourage you to reapply" → SKIP
5. Check if body contains "Our recruitment team will review" → SKIP
6. If email passes all filters → INCLUDE message ID

🚨 CRITICAL OUTPUT REQUIREMENTS 🚨
- RETURN ONLY: ["messageId1", "messageId2", "messageId3"]
- NO explanations, NO descriptions, NO processing details
- NO "Found X emails" messages
- NO "Filtering complete" messages  
- NO "Search results:" text
- NO additional commentary
- JUST THE ARRAY OF MESSAGE IDs
- If no emails found: []
- NOTHING ELSE

EXAMPLE CORRECT OUTPUTS:
✅ ["1a2b3c4d5e", "6f7g8h9i0j"]
✅ ["abc123"]
✅ []

EXAMPLE INCORRECT OUTPUTS:
❌ "Found 2 emails: ['abc123', 'def456']"
❌ "Search complete. Results: ['abc123']"
❌ "After filtering: ['abc123', 'def456']"
❌ Any text before or after the array

CRITICAL CONSTRAINTS:
- This is REAL-TIME processing of new email notification
- Focus on VERY RECENT emails (last 5 minutes max)
- Use gmail_search_emails tool (only search tool available)
- Return Gmail message IDs as strings: ["abc123", "def456"]
- NO email addresses, NO sender info, NO subject lines
- EXCLUDE all emails from ${recruitmentMail}
- EXCLUDE all replies and recruitment team emails

EXPECTED OUTPUT FORMAT:
- ONLY Array of Gmail message ID strings from EXTERNAL candidates
- ONLY Empty array [] if no valid job emails found (after filtering)
- ABSOLUTELY NO explanatory text
- ABSOLUTELY NO processing descriptions
- JUST THE ARRAY

PubSub Context: historyId ${historyId} = notification trigger point

🎯 EXECUTE SEARCH WITH FILTERING NOW AND RETURN ONLY THE ARRAY 🎯`,
      maxSteps: 50,
      maxTokens: 512,
      toolsets: await gmailMcp.getToolsets(),
    };

    try {
      const response = await gmailAgent.generate(
        `URGENT: Gmail Pub/Sub notification received! New email(s) arrived (historyId: ${historyId}). Search for job application emails among the newly arrived messages.`,
        fetchNewMailsPrompt
      );

      const result: string[] = JSON.parse(response.text);
      console.log("STEP 1: Gmail search results:", result);
      return result;
    } catch (e) {
      if (
        e instanceof Error &&
        e.message.includes("You have reached the rate limit")
      ) {
        console.log(
          "API rate limit exceeded, waiting for 1 minute to retry..."
        );
        await new Promise((resolve) => setTimeout(resolve, 60000)); // Block and wait 1 minute

        try {
          const retryResponse = await gmailAgent.generate(
            `URGENT: Gmail Pub/Sub notification received! New email(s) arrived (historyId: ${historyId}). Search for job application emails among the newly arrived messages.`,
            fetchNewMailsPrompt
          );

          const retryResult: string[] = JSON.parse(retryResponse.text);
          console.log("STEP 1: Gmail search results:", retryResult);
          return retryResult;
        } catch (retryError) {
          console.error("Retry after rate limit also failed:", retryError);
          return [];
        }
      } else {
        console.error("Unexpected error occurred:", e);
        return [];
      }
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
      throw new Error("Input data not found");
    }

    console.log("Deduplicating newly arrived emails...", inputData);

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
        console.log("No valid email IDs found in the response");
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

const processRecruitmentEmails = createStep({
  id: "process-recruitment-emails",
  description: "Processes recruitment emails using an agent with Gmail tools",
  inputSchema: z.string().describe("A single email ID"),
  outputSchema: z
    .string()
    .describe("Output of the agent analysis of the email"),
  execute: async ({ inputData: emailId, mastra }) => {
    if (!emailId || typeof emailId !== "string") {
      console.log("no new emails to process ");
      return "no new emails to process";
    }

    const gmailAgent = mastra.getAgent("gmailAgent");

    if (!gmailAgent) {
      throw new Error("Gmail agent not found");
    }

    console.log("Processing recruitment emails...", emailId);

    const processRecruitmentEmailsPrompt = {
      instructions: `RECRUITMENT WORKFLOW – EMAIL: ${emailId} TO: ${recruitmentMail}

STEP 1: DATA EXTRACTION
Call: gmail_read_email({"messageId": "${emailId}"})
Extract: name, email, position, technologies, years of experience, key projects, company, original subject, threadId.
Output: "STEP 1 COMPLETE"

STEP 2: SECURITY CHECK
Ensure:
- At least 2 job-related keywords (applying, resume, developer, job, etc.)
- Sent to ${recruitmentMail}
- Not spam or bot
- No malicious links
Output: "STEP 2 COMPLETE - VALID: YES/NO"

STEP 3: COVER LETTER SCORING (0–5)
1pt: professional intro  
1pt: experience details  
1pt: technologies  
1pt: ≥200 characters  
1pt: interest in company  
Score ≥3 = PRESENT, else MISSING  
Output: "STEP 3 COMPLETE - PRESENT/MISSING (Score X/5)"

STEP 4: RESUME SCORING (0–4)
1pt: valid attachment (.pdf/.doc)  
1pt: filename has "resume" or "cv"  
1pt: body mentions resume/attached  
1pt: LinkedIn/GitHub/portfolio link  
Score ≥2 = PRESENT, else MISSING  
Output: "STEP 4 COMPLETE - PRESENT/MISSING (Score X/4)"

STEP 5: DATA CONFIRMATION
Print extracted values (no placeholders): name, email, position, technologies, experience, projects, company, subject, threadId  
Output: "STEP 5 COMPLETE"

STEP 6: OUTPUT FORMAT
Your ENTIRE response MUST be ONLY this JSON object. No other text, no explanations, no code, no markdown outside the JSON block.:

{
  "name": "actual_candidate_name",
  "email": "actual_email_address",
  "position": "actual_position",
  "technologies": "actual_technologies",
  "experience": "actual_experience",
  "projects": "actual_projects",
  "company": "actual_company",
  "subject": "actual_subject",
  "threadId": "actual_thread_id",
  "isValid": true,
  "hasAttachment": false,
  "hasCoverLetter": true,
  "hasResume": false
}

⚠️ DO NOT include additional content. No explanations, markdown, summaries, or tool calls beyond STEP 1.
Only return the JSON object as specified in STEP 6.`,
      maxSteps: 35,
      maxTokens: 550, // Slightly safer than 800 to avoid hitting 8192 again
      toolsets: await gmailMcp.getToolsets(),
    };

    try {
      const result = await gmailAgent.generate(
        `Process recruitment workflow for email ID: ${JSON.stringify(emailId)}. Send rejection emails from ${recruitmentMail} to candidates missing documents.`,

        processRecruitmentEmailsPrompt
      );
      const FinalOutput = result.text;
      console.log("STEP 3 (iteration): Email screening Output:", FinalOutput);
      return FinalOutput;
    } catch (e) {
      if (
        e instanceof Error &&
        e.message.includes("You have reached the rate limit")
      ) {
        console.log(
          "API rate limit exceeded, waiting for 1 minute to retry..."
        );
        await new Promise((resolve) => setTimeout(resolve, 60000)); // Block and wait for 1 minute

        try {
          const retryResult = await gmailAgent.generate(
            `Process recruitment workflow for email ID: ${JSON.stringify(emailId)}. Send rejection emails from ${recruitmentMail} to candidates missing documents.`,

            processRecruitmentEmailsPrompt
          );

          const FinalOutput: string = retryResult.text;
          console.log(
            "STEP 3 (iteration): Email screening Output:",
            FinalOutput
          );
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
          const retryResult = await gmailAgent.generate(
            `Process recruitment workflow for email ID: ${JSON.stringify(emailId)}. Send rejection emails from ${recruitmentMail} to candidates missing documents.`,

            processRecruitmentEmailsPrompt
          );

          const FinalOutput: string = retryResult.text;
          console.log(
            "STEP 3 (iteration): Email screening Output:",
            FinalOutput
          );
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
  },
});

const sendReplyEmails = createStep({
  id: "send-reply-emails",
  description: "Sends reply emails to candidates",
  inputSchema: z.string().describe("Output of the agent analysis of the email"),
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData, mastra }) => {
    if (!inputData || typeof inputData !== "string") {
      console.log("No input data found for sendReplyEmails step");
      return "No input data found";
    }

    const gmailAgent = mastra?.getAgent("gmailAgent");

    if (!gmailAgent) {
      throw new Error("Gmail agent not found");
    }

    const sendReplyPrompt = {
      instructions: `You are an AI agent responsible for sending automated recruitment email replies. Your task is to analyze the provided screening data (which you already have) and send a befitting email to the candidate.

---

DETAILED INSTRUCTIONS:

STEP 1: PARSE PROVIDED SCREENING DATA
 - You are provided with the following pre-screened data. Parse it to extract all necessary details:
     - Cover Letter Score (from "STEP 3 COMPLETE - PRESENT (Score X/5)")
     - Resume Score (from "STEP 4 COMPLETE - PRESENT (Score X/4)")
     - Candidate's Name (from JSON)
     - Candidate's Email (from JSON)
     - Position (from JSON)
     - Technologies (from JSON)
     - Experience (from JSON)
     - Projects (from JSON)
     - Company (from JSON)
     - Original Subject (from JSON)
     - Thread ID (from JSON)

STEP 2: DETERMINE REPLY DECISION
 - Based on the extracted scores, decide the type of reply:
     - If Cover Letter Score ≥ 3 AND Resume Score ≥ 2: The decision is "ACCEPTANCE".
     - Otherwise: The decision is "REJECTION".

STEP 3: GENERATE PERSONALIZED EMAIL BODY AND SUBJECT
 - Use the appropriate template based on the decision from STEP 2.
 - Send a formatted email to the candidate. Use new lines for line breaks.
 - Replace all placeholders (e.g., [NAME], [POSITION]) with the actual extracted data.
 - For the ACCEPTANCE TEMPLATE:
     - If 'experience' is "Not specified" or empty, omit the phrase "your [EXPERIENCE] years of experience".
     - If 'projects' is "Not specified" or empty, omit the phrase "and your work on [PROJECTS]".
     - Construct the sentence to flow naturally based on the presence of 'experience' and 'projects' data.
     - Generate a personalized acceptance message for the candidate using the extracted data and the template.
     - Use new lines for line breaks.
- For the REJECTION TEMPLATE:
     - Mention the key documents that are missing (e.g., resume, cover letter).
     - Generate a personalized rejection message for the candidate using the extracted data and the template.
     - Use new lines for line breaks.

 ACCEPTANCE TEMPLATE:
 Subject: Re: [ORIGINAL_SUBJECT]
 Body: Dear [NAME],
 Thank you for applying to [POSITION] at [COMPANY]. We appreciate your [EXPERIENCE] years of experience with [TECHNOLOGIES] and your work on [PROJECTS]. Our team will review and respond shortly.
 Best,
 Recruitment Team

 REJECTION TEMPLATE:
 Subject: Re: [ORIGINAL_SUBJECT]
 Body: Dear [NAME],
 Thank you for your interest in [POSITION] at [COMPANY]. Your application is missing key documents. Please resubmit with full materials.
 Best,
 Recruitment Team

STEP 4: SEND EMAIL
 - Use the 'gmail_send_email' tool to send the generated email.
 - Parameters for gmail_send_email:
     - "to": ["extracted_candidate_email"]
     - "subject": "generated_subject"
     - "body": "generated_personalized_message"
     - "mimeType": "text/plain"
     - "threadId": "extracted_threadId"
     - "inReplyTo": "original_email_message_id" // This should be the messageId of the email you just screened
     - "cc": []
     - "bcc": []
     - "attachments": []

FINAL OUTPUT:
Your ENTIRE response MUST be ONLY the confirmation message of the email being sent. Do NOT include any conversational text, step-by-step descriptions, analysis summaries, or markdown outside of the confirmation.

Example of FINAL OUTPUT: "Email sent to [CANDIDATE_EMAIL]"

CRITICAL RULES:
- You MUST parse the provided input data to get all necessary details.
- You MUST make a decision (ACCEPTANCE/REJECTION) based on the cover letter and resume scores.
- You MUST generate a personalized email using the correct template and extracted data.
- You MUST call the 'gmail_send_email' tool with the correct parameters.
- Your final output MUST be ONLY the confirmation message, nothing else.
- Do NOT generate any code (Python, JavaScript, etc.) in the final output.
- Do NOT include the 'gmail_send_email' tool call itself in the final output, only the confirmation.
- Do NOT perform any email reading or analysis; use the provided data directly.
`,
      maxSteps: 5, // Sufficient steps for parsing, decision, and sending
      maxTokens: 400, // Sufficient for parsing and generating a confirmation
      toolsets: await gmailMcp.getToolsets(),
    };
    try {
      const result = await gmailAgent.generate(
        `Send reply email to candidate by analyzing email details: ${JSON.stringify(inputData)}.`,
        sendReplyPrompt
      );
      const FinalOutput = result.text;
      console.log("STEP 4 (iteration): SEND EMAIL Output:", FinalOutput);
      return FinalOutput;
    } catch (e) {
      if (
        e instanceof Error &&
        e.message.includes("You have reached the rate limit")
      ) {
        console.log(
          "API rate limit exceeded, waiting for 1 minute to retry..."
        );
        await new Promise((resolve) => setTimeout(resolve, 60000)); // Block and wait for 1 minute

        try {
          const retryResult = await gmailAgent.generate(
            `Send reply email to candidate by analyzing email details: ${JSON.stringify(inputData)}.`,

            sendReplyPrompt
          );

          const FinalOutput: string = retryResult.text;
          console.log("STEP 4 (iteration): SEND EMAIL Output:", FinalOutput);
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
          const retryResult = await gmailAgent.generate(
            `Send reply email to candidate by analyzing email details: ${JSON.stringify(inputData)}.`,

            sendReplyPrompt
          );

          const FinalOutput: string = retryResult.text;
          console.log("STEP 4 (iteration): SEND EMAIL Output:", FinalOutput);
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
  },
});

const recruitAgentWorkflow = createWorkflow({
  id: "recruit-agent-workflow",
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
    processRecruitmentEmails,
    sendReplyEmails,
  ],
  retryConfig: {
    attempts: 5,
    delay: 5000,
  },
})
  .then(AgentTrigger)
  .then(deduplicateNewlyArrivedMails)
  .foreach(processRecruitmentEmails, {
    concurrency: 2,
  })
  .foreach(sendReplyEmails, {
    concurrency: 2,
  });

recruitAgentWorkflow.commit();

export { recruitAgentWorkflow };
