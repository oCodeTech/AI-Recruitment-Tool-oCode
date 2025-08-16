import { createStep, createWorkflow } from "@mastra/core";
import z from "zod";
import {
  gmailSearchEmails,
  getEmailContent,
  sendThreadReplyEmail,
} from "../../utils/gmail";
import { getGmailClient } from "../../OAuth/getGmailClient";

// First node: Search for emails with specific subject and extract basic info
const searchTestEmails = createStep({
  id: "search-test-emails",
  description:
    "Searches for emails with subject 'Test: testing template formatting and naming issues!' and extracts basic information",
  inputSchema: z
    .boolean()
    .describe("Boolean trigger to start the debug workflow"),
  outputSchema: z
    .array(
      z.object({
        emailId: z.string().describe("Gmail email ID"),
        messageId: z
          .string()
          .nullable()
          .describe("Message ID from email headers"),
        threadId: z.string().nullable().describe("Gmail thread ID"),
        subject: z.string().nullable().describe("Email subject"),
        from: z.string().nullable().describe("Sender email address"),
        to: z.string().nullable().describe("Recipient email address"),
        date: z.string().nullable().describe("Email date"),
        snippet: z.string().nullable().describe("Email snippet/preview"),
        senderName: z.string().nullable().describe("Extracted sender name"),
        senderEmail: z.string().nullable().describe("Extracted sender email"),
      })
    )
    .describe("Array of found test emails with basic information"),
  execute: async ({ inputData }) => {
    if (!inputData) {
      console.log("Debug workflow not triggered - input is false");
      return [];
    }

    console.log("🔍 Searching for test emails with specific subject...");

    try {
      // Search for emails with the specific subject
      const searchResult = await gmailSearchEmails({
        userId: "me",
        q: 'subject:"Test: testing template formatting and naming issues!" -subject:"Re: Test: testing template formatting and naming issues!"',
        maxResults: 1,
      });

      console.log(
        `📧 Found ${searchResult.length} emails matching the search criteria`
      );

      const emailsInfo = [];

      for (const email of searchResult) {
        if (!email.id || !email.threadId) continue;

        try {
          // Get detailed email content
          const emailContent = await getEmailContent(email.id);

          if (!emailContent) continue;

          // Extract headers
          const headers = emailContent.payload?.headers || [];
          const messageId =
            headers.find((h) => h.name?.toLowerCase() === "message-id")
              ?.value || null;
          const subject =
            headers.find((h) => h.name?.toLowerCase() === "subject")?.value ||
            null;
          const from =
            headers.find((h) => h.name?.toLowerCase() === "from")?.value ||
            null;
          const to =
            headers.find((h) => h.name?.toLowerCase() === "to")?.value || null;
          const date =
            headers.find((h) => h.name?.toLowerCase() === "date")?.value ||
            null;

          // Extract sender name and email from "from" field
          let senderName = null;
          let senderEmail = null;

          if (from) {
            // Parse "Name <email@domain.com>" format
            const match =
              from.match(/^(.+?)\s*<(.+?)>$/) || from.match(/^(.+)$/);
            if (match) {
              if (match[2]) {
                // Format: "Name <email>"
                senderName = match[1].trim().replace(/^["']|["']$/g, ""); // Remove quotes
                senderEmail = match[2].trim();
              } else {
                // Format: just email
                senderEmail = match[1].trim();
                senderName = senderEmail.split("@")[0]; // Use email prefix as name
              }
            }
          }

          const emailInfo = {
            emailId: email.id,
            messageId,
            threadId: email.threadId,
            subject,
            from,
            to,
            date,
            snippet: emailContent.snippet || null,
            senderName,
            senderEmail,
          };

          emailsInfo.push(emailInfo);

          console.log(`✅ Processed email: ${email.id}`);
          console.log(`   Subject: ${subject}`);
          console.log(`   From: ${from}`);
          console.log(`   Sender Name: ${senderName}`);
          console.log(`   Sender Email: ${senderEmail}`);
          console.log(`   Date: ${date}`);
        } catch (error) {
          console.error(`❌ Error processing email ${email.id}:`, error);
          continue;
        }
      }

      console.log(`📊 Successfully processed ${emailsInfo.length} emails`);
      return emailsInfo;
    } catch (error) {
      console.error("❌ Error searching for emails:", error);
      return [];
    }
  },
});

// Second node: Send thread reply emails using the extracted data
const sendTestReplyEmails = createStep({
  id: "send-test-reply-emails",
  description:
    "Sends thread reply emails using the extracted email data and sendThreadReplyEmail function",
  inputSchema: z
    .array(
      z.object({
        emailId: z.string().describe("Gmail email ID"),
        messageId: z
          .string()
          .nullable()
          .describe("Message ID from email headers"),
        threadId: z.string().nullable().describe("Gmail thread ID"),
        subject: z.string().nullable().describe("Email subject"),
        from: z.string().nullable().describe("Sender email address"),
        to: z.string().nullable().describe("Recipient email address"),
        date: z.string().nullable().describe("Email date"),
        snippet: z.string().nullable().describe("Email snippet/preview"),
        senderName: z.string().nullable().describe("Extracted sender name"),
        senderEmail: z.string().nullable().describe("Extracted sender email"),
      })
    )
    .describe("Array of found test emails with basic information"),
  outputSchema: z
    .object({
      totalEmails: z.number().describe("Total number of emails processed"),
      successfulReplies: z
        .number()
        .describe("Number of successful replies sent"),
      failedReplies: z.number().describe("Number of failed replies"),
      replyResults: z
        .array(
          z.object({
            emailId: z.string().describe("Original email ID"),
            threadId: z.string().nullable().describe("Thread ID"),
            success: z
              .boolean()
              .describe("Whether reply was sent successfully"),
            replyMessageId: z
              .string()
              .nullable()
              .describe("ID of the sent reply message"),
            error: z.string().nullable().describe("Error message if failed"),
            senderName: z
              .string()
              .nullable()
              .describe("Name of original sender"),
            senderEmail: z
              .string()
              .nullable()
              .describe("Email of original sender"),
          })
        )
        .describe("Results of reply attempts"),
    })
    .describe("Results of sending thread reply emails"),
  execute: async ({ inputData }) => {
    if (!inputData || inputData.length === 0) {
      console.log("⚠️ No emails to reply to");
      return {
        totalEmails: 0,
        successfulReplies: 0,
        failedReplies: 0,
        replyResults: [],
      };
    }

    console.log(
      `📤 Sending reply emails to ${inputData.length} test emails...`
    );

    const replyResults = [];
    let successfulReplies = 0;
    let failedReplies = 0;

    for (const emailInfo of inputData) {
      try {
        console.log(`📧 Sending reply to email: ${emailInfo.emailId}`);

        // Validate required fields
        if (
          !emailInfo.threadId ||
          !emailInfo.messageId ||
          !emailInfo.senderEmail
        ) {
          console.warn(
            `⚠️ Missing required fields for email ${emailInfo.emailId}`
          );
          replyResults.push({
            emailId: emailInfo.emailId,
            threadId: emailInfo.threadId,
            success: false,
            replyMessageId: null,
            error:
              "Missing required fields (threadId, messageId, or senderEmail)",
            senderName: emailInfo.senderName,
            senderEmail: emailInfo.senderEmail,
          });
          failedReplies++;
          continue;
        }

        // Prepare parameters for sendThreadReplyEmail
        const replyParams = {
          name: emailInfo.senderName || "User",
          position: "Test Position", // Default position for debug
          userEmail: emailInfo.senderEmail,
          subject: emailInfo.subject,
          threadId: emailInfo.threadId,
          emailId: emailInfo.emailId,
          inReplyTo: emailInfo.messageId,
          references: [emailInfo.messageId], // Array of message IDs for threading
          templateId: "templates-request_key_details-creative", // Using a default template
        };

        console.log(`   📋 Reply parameters:`, {
          name: replyParams.name,
          userEmail: replyParams.userEmail,
          subject: replyParams.subject,
          threadId: replyParams.threadId,
          templateId: replyParams.templateId,
        });

        // Send the reply email
        const replyResponse = await sendThreadReplyEmail(replyParams);

        if (replyResponse && replyResponse.id) {
          console.log(`   ✅ Reply sent successfully: ${replyResponse.id}`);
          replyResults.push({
            emailId: emailInfo.emailId,
            threadId: emailInfo.threadId,
            success: true,
            replyMessageId: replyResponse.id,
            error: null,
            senderName: emailInfo.senderName,
            senderEmail: emailInfo.senderEmail,
          });
          successfulReplies++;
        } else {
          console.warn(
            `   ⚠️ Reply response missing ID for email ${emailInfo.emailId}`
          );
          replyResults.push({
            emailId: emailInfo.emailId,
            threadId: emailInfo.threadId,
            success: false,
            replyMessageId: null,
            error: "Reply response missing ID",
            senderName: emailInfo.senderName,
            senderEmail: emailInfo.senderEmail,
          });
          failedReplies++;
        }
      } catch (error) {
        console.error(
          `❌ Error sending reply to email ${emailInfo.emailId}:`,
          error
        );
        replyResults.push({
          emailId: emailInfo.emailId,
          threadId: emailInfo.threadId,
          success: false,
          replyMessageId: null,
          error: error instanceof Error ? error.message : "Unknown error",
          senderName: emailInfo.senderName,
          senderEmail: emailInfo.senderEmail,
        });
        failedReplies++;
      }
    }

    const result = {
      totalEmails: inputData.length,
      successfulReplies,
      failedReplies,
      replyResults,
    };

    console.log(`📊 Reply Results Summary:`);
    console.log(`   📧 Total emails: ${result.totalEmails}`);
    console.log(`   ✅ Successful replies: ${successfulReplies}`);
    console.log(`   ❌ Failed replies: ${failedReplies}`);
    console.log(
      `   📈 Success rate: ${result.totalEmails > 0 ? Math.round((successfulReplies / result.totalEmails) * 100) : 0}%`
    );

    return result;
  },
});

// Create the debug workflow
const debugWorkflow = createWorkflow({
  id: "debug-workflow",
  description: "Debug workflow to search test emails and send thread replies",
  inputSchema: z
    .boolean()
    .describe("Boolean trigger to start the debug workflow"),
  outputSchema: z
    .object({
      totalEmails: z.number().describe("Total number of emails processed"),
      successfulReplies: z
        .number()
        .describe("Number of successful replies sent"),
      failedReplies: z.number().describe("Number of failed replies"),
      replyResults: z
        .array(
          z.object({
            emailId: z.string().describe("Original email ID"),
            threadId: z.string().nullable().describe("Thread ID"),
            success: z
              .boolean()
              .describe("Whether reply was sent successfully"),
            replyMessageId: z
              .string()
              .nullable()
              .describe("ID of the sent reply message"),
            error: z.string().nullable().describe("Error message if failed"),
            senderName: z
              .string()
              .nullable()
              .describe("Name of original sender"),
            senderEmail: z
              .string()
              .nullable()
              .describe("Email of original sender"),
          })
        )
        .describe("Results of reply attempts"),
    })
    .describe("Final debug workflow output with reply results"),
  steps: [searchTestEmails, sendTestReplyEmails],
  retryConfig: {
    attempts: 3,
    delay: 2000,
  },
})
  .then(searchTestEmails)
  .then(sendTestReplyEmails);

// Commit the workflow
debugWorkflow.commit();

export { debugWorkflow };
