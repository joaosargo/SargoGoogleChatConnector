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
- `sync_team_vote` — call this repeatedly (ideally from a single backgrounded polling script,
  not turn-by-turn, to avoid burning tokens on every check — see the CLAUDE.md snippet). The
  first valid `/<number>` reply from anyone resolves the poll: it posts a confirmation reply,
  rewrites the poll message to a clean "✅ Answered by ⟨name⟩: ⟨option⟩" state, and removes your
  own seed reactions so only genuine teammate reactions remain.
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

## Status

Tested end-to-end against a live Chat space, repeatedly: team votes (single and multi-person),
background polling, timeout fallback to `AskUserQuestion`, token/model usage tracking,
informational announcements, and single/multi-file sharing. Not yet wired into a project's
`.mcp.json`/`CLAUDE.md` — do that per the steps above when ready.
