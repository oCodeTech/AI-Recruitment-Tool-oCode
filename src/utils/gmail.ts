import { gmail_v1 } from "googleapis";
import { getGmailClient } from "../OAuth/getGmailClient";
import { missingMultipleDetailsTemplate } from "../templates/rejection/missingMultipleDetails";
import { noResumeTemplate } from "../templates/rejection/noResume";
import { noCoverLetterTemplate } from "../templates/rejection/noCoverLetter";
import { noClearJobPositionTemplate } from "../templates/rejection/noClearJobPosition";
import { experiencedTechTemplate } from "../templates/requestKeyDetails/tech/experiencedTech";
import { fresherTechTemplate } from "../templates/requestKeyDetails/tech/fresherTech";
import { nonTechTemplate } from "../templates/requestKeyDetails/nonTech";
import { creativeTemplate } from "../templates/requestKeyDetails/creative";
import { resendKeyDetailsTemplate } from "../templates/requestKeyDetails/resendKeyDetails";

interface EmailData {
  to: string | null;
  subject: string | null;
  body?: string;
  rawMessage?: string;
  inReplyTo?: string;
  references?: string[];
  threadId: string;
  bccEmail?: string;
}

const recruitmentMail = process.env.RECRUITMENT_MAIL || "hi@ocode.co";

if (!recruitmentMail) {
  throw new Error("RECRUITMENT_MAIL environment variable is not set");
}

const gmailClient = await getGmailClient(recruitmentMail);

const resolveLabelIds = async (labels: string[]) => {
  const existingLabels = await gmailClient.users.labels.list({
    userId: "me",
  });
  const labelMap = new Map(
    existingLabels.data.labels?.map((l) => [l.name, l.id])
  );

  const ids: string[] = [];

  for (const name of labels) {
    if (["INBOX", "UNREAD", "STARRED", "IMPORTANT"].includes(name)) {
      ids.push(name);
    } else if (labelMap.has(name)) {
      ids.push(labelMap.get(name)!);
    } else {
      console.warn(`Label not found, creating: ${name}`);
      const created = await gmailClient.users.labels.create({
        userId: "me",
        requestBody: {
          name,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        },
      });
      const newLabelId = created.data.id;
      if (newLabelId) {
        ids.push(newLabelId);
        labelMap.set(name, newLabelId);
      }
    }
  }

  return ids;
};

export const getLabelId = async (label: string) => {
  if (!label) throw Error("Label was not provided");

  const existingLabels = await gmailClient.users.labels.list({
    userId: "me",
  });
  const labelMap = new Map(
    existingLabels.data.labels?.map((l) => [l.name, l.id])
  );

  if (["INBOX", "UNREAD", "STARRED", "IMPORTANT"].includes(label)) {
    return label;
  } else if (labelMap.has(label)) {
    return labelMap.get(label);
  } else {
    throw Error("Label not found");
  }
};

export const getLabelNames = async (labelIds: string[]): Promise<string[]> => {
  if (!labelIds || labelIds.length === 0) throw Error("Label was not provided");

  const existingLabels = await gmailClient.users.labels.list({
    userId: "me",
  });
  const labelMap = new Map(
    existingLabels.data.labels?.map((l) => [l.name, l.id])
  );

  const labels: string[] = [];

  for (let labelId of labelIds) {
    if (["INBOX", "UNREAD", "STARRED", "IMPORTANT"].includes(labelId)) {
      labels.push(labelId);
    } else if (Array.from(labelMap.values()).includes(labelId)) {
      const entry = Array.from(labelMap.entries()).find(
        ([_, value]) => value === labelId
      );

      if (!entry || !entry[0]) {
        continue;
      }

      labels.push(entry[0]);
    } else {
      continue;
    }
  }

  return labels;
};

export const gmailSearchEmails = async (searchProps: {
  userId?: string;
  q: string;
  labelIds?: string[];
  maxResults?: number;
}) => {
  try {
    const labelIds = await resolveLabelIds(searchProps.labelIds || []);

    const { labelIds: _, ...rest } = searchProps;

    const res = await gmailClient.users.messages.list({
      userId: "me",
      labelIds: labelIds.length > 0 ? labelIds : undefined,
      ...rest,
    });
    return res.data.messages || [];
  } catch (error) {
    throw error;
  }
};

export const getEmailContent = async (emailId: string) => {
  if (!emailId) throw new Error("emailId is required");
  try {
    const response = await gmailClient.users.messages.get({
      userId: "me",
      id: emailId,
    });

    return response.data;
  } catch (error) {
    throw error;
  }
};

export const getAttachment = async (attachmentId: string) => {
  if (!attachmentId) throw new Error("attachmentId is required");
  try {
    const response = await gmailClient.users.messages.attachments.get({
      userId: "me",
      messageId: attachmentId,
      id: attachmentId,
    });
    return response.data;
  } catch (error) {
    throw error;
  }
};

export const containsKeyword = ({
  text,
  keywords,
  minWordWindow = 0, // how many words must surround the matched phrase
}: {
  text: string;
  keywords: string[];
  minWordWindow?: number;
}) => {
  if (!text) return false;

  const lower = text.toLowerCase();

  return keywords.some((kw) => {
    // Regex pattern (starts/ends with /)
    if (kw.startsWith("/") && kw.endsWith("/")) {
      try {
        return new RegExp(kw.slice(1, -1), "i").test(text);
      } catch {
        return false;
      }
    }

    // Simple substring (with optional stemming)
    const base = kw.toLowerCase();
    if (lower.includes(base)) {
      if (minWordWindow === 0) return true;

      // Ensure the phrase sits inside a long-enough sentence
      const idx = lower.indexOf(base);
      const start = Math.max(0, idx - 120);
      const end = Math.min(lower.length, idx + base.length + 120);
      const windowWords = lower.slice(start, end).split(/\s+/).length;
      return windowWords >= minWordWindow;
    }

    return false;
  });
};

export const getDraftTemplate = async (searchProps: {
  userId?: string;
  q: string;
}) => {
  try {
    const res = await gmailClient.users.drafts.list({
      userId: "me",
      ...searchProps,
    });

    const draftId = res.data.drafts?.[0]?.message?.id;
    if (!draftId) return "";
    return getEmailContent(draftId);
  } catch (error) {
    throw error;
  }
};

export const sendEmail = async ({
  to,
  subject,
  body,
  inReplyTo,
  references,
  threadId,
  bccEmail = "career@browsewire.net",
  rawMessage,
}: EmailData) => {
  if (!to || !subject || !body || !threadId) {
    throw new Error("Email data is required");
  }
  if (typeof threadId !== "string" || threadId.trim() === "") {
    throw new Error("Invalid threadId");
  }

  try {
    if (rawMessage) {
      const response = await gmailClient.users.messages.send({
        userId: "me",
        requestBody: {
          raw: rawMessage,
          threadId: threadId,
        },
      });
      return response.data;
    }

    let headers = `From: oCode Recruiter <${recruitmentMail}>\r\nTo: ${to}\r\nSubject: ${subject}`;
    if (inReplyTo) {
      headers += `\r\nIn-Reply-To: ${inReplyTo}`;
    }
    if (references && references.length > 0) {
      headers += `\r\nReferences: ${references.join(" ")}`;
    }
    if (bccEmail) {
      headers += `\r\nBcc: ${bccEmail}`;
    }

    const emailRawMessage = Buffer.from(`${headers}\r\n\r\n${body}`)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const response = await gmailClient.users.messages.send({
      userId: "me",
      requestBody: {
        raw: emailRawMessage,
        threadId: threadId,
      },
    });
    return response.data;
  } catch (error) {
    throw error;
  }
};
export const sendTestEmail = async ({
  to,
  subject,
  body,
  inReplyTo,
  references,
  threadId,
  bccEmail = "career@browsewire.net",
  rawMessage,
}: EmailData) => {
  if (!to || !subject || !threadId) {
    throw new Error("Email data is required");
  }
  if (typeof threadId !== "string" || threadId.trim() === "") {
    throw new Error("Invalid threadId");
  }
  try {
    if (rawMessage) {
      const response = await gmailClient.users.messages.send({
        userId: "me",
        requestBody: {
          raw: rawMessage,
          threadId: threadId,
        },
      });
      return response.data;
    }

    if (!body) {
      throw new Error("Email body is required");
    }

    let signature = "";
    try {
      const sendAsResponse = await gmailClient.users.settings.sendAs.list({
        userId: "me",
      });
      const primarySendAs = sendAsResponse.data.sendAs?.find(
        (as) => as.isPrimary
      );
      signature = primarySendAs?.signature || "";
    } catch (error) {
      console.error("Error fetching signature:", error);
    }

    const containsHtml = /<[a-z][\s\S]*>/i.test(body);

    let emailBody;
    if (containsHtml) {
      emailBody = signature ? `${body}<br><br>--<br>${signature}` : body;
    } else {
      const plainSignature = signature.replace(/<[^>]*>/g, "");
      emailBody = signature ? `${body}\n\n--\n${plainSignature}` : body;
    }

    let headers = `From: oCode Recruiter <${recruitmentMail}>\r\nTo: ${to}\r\nSubject: ${subject}`;
    if (inReplyTo) {
      headers += `\r\nIn-Reply-To: ${inReplyTo}`;
    }
    if (references && references.length > 0) {
      headers += `\r\nReferences: ${references.join(" ")}`;
    }
    if (bccEmail) {
      headers += `\r\nBcc: ${bccEmail}`;
    }
    headers += `\r\nContent-Type: ${containsHtml ? "text/html" : "text/plain"}; charset="UTF-8"`;

    const emailRawMessage = Buffer.from(`${headers}\r\n\r\n${emailBody}`)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const response = await gmailClient.users.messages.send({
      userId: "me",
      requestBody: {
        raw: emailRawMessage,
        threadId: threadId,
      },
    });
    return response.data;
  } catch (error) {
    throw error;
  }
};
export const modifyEmailLabels = async ({
  emailId,
  threadId,
  addLabelIds,
  removeLabelIds,
}: {
  emailId: string;
  threadId?: string;
  addLabelIds: string[];
  removeLabelIds?: string[];
}) => {
  try {
    const existingLabels = await gmailClient.users.labels.list({
      userId: "me",
    });
    const labelMap = new Map(
      existingLabels.data.labels?.map((l) => [l.name, l.id])
    );

    const resolvedAddLabelIds = await resolveLabelIds(addLabelIds);

    const resolvedRemoveLabelIds =
      removeLabelIds &&
      removeLabelIds
        .map((name) => {
          if (["INBOX", "UNREAD", "STARRED", "IMPORTANT"].includes(name))
            return name;

          if (labelMap.has(name)) return labelMap.get(name);

          console.warn(`Label not found: ${name}`);
          return null;
        })
        .filter((id): id is string => !!id);

    const response = await gmailClient.users.messages.modify({
      userId: "me",
      id: emailId,
      requestBody: {
        addLabelIds: resolvedAddLabelIds,
        removeLabelIds: resolvedRemoveLabelIds,
      },
    });

    if (threadId) {
      await gmailClient.users.threads.modify({
        userId: "me",
        id: threadId,
        requestBody: {
          addLabelIds: resolvedAddLabelIds,
          removeLabelIds: resolvedRemoveLabelIds,
        },
      });
    }

    return response.data;
  } catch (error) {
    throw error;
  }
};

export const getThreadMessages = async (threadId: string) => {
  if (!threadId) throw new Error("threadId is required");
  try {
    const response = await gmailClient.users.threads.get({
      userId: "me",
      id: threadId,
    });
    return response.data.messages;
  } catch (error) {
    throw error;
  }
};

interface ConfirmationEmailProps {
  name: string;
  position: string;
  userEmail: string;
  subject: string | null;
  threadId: string;
  emailId: string;
  inReplyTo: string;
  references: string[];
  templateId: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export const decodeEmailBody = (
  encodedBody: gmail_v1.Schema$MessagePart | undefined
) => {
  const bodyEncoded = encodedBody?.body?.data || "";
  return Buffer.from(bodyEncoded, "base64").toString("utf8");
};

export const sendThreadReplyEmail = async ({
  name,
  position,
  userEmail,
  subject,
  threadId,
  emailId,
  inReplyTo,
  references,
  templateId,
  addLabelIds,
  removeLabelIds,
}: ConfirmationEmailProps): Promise<gmail_v1.Schema$Message> => {
  try {
    let templateMailBody = "";
    switch (templateId) {
      case "templates-rejection-missing_multiple_details":
        templateMailBody = missingMultipleDetailsTemplate;
        break;
      case "templates-rejection-no_resume":
        templateMailBody = noResumeTemplate;
        break;
      case "templates-rejection-no_cover_letter":
        templateMailBody = noCoverLetterTemplate;
        break;
      case "templates-rejection-no_clear_job_position":
        templateMailBody = noClearJobPositionTemplate;
        break;
      case "templates-request_key_details-developer-experienced":
        templateMailBody = experiencedTechTemplate;
        break;
      case "templates-request_key_details-developer-fresher":
        templateMailBody = fresherTechTemplate;
        break;
      case "templates-request_key_details-non-tech":
        templateMailBody = nonTechTemplate;
        break;
      case "templates-request_key_details-creative":
        templateMailBody = creativeTemplate;
        break;
      case "templates-request_key_details-resend_key_details":
        templateMailBody = resendKeyDetailsTemplate;
        break;
      default:
        console.error(`Template not found in switch case: ${templateId}`);
        break;
    }
    if (!templateMailBody) throw new Error(`${templateId} template not found`);

    const signatureHtml = `
    <div dir="ltr"><div dir="ltr" style="color:rgb(34,34,34)"><div><font face="georgia, serif"><span style="color:rgb(12,52,61)">Thank You</span><span style="color:rgb(12,52,61)"><font size="2">,</font></span></font></div><div><span style="color:rgb(12,52,61)"><font face="georgia, serif">Talent Recruiter</font></span> <span style="color:rgb(12,52,61)"><font face="georgia, serif">|</font></span> <span style="color:rgb(12,52,61)"><font face="georgia, serif" size="2" color="#38761d">oCode Technologies</font></span></div><div><font face="georgia, serif"><span style="color:rgb(12,52,61)">Phone: </span><span style="color:rgb(12,52,61)"><a href="tel:++918580541322">++918580541322</a></span><span style="color:rgb(12,52,61)"> | </span><span style="color:rgb(12,52,61)"><a href="tel:+919872294640">+919872294640</a></span><br></font></div><div><span style="color:rgb(12,52,61)"><a href="https://in.linkedin.com/company/ocodeco" target="_blank">LinkedIn</a></span> <span style="color:rgb(12,52,61)"><font face="georgia, serif">|</font></span> <span style="color:rgb(12,52,61)"><a href="https://www.fb.com/OcodeTech/" target="_blank">Facebook</a></span><br></div><div><font size="2" face="georgia, serif" color="#38761d">Website: <a href="http://www.ocode.co/" target="_blank">www.ocode.co</a></font></div></div>
    `;

    const signatureText = signatureHtml.replace(/<[^>]*>/g, "");

    const replyMail = templateMailBody
      .replaceAll("[Candidate Name]", name ? name : "Candidate")
      .replaceAll(
        "[Job Title]",
        position && position !== "unclear" ? position : "applied"
      )
      .replaceAll("[Company Name]", "oCode Technologies");

    const replyMailWithSignature = signatureHtml
      ? `${replyMail}\n${signatureText}`
      : replyMail;

    const htmlBody = replyMail
      .split("\n")
      .map((line) => {
        const trimmedLine = line.trim();
        if (trimmedLine === "") {
          return "<br>";
        }
        return `<p style="margin: 0 0 1em 0; font-family: Arial, sans-serif; line-height: 1.6; color: #333333;">${trimmedLine}</p>`;
      })
      .join("");

    const fullHtmlBody = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject?.includes("Re:") ? subject : `Re: ${subject}`}</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f8f9fa; color: #333333;">
  <div style="width: 100%; padding-top: 20px; padding-left: 20px; padding-right: 20px; background-color: #ffffff; box-sizing: border-box;">
    ${htmlBody}
  </div>
</body>
</html>`;

    const fullHtmlBodyWithSignature = signatureHtml
      ? `${fullHtmlBody}<div style="padding-left: 20px; padding-right: 20px"><br>${signatureHtml}</div>`
      : fullHtmlBody;

    const boundary = "boundary_" + Math.random().toString(36).substring(7);
    const recruitmentEmail = process.env.RECRUITMENT_MAIL || "hi@ocode.co";
    const senderName = process.env.RECRUITER_NAME || "oCode Recruiter";
    const bccEmail = process.env.BCC_MAIL || "career@browsewire.net";

    const emailContent = [
      `From: ${senderName} <${recruitmentEmail}>`,
      `To: ${userEmail}`,
      `Subject: ${subject?.includes("Re:") ? subject : `Re: ${subject}`}`,
      `In-Reply-To: ${inReplyTo}`,
      `References: ${references?.join(" ")}`,
      `Bcc: ${bccEmail}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: 7bit`,
      "",
      replyMailWithSignature,
      "",
      `--${boundary}`,
      `Content-Type: text/html; charset="UTF-8"`,
      `Content-Transfer-Encoding: 7bit`,
      "",
      fullHtmlBodyWithSignature,
      "",
      `--${boundary}--`,
    ].join("\r\n");

    const rawMessage = Buffer.from(emailContent)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const sendMailResp = await sendTestEmail({
      to: userEmail,
      subject: subject?.includes("Re:") ? subject : `Re: ${subject}`,
      inReplyTo: inReplyTo,
      references: references,
      threadId: threadId,
      bccEmail: bccEmail,
      rawMessage: rawMessage,
    });

    if (sendMailResp.id && sendMailResp.labelIds?.includes("SENT")) {
      await modifyEmailLabels({
        emailId: emailId,
        threadId: threadId,
        addLabelIds: addLabelIds || [],
        removeLabelIds: removeLabelIds || [],
      });
    }
    return sendMailResp;
  } catch (err) {
    console.log(err);
    return { id: "", threadId: "", labelIds: [] } as gmail_v1.Schema$Message;
  }
};
