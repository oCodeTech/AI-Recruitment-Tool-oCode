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
  body: string;
  inReplyTo?: string;
  references?: string[];
  threadId: string;
  bccEmail?: string;
}

const gmailClient = await getGmailClient("hi@ocode.co"); //use actual user email address like hi@ocode.co in real world

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

    const res = await gmailClient.users.messages.list({
      userId: "me",
      labelIds: labelIds || ["INBOX"],
      ...searchProps,
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

export const containsKeyword = ({
  text,
  keywords,
}: {
  text: string;
  keywords: string[];
}) => {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  return keywords.some((keyword) => lowerText.includes(keyword.toLowerCase()));
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
}: EmailData) => {
  if (!to || !subject || !body || !threadId) {
    throw new Error("Email data is required");
  }

  if (typeof threadId !== "string" || threadId.trim() === "") {
    throw new Error("Invalid threadId");
  }

  let headers = `To: ${to}\r\nSubject: ${subject}`;

  if (inReplyTo) {
    headers += `\r\nIn-Reply-To: ${inReplyTo}`;
  }

  if (references && references.length > 0) {
    headers += `\r\nReferences: ${references.join(" ")}`;
  }

  if (bccEmail) {
    headers += `\r\nBcc: ${bccEmail}`;
  }

  const rawMessage = Buffer.from(`${headers}\r\n\r\n${body}`)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  try {
    const response = await gmailClient.users.messages.send({
      userId: "me",
      requestBody: {
        raw: rawMessage,
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
  removeLabelIds: string[];
}) => {
  try {
    const existingLabels = await gmailClient.users.labels.list({
      userId: "me",
    });
    const labelMap = new Map(
      existingLabels.data.labels?.map((l) => [l.name, l.id])
    );

    const resolvedAddLabelIds = await resolveLabelIds(addLabelIds);

    const resolvedRemoveLabelIds = removeLabelIds
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

    const replyMail = templateMailBody
      .replaceAll("[Candidate Name]", name ? name : "Candidate")
      .replaceAll(
        "[Job Title]",
        position && position !== "unclear" ? position : "applied"
      )
      .replaceAll("[Company Name]", "oCode Technologies");
      
    const sendMailResp = await sendEmail({
      to: userEmail,
      subject: subject?.includes("Re:") ? subject : `Re: ${subject}`,
      body: replyMail,
      inReplyTo: inReplyTo,
      references: references,
      threadId: threadId,
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
