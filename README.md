# Google Chat connector for Claude Code

An MCP server that gives Claude Code a bridge to Google Chat — turning a question it would
normally ask you alone into a quick team decision, sharing status updates, and sharing files,
all in a space your team already uses.

It authenticates as **you** via OAuth (your normal Google account), not as a registered bot, so
no Workspace admin approval is required — see [SETUP.md](SETUP.md).

## How it works

- `list_chat_spaces` — list the spaces you're in, to find a team's space ID once.
- `post_team_vote` — posts a question with 2-9 options. Each option gets a tap-to-vote
  reaction; the message also invites replies in the form `/<number>` (optionally followed by
  free-text detail) to put an answer on record. Anything else posted in the thread is just
  discussion.
- `wait_for_team_vote` — blocks until the poll resolves (or `timeoutSeconds` elapses), checking
  every `intervalSeconds` (default 5s) *inside this server process*. This is the recommended way
  to wait: a single tool call replaces "check, sleep, check again," so the caller spends no extra
  tokens or turns while it waits — the call just doesn't return until there's an answer. The
  first valid `/<number>` reply from anyone resolves the poll: it posts a confirmation reply,
  rewrites the poll message to a clean "✅ Answered by ⟨name⟩: ⟨option⟩" state, and removes your
  own seed reactions so only genuine teammate reactions remain.
- `sync_team_vote` — a single, non-blocking check of the same poll state (same resolution logic
  as `wait_for_team_vote`, but returns immediately either way). Useful for one-off checks or if
  you want to manage the polling loop yourself; otherwise prefer `wait_for_team_vote`.
- `record_vote_usage` — appends a "Token spent: ⟨n⟩ model: ⟨name⟩" line to the end of a resolved
  poll message. The connector can't measure this itself; the caller (Claude) has to report it.
- `share_team_message` — posts a one-way informational message (no voting), e.g. a status
  update.
- `share_team_file` — uploads one or more local files (`.md`, `.pdf`, images, etc.) as
  attachments, bundled as one announcement thread with a caption message plus one reply per
  file (Chat only allows multiple attachments on a single message when they're all media).

## Using it in a project

1. Do the one-time setup in [SETUP.md](SETUP.md) (OAuth credentials + login). This is shared
   across all your projects — you only do it once, here.
2. In the target project, add this server to its `.mcp.json` — see
   [examples/.mcp.json](examples/.mcp.json).
3. Paste [examples/CLAUDE.md.snippet](examples/CLAUDE.md.snippet) into that project's
   `CLAUDE.md`, filling in your team's space ID, to tell Claude when to use it instead of
   asking you directly.

## Webex connector

A second, independent MCP server in this repo (`dist/webex/index.js`) gives the same capabilities
for Webex spaces, with the same tool names, so a project can use either one, or both side by
side. It also signs in as you, through a Webex integration. Differences: no tap-to-vote reactions
(Webex's API doesn't expose them), so answers are `/<number>` thread replies only, and its tools
take a Webex `roomId` instead of a Google `spaceName`.

Setup: [SETUP.md → Webex setup](SETUP.md#webex-setup). Project wiring:
[examples/webex/.mcp.json](examples/webex/.mcp.json) and
[examples/webex/CLAUDE.md.snippet](examples/webex/CLAUDE.md.snippet).

## Status

Google Chat: tested end-to-end against a live Chat space, repeatedly: team votes (single and
multi-person), in-process `wait_for_team_vote` polling, timeout fallback to `AskUserQuestion`,
token/model usage tracking, informational announcements, and single/multi-file sharing.

Webex: tested end-to-end against a live Webex space: announcements, multi-file sharing, a team
vote resolved by a `/N` reply with detail text, token/model usage recording, and re-running
sync/usage on a resolved poll without duplicating anything.
