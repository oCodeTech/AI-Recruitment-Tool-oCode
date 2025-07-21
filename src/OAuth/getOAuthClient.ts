import { google } from 'googleapis';
import * as readline from 'readline';

// import { config } from 'dotenv';
// import path from 'path';

// config({ path: path.resolve(__dirname, '../../../.env') });

// Simple in-memory cache and token store
let cachedOAuth2Client: any = null;
let memoryTokens: {
  access_token?: string;
  refresh_token?: string;
} = {};

export async function getOAuth2Client(): Promise<any> {
  if (cachedOAuth2Client) return cachedOAuth2Client;

  const enviroment = process.env.NODE_ENV;
  const REDIRECT_URL =
    enviroment === 'development' ? process.env.GOOGLE_REDIRECT_LOCAL_URI : process.env.GOOGLE_REDIRECT_URI;

  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URL,
  );

  const refresh_token = process.env.GOOGLE_REFRESH_TOKEN;
  try {
    // If refresh token exists, use it
    if (refresh_token) {
      oAuth2Client.setCredentials({
        refresh_token,
      });
    } else {
      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.send',
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/gmail.labels',
        ],
        prompt: 'consent',
      });

      console.log('\n🔑 Authorize this app by visiting this URL:\n', authUrl);

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const code: string = await new Promise((resolve, reject) => {
        rl.question('\n📥 Enter the code from that page here: ', (code) => {
          rl.close();
          if (code) resolve(code);
          else reject(new Error('Authorization code not provided'));
        });
      });

      const { tokens } = await oAuth2Client.getToken(code);
      oAuth2Client.setCredentials(tokens);

      memoryTokens = {
        refresh_token: tokens.refresh_token!,
        access_token: tokens.access_token!,
      };

      console.log('✅ Tokens obtained and stored in memory', memoryTokens);
    }

    // Auto-refresh event
    oAuth2Client.on('tokens', (tokens) => {
      if (tokens.access_token) {
        memoryTokens.access_token = tokens.access_token;
        console.log('🔄 Access token refreshed');
      }
      if (tokens.refresh_token) {
        memoryTokens.refresh_token = tokens.refresh_token;
        console.log('🔄 Refresh token updated');
      }
    });

    cachedOAuth2Client = oAuth2Client;
    return oAuth2Client;
  } catch (error) {
    console.error('❌ Failed to authenticate with Google OAuth2:', error);
    throw error;
  }
}

