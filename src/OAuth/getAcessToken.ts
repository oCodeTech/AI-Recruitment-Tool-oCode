import { getOAuth2Client } from './getOAuthClient';
// import { config } from 'dotenv';
// import path from 'path';

// config({ path: path.resolve(__dirname, '../../.env') });

interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

let cachedAccessToken: string | null = null;
let tokenExpiryTimestamp = 0;

export async function getAccessToken(): Promise<string> {
  const now = Date.now();

  if (cachedAccessToken && now < tokenExpiryTimestamp) {
    return cachedAccessToken;
  }

  if(!process.env.GOOGLE_REFRESH_TOKEN){
    await getOAuth2Client();
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }),
  });

  const data = (await res.json()) as AccessTokenResponse;

  if (data.error) {
    throw new Error(data.error_description || 'Failed to get access token');
  }

  // Cache token and expiry time
  cachedAccessToken = data.access_token;
  tokenExpiryTimestamp = now + data.expires_in * 1000 - 60 * 1000; // refresh 1 minute early

  return cachedAccessToken;
}
