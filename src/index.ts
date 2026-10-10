import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getAuthorizedClient } from "./auth.js";
import {
  listMySpaces,
  postTeamVote,
  syncTeamVote,
  waitForTeamVote,
  recordVoteUsage,
  postTeamMessage,
  postTeamFiles,
} from "./chat.js";

const server = new McpServer({
  name: "google-chat-connector",
  version: "0.1.0",
});

server.registerTool(
  "list_chat_spaces",
  {
    title: "List Google Chat spaces",
    description:
      "List the Google Chat spaces (excluding 1:1 DMs) you are a member of, with their resource names " +
      "(e.g. 'spaces/AAAAxxxxxxx'). Run this once to find the space ID for the team you want to poll.",
    inputSchema: {},
  },
  async () => {
    const auth = await getAuthorizedClient();
    const spaces = await listMySpaces(auth);
    return { content: [{ type: "text", text: JSON.stringify(spaces, null, 2) }] };
  }
);

server.registerTool(
  "post_team_vote",
  {
    title: "Post a team vote to Google Chat",
    description:
      "Post a question with 2-9 options to a Google Chat space, as yourself. Each option gets a pre-added " +
      "numbered-emoji reaction for a quick tap-to-vote, and the message also tells everyone they can reply " +
      "'/<number>' (optionally followed by free-text detail, e.g. '/2 because it's simpler') to put an answer " +
      "on record — anyone in the space can do either, and anything else posted in the thread is just " +
      "discussion and is ignored. Returns a poll object — pass it verbatim to sync_team_vote and " +
      "record_vote_usage.",
    inputSchema: {
      spaceName: z.string().describe("Space resource name, e.g. 'spaces/AAAAxxxxxxx' (from list_chat_spaces)."),
      question: z.string().describe("The question to ask the team."),
      options: z.array(z.string()).min(2).max(9).describe("2-9 answer options."),
    },
  },
  async ({ spaceName, question, options }) => {
    const auth = await getAuthorizedClient();
    const poll = await postTeamVote(auth, spaceName, question, options);
    return { content: [{ type: "text", text: JSON.stringify(poll, null, 2) }] };
  }
);

const pollSchema = z
  .object({
    spaceName: z.string(),
    messageName: z.string(),
    threadName: z.string(),
    question: z.string(),
    selfUserName: z.string(),
    selfDisplayName: z.string(),
    options: z.array(z.object({ label: z.string(), emoji: z.string() })),
  })
  .describe("The exact poll object returned by post_team_vote.");

server.registerTool(
  "sync_team_vote",
  {
    title: "Sync team vote responses",
    description:
      "Scan the poll's thread for the first valid '/<number>' reply from anyone (only one response is " +
      "ever tracked — whoever answers first settles it; tap-to-vote reactions never resolve it by themselves). " +
      "On first detection, posts an in-thread '✅ Registered' confirmation, rewrites the poll message to remove " +
      "the instructions and show '✅ Answered by <name>: <option>' instead, and removes your own seed " +
      "reactions so only reactions genuinely added by others remain visible. Safe to call repeatedly (a no-op " +
      "once already resolved). Returns `answer` (null until someone has answered) — treat a non-null `answer` " +
      "as the final decision. Call this repeatedly, waiting a reasonable interval between calls (e.g. via a " +
      "shell 'sleep'), until someone answers or your timeout budget is spent.",
    inputSchema: { poll: pollSchema },
  },
  async ({ poll }) => {
    const auth = await getAuthorizedClient();
    const result = await syncTeamVote(auth, poll);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "wait_for_team_vote",
  {
    title: "Wait for a team vote to resolve",
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
    const auth = await getAuthorizedClient();
    const progressToken = extra._meta?.progressToken;
    const result = await waitForTeamVote(auth, poll, {
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
    title: "Record token/model cost for a resolved vote",
    description:
      "Append 'Token spent: <tokensSpent> model: <model>' onto the end of the main poll message (not a new " +
      "thread reply). Call this once, right after sync_team_vote first returns a non-null `answer`, using your " +
      "own best count/estimate of tokens spent across creating the poll and waiting for it to resolve, and " +
      "your model name (e.g. 'Sonnet 5'). The connector has no way to measure this itself, so the numbers are " +
      "only as accurate as what you report. Idempotent — a second call is a no-op if already recorded.",
    inputSchema: {
      poll: z
        .object({ messageName: z.string() })
        .describe("At minimum the messageName from the poll object returned by post_team_vote."),
      tokensSpent: z.number().describe("Total tokens spent on this question (your best count or estimate)."),
      model: z.string().describe("Model name, e.g. 'Sonnet 5'."),
    },
  },
  async ({ poll, tokensSpent, model }) => {
    const auth = await getAuthorizedClient();
    await recordVoteUsage(auth, poll, tokensSpent, model);
    return { content: [{ type: "text", text: "Recorded." }] };
  }
);

server.registerTool(
  "share_team_message",
  {
    title: "Share an informational message with a Google Chat space",
    description:
      "Post a plain informational message to a Google Chat space, as yourself — for sharing something with " +
      "the team that isn't a question (status updates, FYIs, etc.). No voting/decision machinery involved, " +
      "just a one-way message.",
    inputSchema: {
      spaceName: z.string().describe("Space resource name, e.g. 'spaces/AAAAxxxxxxx' (from list_chat_spaces)."),
      message: z.string().describe("The message to share."),
    },
  },
  async ({ spaceName, message }) => {
    const auth = await getAuthorizedClient();
    const result = await postTeamMessage(auth, spaceName, message);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "share_team_file",
  {
    title: "Share one or more files with a Google Chat space",
    description:
      "Upload one or more local files (e.g. .md write-ups, .txt, .pdf, images) to a Google Chat space, as " +
      "yourself, bundled as one announcement thread — a caption message (if provided) plus one reply per " +
      "file, since Chat only allows multiple attachments on a single message when they're all media " +
      "(image/video). Files up to 200MB each are supported; some file types are blocked by Chat itself " +
      "regardless of size.",
    inputSchema: {
      spaceName: z.string().describe("Space resource name, e.g. 'spaces/AAAAxxxxxxx' (from list_chat_spaces)."),
      filePaths: z.array(z.string()).min(1).describe("Absolute path(s) to the local file(s) to share."),
      message: z.string().optional().describe("Optional caption to post alongside the file(s)."),
    },
  },
  async ({ spaceName, filePaths, message }) => {
    const auth = await getAuthorizedClient();
    const result = await postTeamFiles(auth, spaceName, filePaths, message);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
