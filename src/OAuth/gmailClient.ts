import { google } from 'googleapis';
import { getOAuth2Client } from './getOAuthClient';

let gmailClientCache: ReturnType<typeof google.gmail> | null = null;

export async function getGmailClient() {
  if (gmailClientCache) return gmailClientCache;
  const oAuth2Client = await getOAuth2Client();

  gmailClientCache = google.gmail({ version: 'v1', auth: oAuth2Client });
  return gmailClientCache;
}
