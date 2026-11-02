import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { EmailSendIntent } from "@/generated/prisma/client";
import { emailAddresses } from "@/lib/application-email";
import { prisma } from "@/lib/prisma";
import { advance } from "@/lib/status";
import { accessToken, loadGoogleAccount } from "./account";
import { GoogleError } from "./errors";
import { assertEmailSendingEnabled, findSentMessage, sendRawMail } from "./gmail";
import { buildMessage, parseAddress, toBase64Url, type OutgoingMail } from "./mime";

const attachment = z.object({ fileName: z.string(), sha256: z.string(), data: z.string() });
const payloadSchema = z.object({ raw: z.string(), from: z.string(), to: z.string(), subject: z.string(), body: z.string(), fromName: z.string(), attachments: z.array(attachment), replyThreadId: z.string().optional() });
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type SendReview = { id: string; state: string; from: string; to: string; subject: string; body: string; attachments: string[] };
const uncertain = () => new GoogleError("unavailable", "The send outcome is uncertain. Check send status before trying again. No further message will be sent.");

export function sendReview(intent: EmailSendIntent): SendReview {
  const payload = payloadSchema.parse(intent.payload);
  return { id: intent.id, state: intent.state, from: payload.from, to: payload.to, subject: payload.subject, body: payload.body, attachments: payload.attachments.map(a => a.fileName) };
}

export async function prepareIntent(input: { kind: "APPLICATION" | "REPLY"; targetId: string; applicationId: string | null; accountEmail: string; fingerprint: string; mail: OutgoingMail; threadId?: string; resend?: boolean }) {
  assertEmailSendingEnabled();
  if ([input.mail.from, input.mail.to, input.mail.subject].some(value => /[\r\n]/.test(value))) throw new GoogleError("unavailable", "The sender, recipient and subject must each fit on one line.");
  const scope = `${input.kind}:${input.targetId}`;
  // Serialize independent processes/tabs, including replacement of an unsent review.
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${scope}))::text`;
    await tx.$queryRaw`SELECT 1 FROM "EmailSendIntent" WHERE scope = ${scope} FOR UPDATE`;
    const existing = await tx.emailSendIntent.findUnique({ where: { scope } });
    if (existing) {
      if (["SENDING", "UNKNOWN"].includes(existing.state) || (existing.state === "SENT" && !input.resend) || (existing.state === "PREPARED" && existing.fingerprint === input.fingerprint && existing.accountEmail === input.accountEmail)) return existing;
      await tx.emailSendIntent.update({ where: { id: existing.id }, data: { scope: null, ...(existing.state === "PREPARED" ? { state: "CANCELLED" } : {}) } });
    }
    const messageId = `<${randomUUID()}@dossier.invalid>`;
    const raw = toBase64Url(buildMessage({ ...input.mail, messageId }));
    // Gmail's raw payload is base64url encoded; keep a conservative size bound.
    if (raw.length > 30 * 1024 * 1024) throw new GoogleError("unavailable", "The email attachments are too large. Use smaller documents before sending.");
    const payload = { raw, from: input.mail.from, fromName: parseAddress(input.mail.from).name, to: input.mail.to, subject: input.mail.subject, body: input.mail.body,
      attachments: (input.mail.attachments ?? []).map(a => ({ fileName: a.fileName, data: Buffer.from(a.data).toString("base64"), sha256: createHash("sha256").update(a.data).digest("hex") })),
      ...(input.threadId ? { replyThreadId: input.threadId } : {}) };
    return tx.emailSendIntent.create({ data: { scope, kind: input.kind, targetId: input.targetId, applicationId: input.applicationId, accountEmail: input.accountEmail, fingerprint: input.fingerprint, messageId, payload } });
  });
}

async function requireAccount(intent: EmailSendIntent) {
  const account = await loadGoogleAccount();
  if (!account || account.email.toLowerCase() !== intent.accountEmail) throw new GoogleError("not-connected", "Reconnect the account shown on this message before checking or sending it.");
}

/** One local transaction records delivery, thread, reply handling and status together. */
async function recordSent(id: string, sent: { id: string; threadId: string }, deliveredAt?: Date) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM "EmailSendIntent" WHERE id = ${id} FOR UPDATE`;
    const intent = await tx.emailSendIntent.findUniqueOrThrow({ where: { id } });
    if (intent.state === "SENT") return intent;
    const payload = payloadSchema.parse(intent.payload);
    const now = deliveredAt ?? intent.attemptedAt ?? new Date();
    let eventId: string | null = null;
    if (intent.applicationId) {
      await tx.$queryRaw`SELECT 1 FROM "Application" WHERE id = ${intent.applicationId} FOR UPDATE`;
      const app = await tx.application.findUniqueOrThrow({ where: { id: intent.applicationId } });
      if (intent.kind === "APPLICATION") {
        await tx.application.update({ where: { id: app.id }, data: { emailThreadId: sent.threadId } });
        if (app.status === "DRAFT") {
          const change = advance(app, "SENT", now);
          if (change) {
            await tx.application.update({ where: { id: app.id }, data: change.update });
            eventId = (await tx.statusEvent.create({ data: { applicationId: app.id, ...change.event } })).id;
          }
        }
      }
    }
    if (intent.kind === "REPLY") {
      // Preserve a newer draft edited in another tab while this send was in flight.
      await tx.emailMessage.updateMany({ where: { id: intent.targetId }, data: { handledAt: now } });
      await tx.emailMessage.updateMany({ where: { id: intent.targetId, replyDraft: payload.body }, data: { replyDraft: "", replyGaps: [] } });
    }
    const data = { applicationId: intent.applicationId, direction: "OUTGOING" as const, fromName: payload.fromName, fromAddress: intent.accountEmail, toAddress: payload.to, subject: payload.subject, body: payload.body, messageId: intent.messageId, threadId: sent.threadId, sentAt: now, handledAt: now };
    await tx.emailMessage.upsert({ where: { gmailId: sent.id }, create: { gmailId: sent.id, ...data }, update: data });
    return tx.emailSendIntent.update({ where: { id }, data: { state: "SENT", gmailId: sent.id, threadId: sent.threadId, eventId, sentAt: now } });
  });
}

export async function confirmIntent(id: string) {
  assertEmailSendingEnabled();
  const intent = await prisma.emailSendIntent.findUnique({ where: { id } });
  if (!intent) throw new GoogleError("unavailable", "Review the message again before sending.");
  await requireAccount(intent);
  if (intent.state === "SENT") return intent;
  if (intent.state !== "PREPARED") throw uncertain();
  if (intent.kind === "APPLICATION") {
    const source = intent.applicationId && await prisma.application.findUnique({ where: { id: intent.applicationId }, select: { archivedAt: true } });
    if (!source || source.archivedAt) throw new GoogleError("unavailable", "This application was removed or archived. Review it again before sending.");
  } else {
    const source = await prisma.emailMessage.findUnique({ where: { id: intent.targetId }, select: { dismissedAt: true, handledAt: true } });
    if (!source || source.dismissedAt || source.handledAt) throw new GoogleError("unavailable", "This email was removed or already handled. Review it again before sending.");
  }
  const payload = payloadSchema.parse(intent.payload);
  await accessToken("send", undefined, intent.accountEmail);
  // Do not perform any external write unless this durable compare-and-set wins.
  const claim = await prisma.emailSendIntent.updateMany({ where: { id, state: "PREPARED" }, data: { state: "SENDING", attemptedAt: new Date() } });
  if (!claim.count) throw uncertain();
  try {
    const sent = await sendRawMail(payload.raw, { threadId: payload.replyThreadId, expectedEmail: intent.accountEmail });
    // Persist the provider receipt first. A later ledger failure can be repaired without sending.
    await prisma.emailSendIntent.update({ where: { id }, data: { gmailId: sent.id, threadId: sent.threadId } });
    return await recordSent(id, sent);
  } catch {
    await prisma.emailSendIntent.updateMany({ where: { id, state: "SENDING" }, data: { state: "UNKNOWN" } }).catch(() => {});
    throw uncertain();
  }
}

/** Never sends. Absence from search is not evidence of non-delivery. */
export async function reconcileIntent(id: string) {
  const intent = await prisma.emailSendIntent.findUnique({ where: { id } });
  if (!intent) throw new GoogleError("unavailable", "That send record is no longer available.");
  await requireAccount(intent);
  if (intent.state === "SENT" || intent.state === "PREPARED" || intent.state === "CANCELLED") return intent;
  if (intent.gmailId && intent.threadId) return recordSent(id, { id: intent.gmailId, threadId: intent.threadId });
  const found = await findSentMessage(intent.messageId, intent.accountEmail);
  const payload = payloadSchema.parse(intent.payload);
  if (!found || parseAddress(found.from).address !== intent.accountEmail || JSON.stringify(emailAddresses(found.to).sort()) !== JSON.stringify(emailAddresses(payload.to).sort()) || found.subject !== payload.subject || found.text.replace(/\r\n/g, "\n").trim() !== payload.body.replace(/\r\n/g, "\n").trim()) throw uncertain();
  return recordSent(id, found, found.date);
}

/** Only the frozen PDF is downloaded; source documents may have changed since review. */
export async function sendAttachment(id: string, index: number) {
  const intent = await prisma.emailSendIntent.findUnique({ where: { id } });
  if (!intent) return null;
  const file = payloadSchema.parse(intent.payload).attachments[index];
  if (!file) return null;
  const pdf = Buffer.from(file.data, "base64");
  if (createHash("sha256").update(pdf).digest("hex") !== file.sha256) throw new GoogleError("unavailable", "This saved attachment could not be verified. Review the application again.");
  return { fileName: file.fileName, pdf };
}

export async function activeSendReview(kind: string, targetId: string) {
  const intent = await prisma.emailSendIntent.findUnique({ where: { scope: `${kind}:${targetId}` } });
  return intent ? sendReview(intent) : null;
}
