import http from "http";
import open from "open";
import { promises as fs } from "fs";
import { createOAuthClient, SCOPES, TOKEN_PATH } from "./auth.js";

async function main() {
  const client = await createOAuthClient();

  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start local OAuth callback server");
  }
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    redirect_uri: redirectUri,
  });

  console.log("Opening your browser to sign in with your Google Chat account...");
  console.log(`If it doesn't open automatically, visit:\n${authUrl}\n`);
  await open(authUrl);

  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "", redirectUri);
      const error = url.searchParams.get("error");
      const authCode = url.searchParams.get("code");
      if (error) {
        res.end("Authorization failed. You can close this tab.");
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!authCode) {
        res.end("No authorization code received. You can close this tab.");
        return;
      }
      res.end("Signed in to Google Chat. You can close this tab and return to the terminal.");
      resolve(authCode);
    });
  });

  const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
  await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log(`Saved credentials to ${TOKEN_PATH}`);
  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
