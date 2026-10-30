import "server-only";

import { DocumentKind } from "@/generated/prisma/enums";
import { unitsSchema } from "@/lib/application-data";
import { emailAddresses, emailParts } from "@/lib/application-email";
import { resolveFileName } from "@/lib/file-name";
import { renderPdf } from "@/lib/pdf/render";
import { prisma } from "@/lib/prisma";
import { loadProfile, loadProfileName } from "@/lib/profile-data";
import { loadSettings } from "@/lib/settings-data";

import { loadGoogleAccount } from "./account";
import { GoogleError } from "./errors";
import { assertEmailSendingEnabled } from "./gmail";
import { activeSendReview, confirmIntent, digest, prepareIntent, sendReview } from "./send-intent";
import type { Attachment } from "./mime";

// Sending through Gmail (E15-2): the application's email with its PDFs, and
// answers to employers in their thread. Each send is asked for by the user;
// nothing goes out on its own.

const PRINTED = [
  { kind: DocumentKind.RESUME, path: "resume" },
  { kind: DocumentKind.COVER_LETTER, path: "letter" },
] as const;

/** "Jane Doe <jane@gmail.com>", from the profile's name and the account. */
async function sender(address: string): Promise<string> {
  const name = (await loadProfileName()).trim().replace(/[<>"]/g, "");
  return name ? `${name} <${address}>` : address;
}

export type SentApplication = { threadId: string; eventId: string | null; attachments: string[] };

/**
 * Freezes the application email and PDFs for review. Confirmation sends only
 * these saved bytes, even if the source documents are edited later.
 */
export async function prepareApplicationEmail(applicationId: string, resend = false) {
  assertEmailSendingEnabled();
  const account = await loadGoogleAccount();
  if (!account) throw new GoogleError("not-connected", "Connect your Google account in Settings → Google first.");
  const active = await activeSendReview("APPLICATION", applicationId);
  if (active && (["SENDING", "UNKNOWN"].includes(active.state) || (active.state === "SENT" && !resend))) return active;
  const before = await applicationSnapshot(applicationId);
  const application = await prisma.application.findUnique({ where: { id: applicationId }, include: { documents: true } });
  if (application?.archivedAt) throw new GoogleError("unavailable", "Restore this application before preparing its email.");
  if (!application) throw new GoogleError("unavailable", "That application no longer exists.");

  const units = unitsSchema.safeParse(application.documents.find((document) => document.kind === DocumentKind.EMAIL)?.units);
  if (!units.success) throw new GoogleError("unavailable", "Write the email first.");
  const { to, subject, body } = emailParts(units.data);
  if (emailAddresses(to).length === 0) throw new GoogleError("unavailable", "Add who it's to first: the posting doesn't give an address.");
  if (!subject.trim() || !body.trim()) throw new GoogleError("unavailable", "The email needs a subject and a message.");

  const [name, settings] = await Promise.all([loadProfileName(), loadSettings()]);
  const attachments: Attachment[] = [];
  for (const { kind, path } of PRINTED) {
    if (!application.documents.some((document) => document.kind === kind)) continue;
    attachments.push({
      fileName: resolveFileName(settings.fileNamePattern, { name, company: application.company, role: application.role, doc: kind, date: new Date() }),
      contentType: "application/pdf",
      data: await renderPdf(`/print/${path}/${applicationId}`),
    });
  }

  const from = await sender(account.email);
  if (before !== await applicationSnapshot(applicationId)) throw new GoogleError("unavailable", "The application changed while preparing its attachments. Review it again.");
  return sendReview(await prepareIntent({ kind: "APPLICATION", targetId: applicationId, applicationId, accountEmail: account.email.toLowerCase(), fingerprint: before, mail: { from, to, subject, body, attachments }, resend }));
}

async function applicationSnapshot(id: string) {
  return digest(await Promise.all([
    prisma.application.findUnique({ where: { id }, include: { documents: { orderBy: { id: "asc" } } } }),
    loadProfile(), loadSettings(), prisma.theme.findMany({ orderBy: { id: "asc" } }),
  ]));
}

/** Internal convenience for tests; browser actions require an already reviewed intent ID. */
export async function sendApplicationEmail(applicationId: string): Promise<SentApplication> {
  const review = await prepareApplicationEmail(applicationId);
  const sent = await confirmIntent(review.id);
  return { threadId: sent.threadId!, eventId: sent.eventId, attachments: review.attachments };
}

/** "Re: …", unless it already is. */
export const replySubject = (subject: string) => (/^\s*(re|aw|sv|antw)\s*:/i.test(subject) ? subject.trim() : `Re: ${subject.trim()}`);

/** Freezes an answer to an employer for review, without sending it. */
export async function prepareReply(emailId: string, body: string, resend = false) {
  assertEmailSendingEnabled();
  const account = await loadGoogleAccount();
  if (!account) throw new GoogleError("not-connected", "Connect your Google account in Settings → Google first.");
  const active = await activeSendReview("REPLY", emailId);
  if (active && (["SENDING", "UNKNOWN"].includes(active.state) || (active.state === "SENT" && !resend))) return active;
  const email = await prisma.emailMessage.findUnique({ where: { id: emailId } });
  if (!email) throw new GoogleError("unavailable", "That email is no longer in Dossier.");
  if (email.direction !== "INCOMING" || email.dismissedAt) throw new GoogleError("unavailable", "Choose an incoming email to answer.");
  if (!body.trim()) throw new GoogleError("unavailable", "Write the answer first.");
  if (/\[…\]|\[\.\.\.\]/.test(body)) throw new GoogleError("unavailable", "Fill in the parts marked […] first.");

  const to = email.fromName ? `${email.fromName.replace(/[<>"]/g, "")} <${email.fromAddress}>` : email.fromAddress;
  const subject = replySubject(email.subject);
  return sendReview(await prepareIntent({ kind: "REPLY", targetId: emailId, resend, applicationId: email.applicationId, accountEmail: account.email.toLowerCase(), fingerprint: digest({ account: account.email, to, subject, body, thread: email.threadId, messageId: email.messageId }),
    mail: { from: await sender(account.email), to, subject, body, inReplyTo: email.messageId || undefined }, threadId: email.threadId }));
}

export async function sendReply(emailId: string, body: string): Promise<{ applicationId: string | null }> {
  const review = await prepareReply(emailId, body);
  return { applicationId: (await confirmIntent(review.id)).applicationId };
}
