import { google } from "googleapis";
import path from "path";
import { fileURLToPath } from "url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const keyFile = path.join(dirname, "../../service-account.json");

export const getGmailClient = async (impersonatedUser: string) => {
  if (!impersonatedUser) {
    throw Error("no impersonated user found");
  }

  const authClient = new google.auth.JWT({
    keyFile,
    scopes: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.labels",
    ],
    subject: impersonatedUser,
  });

  await authClient.authorize();

  const gmail = google.gmail({ version: "v1", auth: authClient });

  return gmail;
  //   const res = await gmail.users.labels.list({ userId: "me" });

  //   console.table(
  //     res.data.labels?.map((l) => ({
  //       id: l.id,
  //       name: l.name,
  //       type: l.type,
  //       textColor: l.color?.textColor,
  //       backgroundColor: l.color?.backgroundColor,
  //     }))
  //   );
};
