import { getGmailClient } from "../OAuth/gmailClient";

interface EmailData {
  to: string | null;
  subject: string;
  body: string;
  threadId?: string;
}

const gmailClient = await getGmailClient();
export const gmailSearchEmails = async (searchProps: {
  userId?: string;
  query: string;
  labelIds?: string[];
  maxResults?: number;
}) => {
  try {
    const res = await gmailClient.users.messages.list({
      userId: "me",
      labelIds: ["INBOX"],
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

export const getDraftTemplates = async (searchProps: {
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
  addLabelIds,
  removeLabelIds,
}: {
  emailId: string;
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

    const resolveLabelIds = async (labels: string[]) => {
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

    return response.data;
  } catch (error) {
    throw error;
  }
};
