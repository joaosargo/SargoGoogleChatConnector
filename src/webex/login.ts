import http from "http";
import { randomBytes } from "crypto";
import open from "open";
import { AUTHORIZE_URL, WEBEX_SCOPES, WEBEX_TOKEN_PATH, loadClientConfig, requestToken } from "./auth.js";

async function main() {
  const { client_id, client_secret, redirect_uri } = await loadClientConfig();
  const redirect = new URL(redirect_uri);
  const state = randomBytes(16).toString("hex");

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set("client_id", client_id);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirect_uri);
  authUrl.searchParams.set("scope", WEBEX_SCOPES.join(" "));
  authUrl.searchParams.set("state", state);

  // Webex requires the redirect URI to match the integration's registered one exactly, so the
  // callback server must listen on that fixed port rather than a random one.
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(Number(redirect.port), resolve));

  console.log("Opening your browser to sign in to Webex...");
  console.log(`If it doesn't open automatically, visit:\n${authUrl}\n`);
  await open(authUrl.toString());

  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "", redirect_uri);
      if (url.pathname !== redirect.pathname) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const error = url.searchParams.get("error");
      const authCode = url.searchParams.get("code");
      if (error) {
        res.end("Authorization failed. You can close this tab.");
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!authCode || url.searchParams.get("state") !== state) {
        res.end("Invalid authorization response. You can close this tab.");
        return;
      }
      res.end("Signed in to Webex. You can close this tab and return to the terminal.");
      resolve(authCode);
    });
  });

  await requestToken({ grant_type: "authorization_code", client_id, client_secret, code, redirect_uri });
  console.log(`Saved credentials to ${WEBEX_TOKEN_PATH}`);
  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
