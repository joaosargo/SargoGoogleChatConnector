import { OAuth2Client } from "google-auth-library";
import { promises as fs } from "fs";
import path from "path";

export const SCOPES = [
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.messages.reactions",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
];

export const CLIENT_SECRET_PATH =
  process.env.GOOGLE_CHAT_CLIENT_SECRET ?? path.join(process.cwd(), "client_secret.json");
export const TOKEN_PATH = process.env.GOOGLE_CHAT_TOKEN ?? path.join(process.cwd(), "token.json");

interface ClientSecretFile {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
}

async function loadClientSecret() {
  let raw: string;
  try {
    raw = await fs.readFile(CLIENT_SECRET_PATH, "utf8");
  } catch {
    throw new Error(
      `No OAuth client credentials found at ${CLIENT_SECRET_PATH}. See SETUP.md to create one in Google Cloud Console and download it there.`
    );
  }
  const parsed: ClientSecretFile = JSON.parse(raw);
  const creds = parsed.installed ?? parsed.web;
  if (!creds) throw new Error(`Could not find "installed" or "web" credentials in ${CLIENT_SECRET_PATH}`);
  return creds;
}

export async function createOAuthClient(): Promise<OAuth2Client> {
  const { client_id, client_secret } = await loadClientSecret();
  return new OAuth2Client({ clientId: client_id, clientSecret: client_secret });
}

export async function getAuthorizedClient(): Promise<OAuth2Client> {
  const client = await createOAuthClient();

  let savedToken: Record<string, unknown>;
  try {
    savedToken = JSON.parse(await fs.readFile(TOKEN_PATH, "utf8"));
  } catch {
    throw new Error(`No saved Google Chat login found at ${TOKEN_PATH}. Run "npm run login" once to authorize.`);
  }

  client.setCredentials(savedToken);
  client.on("tokens", (tokens) => {
    savedToken = { ...savedToken, ...tokens };
    fs.writeFile(TOKEN_PATH, JSON.stringify(savedToken, null, 2)).catch(() => {
      // best-effort persistence of a refreshed access token
    });
  });

  return client;
}
