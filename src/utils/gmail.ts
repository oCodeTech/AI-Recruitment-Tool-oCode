import { gmail_v1 } from "googleapis";
import { getGmailClient } from "../OAuth/gmailClient";

interface EmailData {
  to: string | null;
  subject: string;
  body: string;
  threadId?: string;
}

const gmailClient = await getGmailClient();

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

    return (
      res.data.messages?.map((message) => ({
        emailId: message.id,
        threadId: message.threadId,
      })) || []
    );
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

export const sendEmail = async ({ to, subject, body, threadId }: EmailData) => {
  if (!to || !subject || !body) {
    throw new Error("Email data is required");
  }

  const rawMessage = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\n\r\n${body}`
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  try {
    const response = await gmailClient.users.messages.send({
      userId: "me",
      requestBody: { raw: rawMessage, threadId: threadId },
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
  templateId: string;
  addLabelIds: string[];
  removeLabelIds: string[];
}

const decodeEmailBody = (
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
  templateId,
  addLabelIds,
  removeLabelIds,
}: ConfirmationEmailProps) => {
  try {
    const confirmationTemplateMail = await getDraftTemplate({
      userId: "me",
      q: `is:draft label:${templateId}`,
    });

    if (!confirmationTemplateMail) {
      console.log("No template found");
      return "No template found";
    }

    const plainTextPart = confirmationTemplateMail.payload?.parts?.find(
      (p) => p.mimeType === "text/plain"
    );
    const confirmationMailTemplate = decodeEmailBody(plainTextPart);

    const replyMail = confirmationMailTemplate
      .replaceAll("[Candidate Name]", name ? name : "Candidate")
      .replaceAll(
        "[Job Title]",
        position && position !== "unclear" ? position : "applied"
      )
      .replaceAll("[Company Name]", "Ocode Technologies");

    const sendMailResp = await sendEmail({
      to: userEmail,
      subject: `Re: ${subject}`,
      body: replyMail,
      threadId: threadId,
    });

    if (sendMailResp.id && sendMailResp.labelIds?.includes("SENT")) {
      await modifyEmailLabels({
        emailId: emailId,
        threadId: threadId,
        addLabelIds,
        removeLabelIds,
      });
    }

    return sendMailResp;
  } catch (err) {
    console.log(err);
    return err;
  }
};
