import { readFile } from "fs/promises";
import path from "path";
import { getAccessToken } from "./auth.js";
import { OPTION_EMOJI, parseAnswer, formatDate, mimeTypeFor, pollUntilAnswered, type WaitOptions } from "../shared.js";

const API_BASE = "https://webexapis.com/v1";
const MAX_RATE_LIMIT_RETRIES = 3;
const ANNOUNCE_HEADER = "📣 **From Claude Code:**";
const REGISTERED_REGEX = /^✅\s*\**Registered/;
const USAGE_PREFIX = "Token spent:";

interface WebexMessage {
  id: string;
  roomId: string;
  parentId?: string;
  personId: string;
  personEmail?: string;
  text?: string;
  markdown?: string;
  created: string;
}

export interface WebexVoteOption {
  label: string;
  emoji: string;
}

export interface WebexVotePoll {
  roomId: string;
  messageId: string;
  question: string;
  options: WebexVoteOption[];
  selfPersonId: string;
  selfDisplayName: string;
}

export interface WebexVoteAnswer {
  personId: string;
  displayName: string;
  option: WebexVoteOption;
  detail: string | null;
  respondedAt: string;
  sourceMessageId: string;
}

export interface WebexVoteSyncResult {
  /** The first valid "/<n>" reply from anyone in the thread — the poll is resolved once this is non-null. */
  answer: WebexVoteAnswer | null;
  /** True if this call just recorded and confirmed the answer (false if already done on a prior call). */
  justRegistered: boolean;
}

export interface WebexVoteWaitResult extends WebexVoteSyncResult {
  timedOut: boolean;
}

async function webexRequest(
  urlOrPath: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | FormData } = {}
): Promise<Response> {
  const url = urlOrPath.startsWith("http") ? urlOrPath : `${API_BASE}${urlOrPath}`;
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken();
    const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfterSeconds = Number(res.headers.get("Retry-After") ?? "5");
      await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Webex API ${init.method ?? "GET"} ${url} failed: ${res.status} ${await res.text()}`);
    }
    return res;
  }
}

async function webexJson<T>(
  urlOrPath: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string | FormData }
): Promise<T> {
  return (await (await webexRequest(urlOrPath, init)).json()) as T;
}

function sendJson<T>(method: "POST" | "PUT", urlPath: string, body: unknown): Promise<T> {
  return webexJson<T>(urlPath, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Follows the Link: rel="next" header Webex uses for pagination. */
async function listAll<T>(urlPath: string): Promise<T[]> {
  const items: T[] = [];
  let next: string | null = urlPath;
  while (next) {
    const res = await webexRequest(next);
    const data = (await res.json()) as { items: T[] };
    items.push(...data.items);
    next = res.headers.get("Link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  return items;
}

async function getMe(): Promise<{ id: string; displayName: string }> {
  return webexJson("/people/me");
}

// Message objects only carry personId/personEmail, not a display name, so look it up (and cache it).
const displayNames = new Map<string, string>();
async function displayNameFor(personId: string, fallback: string): Promise<string> {
  const cached = displayNames.get(personId);
  if (cached) return cached;
  try {
    const person = await webexJson<{ displayName: string }>(`/people/${encodeURIComponent(personId)}`);
    displayNames.set(personId, person.displayName);
    return person.displayName;
  } catch {
    return fallback;
  }
}

function createMessage(body: { roomId: string; markdown: string; parentId?: string }): Promise<WebexMessage> {
  return sendJson("POST", "/messages", body);
}

function editMessage(messageId: string, roomId: string, markdown: string): Promise<WebexMessage> {
  return sendJson("PUT", `/messages/${encodeURIComponent(messageId)}`, { roomId, markdown });
}

async function createFileMessage(roomId: string, filePath: string, parentId?: string): Promise<WebexMessage> {
  const form = new FormData();
  form.append("roomId", roomId);
  if (parentId) form.append("parentId", parentId);
  const data = await readFile(filePath);
  form.append("files", new Blob([data], { type: mimeTypeFor(filePath) }), path.basename(filePath));
  return webexJson("/messages", { method: "POST", body: form });
}

export async function listMySpaces() {
  const rooms = await listAll<{ id: string; title: string }>("/rooms?type=group&max=1000");
  return rooms.map((r) => ({ roomId: r.id, title: r.title }));
}

export async function postTeamMessage(roomId: string, message: string): Promise<{ roomId: string; messageId: string }> {
  const created = await createMessage({ roomId, markdown: `${ANNOUNCE_HEADER}\n\n${message}` });
  return { roomId, messageId: created.id };
}

/**
 * Shares one or more files as a single bundled announcement: a caption message (if given) and
 * then one thread reply per file, since a Webex message carries at most one file.
 */
export async function postTeamFiles(
  roomId: string,
  filePaths: string[],
  message?: string
): Promise<{ roomId: string; messageId: string; fileMessageIds: string[] }> {
  if (filePaths.length === 0) throw new Error("Provide at least one file.");

  let rootId: string;
  const fileMessageIds: string[] = [];
  if (message) {
    const filesHint = filePaths.length > 1 ? `\n\n📎 **${filePaths.length} files attached below** — see thread` : "";
    rootId = (await createMessage({ roomId, markdown: `${ANNOUNCE_HEADER}\n\n${message}${filesHint}` })).id;
  } else {
    rootId = (await createFileMessage(roomId, filePaths[0])).id;
    fileMessageIds.push(rootId);
  }

  for (const filePath of message ? filePaths : filePaths.slice(1)) {
    fileMessageIds.push((await createFileMessage(roomId, filePath, rootId)).id);
  }

  return { roomId, messageId: rootId, fileMessageIds };
}

function optionsBlock(options: WebexVoteOption[]): string {
  return options.map((o) => `${o.emoji}  ${o.label}`).join("\n");
}

function buildOpenPollText(question: string, options: WebexVoteOption[]): string {
  return (
    `**Claude Code needs the team's input:**\n\n${question}\n\n${optionsBlock(options)}\n\n` +
    `_Reply in the thread with "/<number>" (e.g. "/2") — add detail after the number if useful, e.g. ` +
    `"/2 because it's simpler." Anything else here is just discussion. The first valid "/<number>" ` +
    `reply from anyone settles it._`
  );
}

function buildResolvedPollText(question: string, options: WebexVoteOption[], answer: WebexVoteAnswer): string {
  const detail = answer.detail ? ` — "${answer.detail}"` : "";
  return (
    `**Claude Code needs the team's input:**\n\n${question}\n\n${optionsBlock(options)}\n\n` +
    `✅ **Answered by ${answer.displayName} (${formatDate(answer.respondedAt)}):** ${answer.option.emoji} ` +
    `${answer.option.label}${detail}`
  );
}

export async function postTeamVote(roomId: string, question: string, optionLabels: string[]): Promise<WebexVotePoll> {
  if (optionLabels.length < 2) throw new Error("Provide at least 2 options.");
  if (optionLabels.length > OPTION_EMOJI.length) {
    throw new Error(`At most ${OPTION_EMOJI.length} options are supported.`);
  }

  const options = optionLabels.map((label, i) => ({ label, emoji: OPTION_EMOJI[i] }));
  const me = await getMe();
  const root = await createMessage({ roomId, markdown: buildOpenPollText(question, options) });

  // Open the thread with a first reply so replying is one click away.
  await createMessage({ roomId, parentId: root.id, markdown: "Discussion here:" });

  return { roomId, messageId: root.id, question, options, selfPersonId: me.id, selfDisplayName: me.displayName };
}

export async function syncTeamVote(poll: WebexVotePoll): Promise<WebexVoteSyncResult> {
  const query = `roomId=${encodeURIComponent(poll.roomId)}&parentId=${encodeURIComponent(poll.messageId)}&max=100`;
  const replies = (await listAll<WebexMessage>(`/messages?${query}`)).sort((a, b) =>
    a.created.localeCompare(b.created)
  );

  let answer: WebexVoteAnswer | null = null;
  for (const m of replies) {
    if (!m.text) continue;
    const parsed = parseAnswer(m.text, poll.options.length);
    if (!parsed) continue;
    answer = {
      personId: m.personId,
      displayName: await displayNameFor(m.personId, m.personEmail ?? "unknown"),
      option: poll.options[parsed.optionIndex - 1],
      detail: parsed.detail,
      respondedAt: m.created,
      sourceMessageId: m.id,
    };
    break; // only the first valid answer, from anyone, is tracked
  }

  if (!answer) return { answer: null, justRegistered: false };

  const alreadyConfirmed = replies.some(
    (m) => m.personId === poll.selfPersonId && REGISTERED_REGEX.test(m.markdown ?? m.text ?? "")
  );

  if (!alreadyConfirmed) {
    // Edit first, confirm last: the confirmation reply is what marks the poll as done, so if the
    // edit fails, the next sync retries both.
    await editMessage(poll.messageId, poll.roomId, buildResolvedPollText(poll.question, poll.options, answer));
    const detail = answer.detail ? ` — "${answer.detail}"` : "";
    await createMessage({
      roomId: poll.roomId,
      parentId: poll.messageId,
      markdown: `✅ **Registered** — ${answer.displayName}: ${answer.option.emoji} ${answer.option.label}${detail}`,
    });
  }

  return { answer, justRegistered: !alreadyConfirmed };
}

export function waitForTeamVote(poll: WebexVotePoll, opts: WaitOptions): Promise<WebexVoteWaitResult> {
  return pollUntilAnswered(() => syncTeamVote(poll), opts);
}

/** Appends "Token spent: <n> model: <name>" to the end of the poll message. Idempotent. */
export async function recordVoteUsage(
  poll: Pick<WebexVotePoll, "roomId" | "messageId">,
  tokensSpent: number,
  model: string
): Promise<void> {
  const current = await webexJson<WebexMessage>(`/messages/${encodeURIComponent(poll.messageId)}`);
  const currentMarkdown = current.markdown ?? current.text ?? "";
  if (currentMarkdown.includes(USAGE_PREFIX)) return;
  await editMessage(poll.messageId, poll.roomId, `${currentMarkdown}\n\n${USAGE_PREFIX} ${tokensSpent} model: ${model}`);
}
