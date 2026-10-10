import { promises as fs } from "fs";
import path from "path";

export const WEBEX_SCOPES = [
  "spark:messages_read",
  "spark:messages_write",
  "spark:rooms_read",
  "spark:people_read",
  "spark:kms",
];

export const AUTHORIZE_URL = "https://webexapis.com/v1/authorize";
const TOKEN_URL = "https://webexapis.com/v1/access_token";

export const WEBEX_CLIENT_PATH = process.env.WEBEX_CLIENT ?? path.join(process.cwd(), "webex_client.json");
export const WEBEX_TOKEN_PATH = process.env.WEBEX_TOKEN ?? path.join(process.cwd(), "webex_token.json");

// Refresh a little before the access token's 14-day lifetime runs out.
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

export interface WebexClientConfig {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
}

interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  refresh_token_expires_at: number;
}

export async function loadClientConfig(): Promise<WebexClientConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(WEBEX_CLIENT_PATH, "utf8");
  } catch {
    throw new Error(
      `No Webex integration config found at ${WEBEX_CLIENT_PATH}. See SETUP.md (Webex section) to create one.`
    );
  }
  const config: WebexClientConfig = JSON.parse(raw);
  if (!config.client_id || !config.client_secret || !config.redirect_uri) {
    throw new Error(`${WEBEX_CLIENT_PATH} must contain client_id, client_secret and redirect_uri.`);
  }
  return config;
}

/** Calls the token endpoint (authorization_code or refresh_token grant) and persists the result. */
export async function requestToken(params: Record<string, string>): Promise<StoredToken> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`Webex token request failed: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token: string;
    refresh_token_expires_in: number;
  };
  const now = Date.now();
  const token: StoredToken = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: now + data.expires_in * 1000,
    refresh_token_expires_at: now + data.refresh_token_expires_in * 1000,
  };
  await fs.writeFile(WEBEX_TOKEN_PATH, JSON.stringify(token, null, 2));
  return token;
}

export async function getAccessToken(): Promise<string> {
  let token: StoredToken;
  try {
    token = JSON.parse(await fs.readFile(WEBEX_TOKEN_PATH, "utf8"));
  } catch {
    throw new Error(`No saved Webex login found at ${WEBEX_TOKEN_PATH}. Run "npm run login:webex" once to authorize.`);
  }

  if (Date.now() < token.expires_at - REFRESH_MARGIN_MS) return token.access_token;

  if (Date.now() >= token.refresh_token_expires_at) {
    throw new Error(`Webex login expired (unused for ~90 days). Run "npm run login:webex" again.`);
  }

  const { client_id, client_secret } = await loadClientConfig();
  const refreshed = await requestToken({
    grant_type: "refresh_token",
    client_id,
    client_secret,
    refresh_token: token.refresh_token,
  });
  return refreshed.access_token;
}
