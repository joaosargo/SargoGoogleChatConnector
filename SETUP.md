# Setup

This connector authenticates as **you** (your own Google account) via OAuth — no Workspace
admin approval and no bot/Chat-app registration is needed. You just need to be able to create
a personal Google Cloud project, which almost every Workspace account can do unless your org
has explicitly disabled it.

## 1. Create OAuth credentials (one-time, ~5 minutes)

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project
   (or reuse any project you already have).
2. Enable the **Google Chat API**: APIs & Services → Library → search "Google Chat API" → Enable.
3. Configure the OAuth consent screen: APIs & Services → OAuth consent screen.
   - User type: **Internal** if offered (your org account only), otherwise **External** with
     yourself added as a test user.
   - App name/support email: anything, this is only shown to you on the consent screen.
4. Create credentials: APIs & Services → Credentials → Create Credentials → OAuth client ID.
   - Application type: **Desktop app**.
   - Download the resulting JSON.
5. Save the downloaded file as `client_secret.json` in this project's root
   (`C:\projects\AIDCLconnectorGoogleChat\client_secret.json`). It's git-ignored, never commit it.

> ⚠️ If step 2 or 4 is blocked by an org policy ("API access restricted" / consent screen
> requires admin approval), your Workspace admin has locked down OAuth/API access to Chat —
> this approach won't work without their help, regardless of your own space permissions.

## 2. Configure the Chat API app (required, easy to miss)

Even though this connector calls the API as your own user (not as a bot), Google still requires
a minimal app configuration on the project before any write call (posting messages/reactions)
will work — skipping this gives a confusing "Google Chat app not found" error.

1. In Cloud Console, go to **APIs & Services → Google Chat API → Configuration** (sometimes
   under a "Manage" link).
2. Fill in **App name**, **Avatar URL**, and **Description** — any placeholder values are fine,
   this is never shown to your teammates.
3. Leave **"Enable Interactive features"** turned **off**. Turning it on requires a public HTTPS
   endpoint (for the app to receive events), which this connector doesn't need — it works purely
   by calling the API, not by receiving callbacks.
4. Save.

## 3. Build and log in

```bash
npm install
npm run build
npm run login
```

`npm run login` opens your browser, you sign in with your normal company Google account and
approve the requested scopes (post/read messages, post/read reactions, list spaces). A
`token.json` is saved locally (also git-ignored) and auto-refreshes after that — you only do
this once.

## 4. Find your team's space ID

Ask Claude (once the MCP server below is wired into a project) to call the `list_chat_spaces`
tool, or run:

```bash
node dist/index.js
```

is not directly useful standalone (it's an MCP stdio server) — easier to just let Claude call
`list_chat_spaces` once connected, and note the `spaces/AAAAxxxxxxx` ID for your team's space.

## 5. Enable this in another Claude Code project

See `examples/.mcp.json` and `examples/CLAUDE.md.snippet` in this repo. In short, add this
server to that project's `.mcp.json` and paste the CLAUDE.md snippet (with your space ID filled
in) into that project's `CLAUDE.md`.
