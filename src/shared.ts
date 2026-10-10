import path from "path";

export const OPTION_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

const ANSWER_REGEX = /^\/(\d+)\s*([\s\S]*)$/;

/** Parses a "/<n>" or "/<n> free text" reply. Returns null if it isn't a valid answer for this poll. */
export function parseAnswer(text: string, optionCount: number): { optionIndex: number; detail: string | null } | null {
  const match = text.trim().match(ANSWER_REGEX);
  if (!match) return null;
  const optionIndex = parseInt(match[1], 10);
  if (optionIndex < 1 || optionIndex > optionCount) return null;
  return { optionIndex, detail: match[2].trim() || null };
}

export function formatDate(iso: string): string {
  return iso.slice(0, 16).replace("T", " ") + " UTC";
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

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      },
      { once: true }
    );
  });
}

export interface WaitOptions {
  timeoutSeconds: number;
  intervalSeconds: number;
  signal?: AbortSignal;
  onTick?: (elapsedSeconds: number) => void;
}

/**
 * Calls check() every intervalSeconds, inside this process, until it returns an answer or
 * timeoutSeconds elapses. Lets a single tool call stand in for a "check, sleep, check again"
 * loop on the caller's side, so the caller spends no extra turns or tokens while it waits.
 */
export async function pollUntilAnswered<R extends { answer: unknown }>(
  check: () => Promise<R>,
  opts: WaitOptions
): Promise<R & { timedOut: boolean }> {
  const deadline = Date.now() + opts.timeoutSeconds * 1000;

  while (true) {
    const result = await check();
    if (result.answer) return { ...result, timedOut: false };

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { ...result, timedOut: true };

    opts.onTick?.(opts.timeoutSeconds - Math.ceil(remainingMs / 1000));
    await sleep(Math.min(opts.intervalSeconds * 1000, remainingMs), opts.signal);
  }
}
