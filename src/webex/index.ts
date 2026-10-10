import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  listMySpaces,
  postTeamVote,
  syncTeamVote,
  waitForTeamVote,
  recordVoteUsage,
  postTeamMessage,
  postTeamFiles,
} from "./api.js";

const server = new McpServer({
  name: "webex-connector",
  version: "0.1.0",
});

const roomIdSchema = z.string().describe("Webex space (room) ID, from list_chat_spaces.");

server.registerTool(
  "list_chat_spaces",
  {
    title: "List Webex spaces",
    description:
      "List the Webex group spaces you are a member of, with their room IDs. Run this once to find the " +
      "room ID for the team you want to reach.",
    inputSchema: {},
  },
  async () => {
    const spaces = await listMySpaces();
    return { content: [{ type: "text", text: JSON.stringify(spaces, null, 2) }] };
  }
);

server.registerTool(
  "post_team_vote",
  {
    title: "Post a team vote to Webex",
    description:
      "Post a question with 2-9 numbered options to a Webex space, as yourself, and open a thread under it. " +
      "Anyone can answer by replying in the thread with '/<number>' (optionally followed by free-text detail, " +
      "e.g. '/2 because it's simpler'); anything else in the thread is just discussion. Webex has no API for " +
      "reactions, so there's no tap-to-vote. Returns a poll object — pass it verbatim to wait_for_team_vote, " +
      "sync_team_vote and record_vote_usage.",
    inputSchema: {
      roomId: roomIdSchema,
      question: z.string().describe("The question to ask the team."),
      options: z.array(z.string()).min(2).max(9).describe("2-9 answer options."),
    },
  },
  async ({ roomId, question, options }) => {
    const poll = await postTeamVote(roomId, question, options);
    return { content: [{ type: "text", text: JSON.stringify(poll, null, 2) }] };
  }
);

const pollSchema = z
  .object({
    roomId: z.string(),
    messageId: z.string(),
    question: z.string(),
    selfPersonId: z.string(),
    selfDisplayName: z.string(),
    options: z.array(z.object({ label: z.string(), emoji: z.string() })),
  })
  .describe("The exact poll object returned by post_team_vote.");

server.registerTool(
  "sync_team_vote",
  {
    title: "Check a Webex team vote once",
    description:
      "Single, non-blocking check of the poll's thread for the first valid '/<number>' reply from anyone " +
      "(whoever answers first settles it). On first detection, edits the poll message to show " +
      "'✅ Answered by <name>: <option>' in place of the instructions and posts a '✅ Registered' reply in " +
      "the thread. Safe to call repeatedly. Prefer wait_for_team_vote, which does this in a loop for you.",
    inputSchema: { poll: pollSchema },
  },
  async ({ poll }) => {
    const result = await syncTeamVote(poll);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "wait_for_team_vote",
  {
    title: "Wait for a Webex team vote to resolve",
    description:
      "Blocks until someone answers the poll, checking every `intervalSeconds` (default 5s) — use this " +
      "instead of calling sync_team_vote yourself in a loop. The polling happens inside this server " +
      "process, so waiting costs no extra reasoning turns or tokens on the calling side: the tool call " +
      "simply doesn't return until there's an answer or `timeoutSeconds` elapses (default 1800 = 30 min). " +
      "Returns the same shape as sync_team_vote plus `timedOut` — if `timedOut` is true, no one " +
      "answered in time, so fall back to asking the user directly. Keep `timeoutSeconds` under your MCP " +
      "client's own request-timeout if it enforces one, since this call blocks for the full duration.",
    inputSchema: {
      poll: pollSchema,
      timeoutSeconds: z
        .number()
        .int()
        .positive()
        .max(7200)
        .default(1800)
        .describe("Max seconds to wait before giving up (default 1800, max 7200)."),
      intervalSeconds: z
        .number()
        .int()
        .positive()
        .max(300)
        .default(5)
        .describe("Seconds between checks (default 5)."),
    },
  },
  async ({ poll, timeoutSeconds, intervalSeconds }, extra) => {
    const progressToken = extra._meta?.progressToken;
    const result = await waitForTeamVote(poll, {
      timeoutSeconds,
      intervalSeconds,
      signal: extra.signal,
      onTick: (elapsedSeconds) => {
        if (progressToken !== undefined) {
          extra
            .sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: elapsedSeconds, total: timeoutSeconds },
            })
            .catch(() => {});
        }
      },
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "record_vote_usage",
  {
    title: "Record token/model cost for a resolved Webex vote",
    description:
      "Append 'Token spent: <tokensSpent> model: <model>' onto the end of the main poll message. Call this " +
      "once, right after the vote resolves, using your own best count/estimate of tokens spent across " +
      "creating the poll and waiting for it, and your model name (e.g. 'Opus 5.5'). The connector can't " +
      "measure this itself. Idempotent — a second call is a no-op if already recorded.",
    inputSchema: {
      poll: z
        .object({ roomId: z.string(), messageId: z.string() })
        .describe("At minimum the roomId/messageId from the poll object returned by post_team_vote."),
      tokensSpent: z.number().describe("Total tokens spent on this question (your best count or estimate)."),
      model: z.string().describe("Model name, e.g. 'Opus 5.5'."),
    },
  },
  async ({ poll, tokensSpent, model }) => {
    await recordVoteUsage(poll, tokensSpent, model);
    return { content: [{ type: "text", text: "Recorded." }] };
  }
);

server.registerTool(
  "share_team_message",
  {
    title: "Share an informational message with a Webex space",
    description:
      "Post a one-way informational message (markdown supported) to a Webex space, as yourself — status " +
      "updates, FYIs, etc. No voting involved.",
    inputSchema: {
      roomId: roomIdSchema,
      message: z.string().describe("The message to share (markdown supported)."),
    },
  },
  async ({ roomId, message }) => {
    const result = await postTeamMessage(roomId, message);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "share_team_file",
  {
    title: "Share one or more files with a Webex space",
    description:
      "Upload one or more local files (e.g. .md write-ups, .pdf, images) to a Webex space, as yourself, " +
      "bundled as one announcement — a caption message (if provided) plus one thread reply per file, since a " +
      "Webex message carries at most one file. Webex limits files to 100MB each.",
    inputSchema: {
      roomId: roomIdSchema,
      filePaths: z.array(z.string()).min(1).describe("Absolute path(s) to the local file(s) to share."),
      message: z.string().optional().describe("Optional caption to post alongside the file(s)."),
    },
  },
  async ({ roomId, filePaths, message }) => {
    const result = await postTeamFiles(roomId, filePaths, message);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
