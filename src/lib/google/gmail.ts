import "server-only";

import { z } from "zod";
import { isEmailAddress } from "@/lib/application-email";
import { env } from "@/lib/env";

import { googleFetch } from "./account";
import { googleUrl } from "./endpoints";
import { GoogleError, isGone } from "./errors";
import { decodeHeader, htmlToText, parseAddress } from "./mime";

// The parts of the Gmail API Dossier uses (E15-2, E15-3).

const api = (path: string) => googleUrl("gmail", `/gmail/v1/users/me${path}`);

export function assertEmailSendingEnabled() {
  if (env.DOSSIER_DEMO_MODE === "on" || env.DOSSIER_EMAIL_SEND === "off") throw new GoogleError("unavailable", "Email sending is disabled on this instance.");
}

/** One POST only. A missing or malformed response is an uncertain outcome. */
export async function sendRawMail(raw: string, { threadId, expectedEmail }: { threadId?: string; expectedEmail?: string } = {}) {
  assertEmailSendingEnabled();
  return z.object({ id: z.string().min(1), threadId: z.string().min(1) }).parse(await googleFetch("send", api("/messages/send"), {
    method: "POST", body: threadId ? { raw, threadId } : { raw }, expectedEmail,
  }));
}

/** Read-only reconciliation, pinned to the account that approved this message. */
export async function findSentMessage(messageId: string, expectedEmail: string, recovery?: { token: string; attemptedAt: Date }) {
  const url = new URL(api("/messages"));
  url.searchParams.set("q", `in:sent rfc822msgid:${messageId}`);
  url.searchParams.set("maxResults", "2");
  const listed = sentList.parse(await googleFetch("read", url, { expectedEmail }));
  // Never resolve an incomplete or ambiguous identity search with a weaker search.
  if (listed.nextPageToken || listed.messages.length > 1) return null;
  if (listed.messages.length === 1) {
    const message = readMessage(await googleFetch("read", api(`/messages/${encodeURIComponent(listed.messages[0].id)}?format=full`), { expectedEmail }));
    return message.labels.includes("SENT") && message.messageId === messageId ? message : null;
  }
  // Old frozen messages cannot be retrofitted with this token. Leave them uncertain.
  if (!recovery || !z.uuid().safeParse(recovery.token).success || !Number.isFinite(recovery.attemptedAt.getTime())) return null;
  return findSentByToken(recovery, expectedEmail);
}

const sentList = z.object({ messages: z.array(z.object({ id: z.string().min(1) })).default([]), nextPageToken: z.string().optional() });

/** Gmail may rewrite Message-ID. An independent random token binds the frozen MIME
 * to this intent. Time and content alone are deliberately never sufficient. */
async function findSentByToken({ token, attemptedAt }: { token: string; attemptedAt: Date }, expectedEmail: string) {
  const start = Math.floor(attemptedAt.getTime() / 1000) - 120;
  const end = Math.ceil(attemptedAt.getTime() / 1000) + 600;
  const url = new URL(api("/messages"));
  // Numeric bounds only: no subject/address search interpolation. Epoch seconds
  // avoid Gmail's date-only PST interpretation. A bounded incomplete scan fails closed.
  url.searchParams.set("q", `in:sent after:${start} before:${end}`);
  url.searchParams.set("maxResults", "100");
  const listed = sentList.parse(await googleFetch("read", url, { expectedEmail }));
  if (listed.nextPageToken || listed.messages.length > 100) return null;
  let found: ReadMail | null = null;
  for (const { id } of listed.messages) {
    const raw = messageSchema.parse(await googleFetch("read", api(`/messages/${encodeURIComponent(id)}?format=full`), { expectedEmail }));
    const headers = raw.payload.headers ?? [];
    const values = (name: string) => headers.filter(h => h.name.toLowerCase() === name).map(h => h.value);
    const tokens = values("x-dossier-send-token");
    if (!tokens.includes(token)) continue;
    // Multiple copies, malformed headers, missing bodies or extra recipients are
    // uncertainty, even if one copy otherwise looks right. Never use a snippet.
    const date = Number(raw.internalDate);
    if (found || tokens.length !== 1 || !raw.id || !raw.threadId || !raw.labelIds.includes("SENT") ||
      !Number.isFinite(date) || date <= start * 1000 || date >= end * 1000 ||
      ["from", "to", "subject", "message-id"].some(name => values(name).length !== 1 || !values(name)[0].trim()) ||
      ["cc", "bcc"].some(name => values(name).some(value => value.trim())) ||
      !findPart(raw.payload, "text/plain")) return null;
    found = readMessage(raw);
  }
  return found;
}

const partSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    mimeType: z.string().default(""),
    filename: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z.object({ data: z.string().optional(), size: z.number().optional() }).optional(),
    parts: z.array(partSchema).optional(),
  }),
);
type GmailPart = {
  mimeType: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};

const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).default([]),
  internalDate: z.string().optional(),
  snippet: z.string().default(""),
  payload: partSchema,
});

/** A Gmail message as Dossier reads it. */
export type ReadMail = {
  id: string;
  threadId: string;
  labels: string[];
  from: string;
  to: string;
  subject: string;
  messageId: string;
  references: string;
  date: Date;
  /** The text body; from HTML when there's no text part. */
  text: string;
};

const header = (part: GmailPart, name: string) =>
  part.headers?.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/** The first part of `type`, depth first, skipping attachments. */
function findPart(part: GmailPart, type: string): GmailPart | null {
  if (part.mimeType === type && !part.filename && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, type);
    if (found) return found;
  }
  return null;
}

const decodeBody = (data: string) => Buffer.from(data, "base64url").toString("utf8");

/** A message from the API's answer. */
export function readMessage(json: unknown): ReadMail {
  const message = messageSchema.parse(json);
  const { payload } = message;
  const plain = findPart(payload, "text/plain");
  const html = plain ? null : findPart(payload, "text/html");
  const text = plain ? decodeBody(plain.body!.data!) : html ? htmlToText(decodeBody(html.body!.data!)) : message.snippet;
  const dateHeader = header(payload, "Date");
  const date = message.internalDate ? new Date(Number(message.internalDate)) : new Date(dateHeader);
  return {
    id: message.id,
    threadId: message.threadId,
    labels: message.labelIds,
    from: decodeHeader(header(payload, "From")),
    to: decodeHeader(header(payload, "To")),
    subject: decodeHeader(header(payload, "Subject")),
    messageId: header(payload, "Message-ID") || header(payload, "Message-Id"),
    references: header(payload, "References"),
    date: Number.isNaN(date.getTime()) ? new Date() : date,
    text,
  };
}

/** Resolve the original Gmail headers at review time, including for older imports
 * that stored only From. Never silently fall back after a malformed Reply-To. */
export async function replyRecipient(id: string, expectedEmail: string, expectedThreadId: string): Promise<string> {
  const message = messageSchema.parse(await googleFetch("read", api(`/messages/${encodeURIComponent(id)}?format=metadata`), { expectedEmail }));
  const unusable = () => new GoogleError("unavailable", "This email has no usable reply address. Open the original message to check how to respond.");
  if (message.id !== id || message.threadId !== expectedThreadId) throw unusable();
  const headers = message.payload.headers ?? [];
  const replies = headers.filter(h => h.name.toLowerCase() === "reply-to");
  const choices = replies.length ? replies : headers.filter(h => h.name.toLowerCase() === "from");
  if (choices.length !== 1) throw unusable();
  // Support one mailbox. Lists/groups and header injection require manual review.
  const value = decodeHeader(choices[0].value).trim();
  const parsed = parseAddress(value);
  if (/[\r\n]/.test(value) || !isEmailAddress(parsed.address) ||
    /^(?:no[._-]?reply|do[._-]?not[._-]?reply)(?:[+@])/i.test(parsed.address) ||
    parsed.address === "hit-reply@linkedin.com") throw unusable();
  const name = parsed.name.replace(/[<>,;"]/g, " ").trim();
  return name ? `${name} <${parsed.address}>` : parsed.address;
}

/** One message, or null when it was deleted after Gmail listed it. */
export async function getMessage(id: string, signal?: AbortSignal): Promise<ReadMail | null> {
  try {
    return readMessage(await googleFetch("read", api(`/messages/${encodeURIComponent(id)}?format=full`), { signal }));
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
}

/** Where the mailbox is now, to check from next time. */
export async function currentHistoryId(signal?: AbortSignal): Promise<string> {
  const profile = await googleFetch<{ historyId: string }>("read", api("/profile"), { signal });
  return profile.historyId;
}

/**
 * The ids of messages added since `historyId`, and where to carry on from.
 * Null when Gmail has forgotten that far back (it keeps about a week): then
 * the caller starts over from a search.
 */
export async function messagesSince(historyId: string, signal?: AbortSignal): Promise<{ ids: string[]; historyId: string } | null> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  let latest = historyId;
  do {
    const url = new URL(api("/history"));
    url.searchParams.set("startHistoryId", historyId);
    url.searchParams.set("historyTypes", "messageAdded");
    url.searchParams.set("maxResults", "500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    let page: { history?: { messagesAdded?: { message: { id: string } }[] }[]; nextPageToken?: string; historyId: string };
    try {
      page = await googleFetch("read", url, { signal });
    } catch (error) {
      if (error instanceof Error && "detail" in error && String((error as { detail?: string }).detail).endsWith("404")) return null;
      throw error;
    }
    for (const entry of page.history ?? []) for (const added of entry.messagesAdded ?? []) ids.add(added.message.id);
    latest = page.historyId;
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { ids: [...ids], historyId: latest };
}

/** Message ids matching a Gmail search, newest first, up to `max`. */
export async function searchMessages(query: string, { max = 100, requireComplete = false, signal }: { max?: number; requireComplete?: boolean; signal?: AbortSignal } = {}): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(api("/messages"));
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", String(Math.min(max - ids.length, 500)));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await googleFetch<{ messages?: { id: string }[]; nextPageToken?: string }>("read", url, { signal });
    ids.push(...(page.messages ?? []).map((message) => message.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < max);
  // A sync must not advance its history cursor past an incomplete initial search.
  if (pageToken && requireComplete) throw new GoogleError("unavailable", "There is too much mail for this first check. Use a shorter lookback before trying again.");
  return ids.slice(0, max);
}
