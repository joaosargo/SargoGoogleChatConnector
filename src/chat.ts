import { chat_v1, google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { createReadStream } from "fs";
import path from "path";

const OPTION_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
const ANSWER_REGEX = /^\/(\d+)\s*([\s\S]*)$/;
const REGISTERED_PREFIX = "✅ *Registered*";

export interface TeamVoteOption {
  label: string;
  emoji: string;
}

export interface TeamVotePoll {
  spaceName: string;
  messageName: string;
  threadName: string;
  question: string;
  options: TeamVoteOption[];
  selfUserName: string;
  selfDisplayName: string;
}

export interface TeamVoteAnswer {
  userName: string;
  displayName: string;
  option: TeamVoteOption;
  detail: string | null;
  respondedAt: string;
  sourceMessageName: string;
}

export interface TeamVoteSyncResult {
  /** The first valid "Answer:<n>" reply from anyone in the thread — the poll is resolved once this is non-null. */
  answer: TeamVoteAnswer | null;
  /** True if this call just recorded and confirmed the answer (false if already done on a prior call). */
  justRegistered: boolean;
}

function chatClient(auth: OAuth2Client): chat_v1.Chat {
  return google.chat({ version: "v1", auth });
}

export async function listMySpaces(auth: OAuth2Client) {
  const chat = chatClient(auth);
  const spaces: chat_v1.Schema$Space[] = [];
  let pageToken: string | undefined;
  do {
    const res = await chat.spaces.list({
      pageSize: 100,
      pageToken,
      filter: 'spaceType = "SPACE"',
    });
    spaces.push(...(res.data.spaces ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return spaces.map((s) => ({ name: s.name, displayName: s.displayName, type: s.spaceType }));
}

/**
 * Posts a plain informational message to a space, as yourself — for sharing something with the
 * team that isn't a question (e.g. a status update), no vote/decision machinery involved.
 */
export async function postTeamMessage(
  auth: OAuth2Client,
  spaceName: string,
  message: string
): Promise<{ spaceName: string; messageName: string }> {
  const chat = chatClient(auth);
  const text = `📣 *From Claude Code:*\n\n${message}`;
  const created = await chat.spaces.messages.create({
    parent: spaceName,
    requestBody: { text },
  });
  const messageName = created.data.name;
  if (!messageName) throw new Error("Chat API did not return a message name.");
  return { spaceName, messageName };
}

const MIME_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function uploadAttachment(
  chat: chat_v1.Chat,
  spaceName: string,
  filePath: string
): Promise<chat_v1.Schema$Attachment> {
  const uploaded = await chat.media.upload({
    parent: spaceName,
    requestBody: { filename: path.basename(filePath) },
    media: { mimeType: mimeTypeFor(filePath), body: createReadStream(filePath) },
  });
  const attachmentDataRef = uploaded.data.attachmentDataRef;
  if (!attachmentDataRef) throw new Error(`Chat API did not return an attachment reference for ${filePath}.`);
  return { attachmentDataRef };
}

/**
 * Shares one or more local files with a space, as yourself, as a single bundled announcement.
 * The Chat API only allows multiple attachments on one message when they're all media (image/
 * video) — mixed document types like .md/.pdf get one attachment per message — so this posts a
 * caption message (if given) and then one reply per file in the same thread, giving a single
 * grouped conversation rather than a scatter of unrelated messages.
 */
export async function postTeamFiles(
  auth: OAuth2Client,
  spaceName: string,
  filePaths: string[],
  message?: string
): Promise<{ spaceName: string; messageName: string; threadName: string; fileMessageNames: string[] }> {
  if (filePaths.length === 0) throw new Error("Provide at least one file.");
  const chat = chatClient(auth);

  let messageName: string;
  let threadName: string;

  if (message) {
    const filesHint = filePaths.length > 1 ? `\n\n📎 *${filePaths.length} files attached below* — see thread` : "";
    const captionText = `📣 *From Claude Code:*\n\n${message}${filesHint}`;
    const created = await chat.spaces.messages.create({ parent: spaceName, requestBody: { text: captionText } });
    if (!created.data.name || !created.data.thread?.name) {
      throw new Error("Chat API did not return a message/thread name.");
    }
    messageName = created.data.name;
    threadName = created.data.thread.name;
  } else {
    const attachment = await uploadAttachment(chat, spaceName, filePaths[0]);
    const created = await chat.spaces.messages.create({
      parent: spaceName,
      requestBody: { attachment: [attachment] },
    });
    if (!created.data.name || !created.data.thread?.name) {
      throw new Error("Chat API did not return a message/thread name.");
    }
    messageName = created.data.name;
    threadName = created.data.thread.name;
  }

  const remainingFiles = message ? filePaths : filePaths.slice(1);
  const fileMessageNames: string[] = message ? [] : [messageName];
  for (const filePath of remainingFiles) {
    const attachment = await uploadAttachment(chat, spaceName, filePath);
    const created = await chat.spaces.messages.create({
      parent: spaceName,
      messageReplyOption: "REPLY_MESSAGE_OR_FAIL",
      requestBody: { attachment: [attachment], thread: { name: threadName } },
    });
    if (!created.data.name) throw new Error(`Chat API did not return a message name for ${filePath}.`);
    fileMessageNames.push(created.data.name);
  }

  return { spaceName, messageName, threadName, fileMessageNames };
}

function formatDate(iso: string): string {
  return iso.slice(0, 16).replace("T", " ") + " UTC";
}

function optionsBlock(options: TeamVoteOption[]): string {
  return options.map((o) => `${o.emoji}  ${o.label}`).join("\n");
}

function buildOpenPollText(question: string, options: TeamVoteOption[]): string {
  return (
    `*Claude Code needs the team's input:*\n\n${question}\n\n${optionsBlock(options)}\n\n` +
    `_Tap a reaction for a quick vote, or reply "/<number>" (e.g. "/2") if you want it on record — add ` +
    `detail after the number if useful, e.g. "/2 because it's simpler." Anything else here is just ` +
    `discussion. The first valid "/<number>" reply from anyone settles it._`
  );
}

function buildResolvedPollText(question: string, options: TeamVoteOption[], answer: TeamVoteAnswer): string {
  const detail = answer.detail ? ` — "${answer.detail}"` : "";
  return (
    `*Claude Code needs the team's input:*\n\n${question}\n\n${optionsBlock(options)}\n\n` +
    `✅ *Answered by ${answer.displayName} (${formatDate(answer.respondedAt)}):* ${answer.option.emoji} ` +
    `${answer.option.label}${detail}`
  );
}

function shortRef(messageName: string): string {
  return messageName.split("/messages/")[1] ?? messageName;
}

export async function postTeamVote(
  auth: OAuth2Client,
  spaceName: string,
  question: string,
  optionLabels: string[]
): Promise<TeamVotePoll> {
  if (optionLabels.length < 2) throw new Error("Provide at least 2 options.");
  if (optionLabels.length > OPTION_EMOJI.length) {
    throw new Error(`At most ${OPTION_EMOJI.length} options are supported.`);
  }

  const chat = chatClient(auth);
  const options: TeamVoteOption[] = optionLabels.map((label, i) => ({ label, emoji: OPTION_EMOJI[i] }));
  const text = buildOpenPollText(question, options);

  const created = await chat.spaces.messages.create({
    parent: spaceName,
    requestBody: { text },
  });
  const messageName = created.data.name;
  const threadName = created.data.thread?.name;
  if (!messageName || !threadName) throw new Error("Chat API did not return a message/thread name.");
  const selfUserName = created.data.sender?.name ?? "";
  const selfDisplayName = created.data.sender?.displayName ?? "the poll creator";

  // Pre-seed a reaction per option as a tap-to-vote placeholder, for anyone who'd rather tap
  // than type "Answer:<n>". These are removed again once the poll resolves (see syncTeamVote),
  // leaving only reactions genuinely added by other people.
  for (const option of options) {
    await chat.spaces.messages.reactions.create({
      parent: messageName,
      requestBody: { emoji: { unicode: option.emoji } },
    });
  }

  // Open the thread with a first reply so replying is one click away instead of requiring
  // people to expand an empty thread first.
  await chat.spaces.messages.create({
    parent: spaceName,
    messageReplyOption: "REPLY_MESSAGE_OR_FAIL",
    requestBody: { text: "Discussion here:", thread: { name: threadName } },
  });

  return { spaceName, messageName, threadName, question, options, selfUserName, selfDisplayName };
}

async function listThreadReplies(
  chat: chat_v1.Chat,
  poll: Pick<TeamVotePoll, "spaceName" | "messageName" | "threadName">
): Promise<chat_v1.Schema$Message[]> {
  const messages: chat_v1.Schema$Message[] = [];
  let pageToken: string | undefined;
  do {
    const res = await chat.spaces.messages.list({
      parent: poll.spaceName,
      filter: `thread.name = "${poll.threadName}"`,
      pageToken,
    });
    messages.push(...(res.data.messages ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return messages
    .filter((m) => m.name !== poll.messageName)
    .sort((a, b) => (a.createTime ?? "").localeCompare(b.createTime ?? ""));
}

export async function syncTeamVote(
  auth: OAuth2Client,
  poll: Pick<
    TeamVotePoll,
    "spaceName" | "messageName" | "threadName" | "question" | "options" | "selfUserName" | "selfDisplayName"
  >
): Promise<TeamVoteSyncResult> {
  const chat = chatClient(auth);
  const replies = await listThreadReplies(chat, poll);

  let answer: TeamVoteAnswer | null = null;
  for (const m of replies) {
    if (!m.text || !m.sender?.name || !m.name) continue;
    const match = m.text.trim().match(ANSWER_REGEX);
    if (!match) continue;
    const optionIndex = parseInt(match[1], 10);
    if (optionIndex < 1 || optionIndex > poll.options.length) continue;

    answer = {
      userName: m.sender.name,
      displayName: m.sender.displayName ?? m.sender.name,
      option: poll.options[optionIndex - 1],
      detail: match[2].trim() || null,
      respondedAt: m.createTime ?? new Date().toISOString(),
      sourceMessageName: m.name,
    };
    break; // only the first valid answer, from anyone, is tracked
  }

  if (!answer) {
    return { answer: null, justRegistered: false };
  }

  const ref = shortRef(answer.sourceMessageName);
  const alreadyConfirmed = replies.some(
    (m) =>
      m.sender?.name === poll.selfUserName && m.text?.startsWith(REGISTERED_PREFIX) && m.text.includes(`(ref:${ref})`)
  );

  if (!alreadyConfirmed) {
    const detailSuffix = answer.detail ? ` — "${answer.detail}"` : "";
    const confirmationText =
      `${REGISTERED_PREFIX} — ${answer.displayName}: ${answer.option.emoji} ${answer.option.label}` +
      `${detailSuffix} _(ref:${ref})_`;
    await chat.spaces.messages.create({
      parent: poll.spaceName,
      messageReplyOption: "REPLY_MESSAGE_OR_FAIL",
      requestBody: { text: confirmationText, thread: { name: poll.threadName } },
    });

    const resolvedText = buildResolvedPollText(poll.question, poll.options, answer);
    await chat.spaces.messages.patch({
      name: poll.messageName,
      updateMask: "text",
      requestBody: { text: resolvedText },
    });

    const reactionsRes = await chat.spaces.messages.reactions.list({ parent: poll.messageName, pageSize: 100 });
    const ownSeedReactions = (reactionsRes.data.reactions ?? []).filter(
      (r) => r.user?.name === poll.selfUserName && poll.options.some((o) => o.emoji === r.emoji?.unicode)
    );
    for (const r of ownSeedReactions) {
      if (r.name) await chat.spaces.messages.reactions.delete({ name: r.name });
    }
  }

  return { answer, justRegistered: !alreadyConfirmed };
}

const USAGE_PREFIX = "Token spent:";

/**
 * Appends a "Token spent: <n> model: <name>" line onto the end of the main poll message. The
 * connector has no way to measure this itself — only the calling Claude session knows its own
 * token usage — so tokensSpent/model must be supplied by the caller (typically right after
 * sync_team_vote first returns a non-null answer). Idempotent: a second call is a no-op if the
 * message already has a usage line.
 */
export async function recordVoteUsage(
  auth: OAuth2Client,
  poll: Pick<TeamVotePoll, "messageName">,
  tokensSpent: number,
  model: string
): Promise<void> {
  const chat = chatClient(auth);
  const current = await chat.spaces.messages.get({ name: poll.messageName });
  const currentText = current.data.text ?? "";
  if (currentText.includes(USAGE_PREFIX)) return;

  const newText = `${currentText}\n\n${USAGE_PREFIX} ${tokensSpent} model: ${model}`;
  await chat.spaces.messages.patch({
    name: poll.messageName,
    updateMask: "text",
    requestBody: { text: newText },
  });
}
