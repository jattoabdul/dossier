import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockProvider } from "@/lib/ai/providers/mock";
import { createTestClient, resetDatabase } from "@/test/db";

// The inbox check and Send with Gmail (E15-2, E15-3) against a test
// database, with Google's APIs answered by a fake fetch.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({
  env: { DOSSIER_SECRET: "s".repeat(40), DOSSIER_GOOGLE_CLIENT_ID: "client", DOSSIER_GOOGLE_CLIENT_SECRET: "secret", DOSSIER_DATA_DIR: "/tmp" },
}));
const provider = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@/lib/ai", () => ({ getAiProvider: async () => provider.current }));
vi.mock("@/lib/ai/config", () => ({ isAiUsable: async () => provider.current !== null }));
vi.mock("@/lib/ai/task-options", () => ({ loadTaskOptions: async () => ({ creativity: "BALANCED", strict: true, language: null }) }));
vi.mock("@/lib/pdf/render", () => ({ renderPdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])) }));
vi.mock("@/lib/time-zone", () => ({ userTimeZone: async () => "Europe/Berlin", lastKnownTimeZone: async () => "Europe/Berlin" }));

import { encryptSecret, GOOGLE_TOKEN } from "@/lib/secrets";

import { env } from "@/lib/env";
import { renderPdf } from "@/lib/pdf/render";
import { prepareApplicationEmail, prepareReply, sendApplicationEmail, sendReply } from "./send";
import { guardEmailSendHistory } from "./send-guard";
import { activeSendReview, confirmIntent, reconcileIntent, sendAttachment } from "./send-intent";
import { syncInbox } from "./sync";

const prisma = () => db.client!;
const b64 = (text: string) => Buffer.from(text).toString("base64url");

/** `history`: when Gmail added it; before the mailbox's 200 unless given. `deleted`: listed, but gone when fetched. */
type Mail = { id: string; threadId: string; from: string; subject: string; text: string; labels?: string[]; date?: string; history?: number; deleted?: boolean };
const gmailMessage = ({ id, threadId, from, subject, text, labels = ["INBOX"], date = "2026-10-17T13:02:00Z" }: Mail) => ({
  id,
  threadId,
  labelIds: labels,
  internalDate: String(new Date(date).getTime()),
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: from },
      { name: "To", value: "jane@gmail.com" },
      { name: "Subject", value: subject },
      { name: "Message-ID", value: `<${id}@mail.example>` },
    ],
    parts: [{ mimeType: "text/plain", body: { data: b64(text) } }],
  },
});

let mailbox: Mail[] = [];
let sent: { raw: string; threadId?: string }[] = [];

function fakeGoogle(url: string, init?: RequestInit): Response {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const path = new URL(url).pathname;
  if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "access", expires_in: 3600, scope: "" });
  if (path.endsWith("/profile")) return json({ historyId: "200" });
  if (path.endsWith("/messages") && (init?.method ?? "GET") === "GET") return json({ messages: mailbox.map((mail) => ({ id: mail.id })) });
  if (path.endsWith("/history")) {
    const start = Number(new URL(url).searchParams.get("startHistoryId"));
    const added = mailbox.filter((mail) => (mail.history ?? 150) > start);
    return json({ history: [{ messagesAdded: added.map((mail) => ({ message: { id: mail.id } })) }], historyId: "300" });
  }
  if (path.endsWith("/messages/send")) {
    const body = JSON.parse(String(init?.body)) as { raw: string; threadId?: string };
    sent.push(body);
    return json({ id: `sent-${sent.length}`, threadId: body.threadId ?? "thread-new" });
  }
  const id = /messages\/([^/?]+)/.exec(path)?.[1];
  const mail = mailbox.find((entry) => entry.id === id);
  if (mail && !mail.deleted) return json(gmailMessage(mail));
  return new Response("not found", { status: 404 });
}

const scopes = "openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly";

beforeEach(async () => {
  Object.assign(env, { DOSSIER_EMAIL_SEND: "on", DOSSIER_DEMO_MODE: undefined });
  vi.mocked(renderPdf).mockImplementation(async () => new Uint8Array([37, 80, 68, 70]));
  await resetDatabase(prisma());
  mailbox = [];
  sent = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => fakeGoogle(String(url), init)));
  await prisma().googleAccount.create({ data: { email: "jane@gmail.com", refreshTokenEnc: encryptSecret(GOOGLE_TOKEN, "refresh", "s".repeat(40)), scopes } });
  await prisma().profileField.create({ data: { key: "name", value: "Jane Doe" } });
  await prisma().application.create({
    data: {
      id: "nw",
      company: "Northwind Logistics",
      role: "Product Designer",
      status: "DRAFT",
      postingText: "Apply to careers@northwind.example.",
      documents: {
        create: [
          { kind: "EMAIL", units: [{ id: "to", label: "Recipient", text: "careers@northwind.example" }, { id: "subject", label: "Subject", text: "Application: Product Designer" }, { id: "body", label: "Message", text: "Dear team,\n\nI'm applying.\n\nJane" }] },
          { kind: "RESUME", units: [] },
        ],
      },
    },
  });
  provider.current = new MockProvider({
    reply: () => ({ kind: "INTERVIEW", summary: "Invites you to a call.", questions: ["What is your notice period?"], confirmedTime: null }),
  });
});

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => prisma().$disconnect());

describe("Send with Gmail (E15-2)", () => {
  it("does not send twice for concurrent confirmations of the same application", async () => {
    await Promise.allSettled([sendApplicationEmail("nw"), sendApplicationEmail("nw")]);
    expect(sent).toHaveLength(1);
  });

  it("does not repeat a send after Google accepts it but its response is lost", async () => {
    const original = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const result = await original(url, init);
      if (String(url).endsWith("/messages/send")) throw new Error("connection lost after acceptance");
      return result;
    }));
    await expect(sendApplicationEmail("nw")).rejects.toThrow();
    await sendApplicationEmail("nw").catch(() => {});
    expect(sent).toHaveLength(1);
  });

  it("sends with the PDFs, keeps the thread and moves the draft to Sent", async () => {
    const result = await sendApplicationEmail("nw");
    expect(result.eventId).not.toBeNull();
    expect(result.attachments).toHaveLength(1);
    const raw = Buffer.from(sent[0].raw, "base64url").toString("utf8");
    expect(raw).toContain("From: Jane Doe <jane@gmail.com>");
    expect(raw).toContain("To: careers@northwind.example");
    expect(raw).toContain("application/pdf");
    const application = await prisma().application.findUniqueOrThrow({ where: { id: "nw" } });
    expect(application).toMatchObject({ status: "SENT", emailThreadId: "thread-new" });
    expect(await prisma().emailMessage.count({ where: { applicationId: "nw", direction: "OUTGOING" } })).toBe(1);
  });
});

describe("the inbox check (E15-3)", () => {
  it("links replies in a known thread or from the company's domain, and has the AI read them", async () => {
    await sendApplicationEmail("nw");
    mailbox = [
      { id: "m1", threadId: "thread-new", from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "Could we talk next week?\n\nOn Mon, Jane wrote:\n> I'm applying" },
      { id: "m2", threadId: "t2", from: "HR <hr@northwind.example>", subject: "Your application", text: "Thanks!" },
      { id: "m3", threadId: "t3", from: "Friend <friend@gmail.com>", subject: "Lunch?", text: "Tomorrow?" },
      { id: "m4", threadId: "t4", from: "Deals <deals@shop.example>", subject: "Sale", text: "50% off", labels: ["INBOX", "CATEGORY_PROMOTIONS"] },
    ];
    const result = await syncInbox();
    expect(result).toEqual({ fetched: 4, kept: 2, read: 2 });

    const kept = await prisma().emailMessage.findMany({ where: { direction: "INCOMING" }, orderBy: { gmailId: "asc" } });
    expect(kept.map((email) => [email.gmailId, email.applicationId, email.kind, email.suggestedStatus])).toEqual([
      ["m1", "nw", "INTERVIEW", "INTERVIEW"],
      ["m2", "nw", "INTERVIEW", "INTERVIEW"],
    ]);
    expect(kept[0].body).toBe("Could we talk next week?");
    expect(kept[0].questions).toEqual(["What is your notice period?"]);
    const account = await prisma().googleAccount.findUniqueOrThrow({ where: { id: "google" } });
    expect(account).toMatchObject({ historyId: "200", syncProblem: null });

    // The next check carries on from the history: only what's new since.
    mailbox.push({ id: "m6", threadId: "thread-new", from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "Wednesday 14:00 works.", history: 250 });
    expect(await syncInbox()).toEqual({ fetched: 1, kept: 1, read: 1 });
    expect((await prisma().googleAccount.findUniqueOrThrow({ where: { id: "google" } })).historyId).toBe("300");
  });

  it("skips mail deleted since Gmail listed it, and carries on from the history", async () => {
    await sendApplicationEmail("nw");
    await syncInbox();
    mailbox = [
      { id: "spam", threadId: "t8", from: "Spam <win@prize.example>", subject: "You won", text: "Click", labels: ["SPAM"], history: 250, deleted: true },
      { id: "m7", threadId: "thread-new", from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "Thursday?", history: 250 },
    ];
    expect(await syncInbox()).toEqual({ fetched: 2, kept: 1, read: 1 });
    expect(await prisma().googleAccount.findUniqueOrThrow({ where: { id: "google" } })).toMatchObject({ historyId: "300", syncProblem: null });
  });

  it("keeps unmatched inbox mail for a look when set to read everything", async () => {
    await prisma().setting.create({ data: { key: "gmailScope", value: "all" } });
    mailbox = [{ id: "m5", threadId: "t5", from: "Recruiter <talent@acme-hr.example>", subject: "Senior Designer role", text: "Interested?" }];
    await syncInbox();
    expect(await prisma().emailMessage.findFirst({ where: { gmailId: "m5" } })).toMatchObject({ applicationId: null });
  });

  it("keeps ambiguous employer mail unassigned in known-only scope without claiming its thread", async () => {
    provider.current = null;
    await prisma().application.update({ where: { id: "nw" }, data: { company: "Northwind", status: "SENT" } });
    await prisma().application.create({ data: { id: "nw-other", company: "Northwind", status: "REJECTED", postingText: "jobs@northwind.example" } });
    mailbox = [
      { id: "ambiguous-first", threadId: "ambiguous", from: "HR <hr@northwind.example>", subject: "Application update", text: "A decision about a role." },
      { id: "ambiguous-second", threadId: "ambiguous", from: "HR <hr@northwind.example>", subject: "Re: Application update", text: "More context." },
    ];
    expect(await syncInbox()).toEqual({ fetched: 2, kept: 2, read: 0 });
    const kept = await prisma().emailMessage.findMany({ where: { threadId: "ambiguous" } });
    expect(kept).toHaveLength(2);
    expect(kept.every((email) => email.applicationId === null && email.suggestedStatus === null)).toBe(true);
    expect(await syncInbox()).toEqual({ fetched: 0, kept: 0, read: 0 });
    expect(await prisma().emailMessage.count({ where: { threadId: "ambiguous" } })).toBe(2);
  });

  it("narrows the first known-app lookup and skips classification without a usable model", async () => {
    provider.current = null;
    mailbox = [{ id: "domain", threadId: "domain-thread", from: "HR <hr@northwind.example>", subject: "Your application", text: "Thanks!" }];
    expect(await syncInbox({ backfillDays: 60 })).toEqual({ fetched: 1, kept: 1, read: 0 });
    const calls = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)));
    expect(calls.find((url) => url.pathname.endsWith("/messages"))?.searchParams.get("q")).toBe('newer_than:60d -in:chats -category:promotions -category:social {from:"northwind.example"}');
    expect(await prisma().emailMessage.findFirst({ where: { gmailId: "domain" } })).toMatchObject({ applicationId: "nw", classifiedWith: null });
  });

  it("does not persist account codes, job alerts, or unrelated company-word matches", async () => {
    await prisma().application.update({ where: { id: "nw" }, data: { company: "Signal", status: "SCREENING", postingText: "Contact hr@signal.example" } });
    mailbox = [
      { id: "code", threadId: "code-thread", from: "Signal <hr@signal.example>", subject: "Candidate Portal Access Code", text: "A private code" },
      { id: "alert", threadId: "alert-thread", from: "LinkedIn <jobalerts-noreply@linkedin.com>", subject: "Engineer at Signal", text: "Job digest" },
      { id: "news", threadId: "news-thread", from: "News <newsletter@substack.com>", subject: "A weak signal", text: "Newsletter" },
      { id: "recruiter", threadId: "recruiter-thread", from: "Talent <hr@signal.example>", subject: "Your application", text: "Thank you" },
    ];
    expect(await syncInbox()).toEqual({ fetched: 4, kept: 1, read: 1 });
    expect((await prisma().emailMessage.findMany()).map((mail) => mail.gmailId)).toEqual(["recruiter"]);
  });

  it("keeps the old cursor on a failed backfill, then retries without duplicates", async () => {
    await prisma().googleAccount.update({ where: { id: "google" }, data: { historyId: "100" } });
    const original = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => String(url).includes("/messages?") ? new Response("failed", { status: 503 }) : original(url, init)));
    await expect(syncInbox({ backfillDays: 60 })).rejects.toThrow();
    expect(await prisma().googleAccount.findUnique({ where: { id: "google" } })).toMatchObject({ historyId: "100", lastSyncAt: null });
    vi.stubGlobal("fetch", original);
    mailbox = [{ id: "retry", threadId: "retry-thread", from: "HR <hr@northwind.example>", subject: "Your application", text: "Thanks!" }];
    await syncInbox({ backfillDays: 60 });
    await syncInbox({ backfillDays: 60 });
    expect(await prisma().emailMessage.count()).toBe(1);
    expect(await prisma().googleAccount.findUnique({ where: { id: "google" } })).toMatchObject({ historyId: "200", syncProblem: null });
  });

  it("answers in the thread and marks the reply as answered", async () => {
    await sendApplicationEmail("nw");
    mailbox = [{ id: "m1", threadId: "thread-new", from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "Notice period?" }];
    await syncInbox();
    const reply = await prisma().emailMessage.findFirstOrThrow({ where: { gmailId: "m1" } });

    await expect(sendReply(reply.id, "Hi Anna, it's […].")).rejects.toThrow("Fill in the parts marked […] first.");
    await sendReply(reply.id, "Hi Anna,\n\nThree months.\n\nJane");
    const raw = Buffer.from(sent.at(-1)!.raw, "base64url").toString("utf8");
    expect(sent.at(-1)!.threadId).toBe("thread-new");
    expect(raw).toContain("Subject: Re: Application");
    expect(raw).toContain("In-Reply-To: <m1@mail.example>");
    expect(await prisma().emailMessage.findUniqueOrThrow({ where: { id: reply.id } })).toMatchObject({ handledAt: expect.any(Date) });
  });
});

/** Model Gmail Sent search from exactly the raw MIME accepted by the fake. */
function searchableSent({ loseResponse = false, mismatch = false, ambiguous = false, unavailable = false } = {}) {
  const original = fetch;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/messages") && u.searchParams.get("q")?.includes("rfc822msgid:")) {
      if (unavailable) return new Response("unavailable", { status: 503 });
      return Response.json({ messages: sent.map((_, i) => ({ id: `sent-${i + 1}` })), ...(ambiguous ? { nextPageToken: "next" } : {}) });
    }
    if (/messages\/sent-\d+$/.test(u.pathname)) {
      const index = Number(u.pathname.split("-").at(-1)) - 1;
      const raw = Buffer.from(sent[index].raw, "base64url").toString("utf8");
      const header = (name: string) => new RegExp(`^${name}: (.+)`, "m").exec(raw)?.[1].trim() ?? "";
      const body = /Content-Type: text\/plain[^]*?Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(raw)?.[1] ?? "";
      return Response.json({ id: `sent-${index + 1}`, threadId: sent[index].threadId ?? "thread-new", labelIds: ["SENT"],
        payload: { mimeType: "text/plain", headers: ["From", "To", "Subject", "Message-ID"].map(name => ({ name, value: mismatch && name === "To" ? "someone-else@example.com" : header(name) })), body: { data: Buffer.from(body, "base64").toString("base64url") } } });
    }
    const result = await original(url, init);
    if (loseResponse && u.pathname.endsWith("/messages/send")) throw new Error("lost response");
    return result;
  }));
}

async function incomingReply() {
  return prisma().emailMessage.create({ data: { gmailId: "incoming", threadId: "reply-thread", applicationId: "nw", direction: "INCOMING", fromAddress: "recruiter@northwind.example", fromName: "Anna", toAddress: "jane@gmail.com", subject: "Interview", body: "Are you free?", messageId: "<incoming@northwind.example>", sentAt: new Date(), replyDraft: "Yes, Tuesday works." } });
}

describe("durable, reviewed Gmail sends", () => {
  it("prepares without sending and confirms only the frozen text and PDFs", async () => {
    const review = await prepareApplicationEmail("nw");
    expect(sent).toHaveLength(0);
    expect(review.state).toBe("PREPARED");
    expect(review).not.toHaveProperty("raw");
    const pdf = await sendAttachment(review.id, 0);
    expect(pdf?.pdf.toString()).toBe("%PDF");
    await prisma().document.updateMany({ where: { applicationId: "nw", kind: "EMAIL" }, data: { units: [] } });
    await prisma().profileField.update({ where: { key: "name" }, data: { value: "Changed name" } });
    await confirmIntent(review.id);
    const raw = Buffer.from(sent[0].raw, "base64url").toString();
    expect(raw).toContain("From: Jane Doe <jane@gmail.com>");
    expect(raw).toContain("To: careers@northwind.example");
    expect(raw).toContain("Message-ID: <");
    expect((await prisma().emailMessage.findFirstOrThrow()).body).toBe(review.body);
    expect((await sendAttachment(review.id, 0))?.pdf).toEqual(pdf?.pdf);
  });

  it("records a delivered message once when the confirmation is repeated", async () => {
    const review = await prepareApplicationEmail("nw");
    const first = await confirmIntent(review.id);
    const second = await confirmIntent(review.id);
    expect(second.eventId).toBe(first.eventId);
    expect(sent).toHaveLength(1);
    expect(await prisma().statusEvent.count()).toBe(1);
    expect(await prisma().emailMessage.count()).toBe(1);
  });

  it("requires a fresh explicit review to resend an application", async () => {
    const review = await prepareApplicationEmail("nw");
    await confirmIntent(review.id);
    expect((await prepareApplicationEmail("nw")).id).toBe(review.id);
    const again = await prepareApplicationEmail("nw", true);
    expect(again.id).not.toBe(review.id);
    await confirmIntent(review.id);
    expect(sent).toHaveLength(1);
    await confirmIntent(again.id);
    expect(sent).toHaveLength(2);
    expect(await prisma().statusEvent.count()).toBe(1);
  });

  it("replaces an unsent review when source data changes and rejects the old review", async () => {
    const review = await prepareApplicationEmail("nw");
    expect((await prepareApplicationEmail("nw")).id).toBe(review.id);
    await prisma().profileField.update({ where: { key: "name" }, data: { value: "Jane Q Doe" } });
    const replacement = await prepareApplicationEmail("nw");
    expect(replacement.id).not.toBe(review.id);
    await expect(confirmIntent(review.id)).rejects.toThrow();
    expect((await reconcileIntent(review.id)).state).toBe("CANCELLED");
    expect(sent).toHaveLength(0);
  });

  it("rejects a source change while rendering attachments", async () => {
    vi.mocked(renderPdf).mockImplementationOnce(async () => {
      await prisma().profileField.update({ where: { key: "name" }, data: { value: "Changed mid-render" } });
      return new Uint8Array([37, 80, 68, 70]);
    });
    await expect(prepareApplicationEmail("nw")).rejects.toThrow("changed while preparing");
    expect(await prisma().emailSendIntent.count()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("reconciles a lost response by Message-ID without another POST", async () => {
    searchableSent({ loseResponse: true });
    const review = await prepareApplicationEmail("nw");
    await expect(confirmIntent(review.id)).rejects.toThrow("uncertain");
    expect((await activeSendReview("APPLICATION", "nw"))?.state).toBe("UNKNOWN");
    expect((await prepareApplicationEmail("nw", true)).id).toBe(review.id);
    expect((await reconcileIntent(review.id)).state).toBe("SENT");
    expect(sent).toHaveLength(1);
    expect(await prisma().emailMessage.count()).toBe(1);
  });

  it.each(["empty", "mismatch", "ambiguous", "unavailable"] as const)("does not resend or mark delivered after a %s reconciliation", async failure => {
    searchableSent({ loseResponse: true, mismatch: failure === "mismatch", ambiguous: failure === "ambiguous", unavailable: failure === "unavailable" });
    const review = await prepareApplicationEmail("nw");
    await expect(confirmIntent(review.id)).rejects.toThrow();
    if (failure === "empty") sent = [];
    await expect(reconcileIntent(review.id)).rejects.toThrow();
    await expect(confirmIntent(review.id)).rejects.toThrow("uncertain");
    expect((await activeSendReview("APPLICATION", "nw"))?.state).toBe("UNKNOWN");
    expect(sent).toHaveLength(failure === "empty" ? 0 : 1);
    expect(await prisma().emailMessage.count()).toBe(0);
  });

  it("repairs local recording from a persisted provider receipt after a transaction failure", async () => {
    const review = await prepareApplicationEmail("nw");
    const fail = vi.spyOn(prisma(), "$transaction").mockRejectedValueOnce(new Error("database temporarily unavailable"));
    await expect(confirmIntent(review.id)).rejects.toThrow("uncertain");
    fail.mockRestore();
    const intent = await prisma().emailSendIntent.findUniqueOrThrow({ where: { id: review.id } });
    expect(intent).toMatchObject({ state: "UNKNOWN", gmailId: "sent-1", threadId: "thread-new" });
    expect(await prisma().emailMessage.count()).toBe(0);
    const original = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => { if (String(url).includes("gmail.googleapis.com")) throw new Error("Must not call Gmail"); return original(url, init); }));
    expect((await reconcileIntent(review.id)).state).toBe("SENT");
    expect(await prisma().emailMessage.count()).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("remains blocked if the receipt and unknown-state writes both fail", async () => {
    searchableSent();
    const review = await prepareApplicationEmail("nw");
    const update = vi.spyOn(prisma().emailSendIntent, "update").mockRejectedValueOnce(new Error("database down"));
    const updateMany = prisma().emailSendIntent.updateMany.bind(prisma().emailSendIntent);
    const mark = vi.spyOn(prisma().emailSendIntent, "updateMany").mockImplementation(args => {
      if (args.data.state === "UNKNOWN") throw new Error("database still down");
      return updateMany(args);
    });
    await expect(confirmIntent(review.id)).rejects.toThrow();
    update.mockRestore(); mark.mockRestore();
    expect((await activeSendReview("APPLICATION", "nw"))?.state).toBe("SENDING");
    await expect(confirmIntent(review.id)).rejects.toThrow("uncertain");
    expect((await reconcileIntent(review.id)).state).toBe("SENT");
    expect(sent).toHaveLength(1);
  });

  it("does not send when the durable claim fails", async () => {
    const review = await prepareApplicationEmail("nw");
    const claim = vi.spyOn(prisma().emailSendIntent, "updateMany").mockRejectedValueOnce(new Error("database down"));
    await expect(confirmIntent(review.id)).rejects.toThrow("database down");
    claim.mockRestore();
    expect(sent).toHaveLength(0);
    expect((await reconcileIntent(review.id)).state).toBe("PREPARED");
  });

  it("does not move a later application status backwards", async () => {
    const review = await prepareApplicationEmail("nw");
    await prisma().application.update({ where: { id: "nw" }, data: { status: "INTERVIEW" } });
    await confirmIntent(review.id);
    expect((await prisma().application.findUniqueOrThrow({ where: { id: "nw" } })).status).toBe("INTERVIEW");
    expect(await prisma().statusEvent.count()).toBe(0);
  });

  it("blocks changed accounts and missing send permissions before a claim", async () => {
    const review = await prepareApplicationEmail("nw");
    await prisma().googleAccount.updateMany({ data: { email: "other@example.com" } });
    await expect(confirmIntent(review.id)).rejects.toThrow("Reconnect");
    await expect(reconcileIntent(review.id)).rejects.toThrow("Reconnect");
    await prisma().googleAccount.updateMany({ data: { email: "jane@gmail.com", scopes: "openid email" } });
    await expect(confirmIntent(review.id)).rejects.toThrow("permission");
    expect((await activeSendReview("APPLICATION", "nw"))?.state).toBe("PREPARED");
    expect(sent).toHaveLength(0);
  });

  it.each(["off", "demo"])("keeps the %s sending guard closed even for an existing review", async mode => {
    const review = await prepareApplicationEmail("nw");
    Object.assign(env, mode === "off" ? { DOSSIER_EMAIL_SEND: "off" } : { DOSSIER_DEMO_MODE: "on" });
    await expect(prepareApplicationEmail("nw")).rejects.toThrow("disabled");
    await expect(confirmIntent(review.id)).rejects.toThrow("disabled");
    expect((await reconcileIntent(review.id)).state).toBe("PREPARED");
    expect(sent).toHaveLength(0);
  });

  it("deduplicates replies and preserves a newer draft", async () => {
    const email = await incomingReply();
    const review = await prepareReply(email.id, "Yes, Tuesday works.");
    await prisma().emailMessage.update({ where: { id: email.id }, data: { replyDraft: "A newer draft in another tab." } });
    await Promise.allSettled([confirmIntent(review.id), confirmIntent(review.id)]);
    expect(sent).toHaveLength(1);
    expect(sent[0].threadId).toBe("reply-thread");
    expect((await prisma().emailMessage.findUniqueOrThrow({ where: { id: email.id } })).replyDraft).toBe("A newer draft in another tab.");
    expect((await prepareReply(email.id, "Different text")).state).toBe("SENT");
  });

  it("clears the matching reply draft atomically with delivery", async () => {
    const email = await incomingReply();
    const review = await prepareReply(email.id, email.replyDraft);
    await confirmIntent(review.id);
    expect(await prisma().emailMessage.findUniqueOrThrow({ where: { id: email.id } })).toMatchObject({ replyDraft: "", replyGaps: [], handledAt: expect.any(Date) });
  });

  it("treats malformed successful Gmail responses as uncertain", async () => {
    const original = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const response = await original(url, init);
      return String(url).endsWith("/messages/send") ? Response.json({ id: "missing-thread" }) : response;
    }));
    const review = await prepareApplicationEmail("nw");
    await expect(confirmIntent(review.id)).rejects.toThrow("uncertain");
    await expect(confirmIntent(review.id)).rejects.toThrow("uncertain");
    expect(sent).toHaveLength(1);
    expect(await prisma().emailMessage.count()).toBe(0);
  });

  it("rejects missing records, invalid attachments, and archived applications", async () => {
    await expect(confirmIntent("missing")).rejects.toThrow("Review");
    await expect(reconcileIntent("missing")).rejects.toThrow("no longer available");
    expect(await sendAttachment("missing", 0)).toBeNull();
    const review = await prepareApplicationEmail("nw");
    expect(await sendAttachment(review.id, 9)).toBeNull();
    await prisma().application.update({ where: { id: "nw" }, data: { archivedAt: new Date() } });
    await expect(prepareApplicationEmail("nw")).rejects.toThrow("Restore");
    expect(sent).toHaveLength(0);
  });
});


describe("send history retention", () => {
  it("preserves uncertain sends after their source application is deleted", async () => {
    searchableSent({ loseResponse: true });
    const review = await prepareApplicationEmail("nw");
    await expect(confirmIntent(review.id)).rejects.toThrow();
    await prisma().application.delete({ where: { id: "nw" } });
    expect(await prisma().emailSendIntent.findUniqueOrThrow({ where: { id: review.id } })).toMatchObject({ state: "UNKNOWN", applicationId: null });
    expect((await reconcileIntent(review.id)).state).toBe("SENT");
    expect(sent).toHaveLength(1);
    expect(await prisma().emailMessage.count()).toBe(1);
  });
  it("does not send an unconfirmed review after its application is removed", async () => {
    const review = await prepareApplicationEmail("nw");
    await prisma().application.delete({ where: { id: "nw" } });
    await expect(confirmIntent(review.id)).rejects.toThrow("removed or archived");
    expect(sent).toHaveLength(0);
  });
  it("blocks destructive replacements until an ambiguous send is resolved", async () => {
    searchableSent({ loseResponse: true });
    const review = await prepareApplicationEmail("nw");
    await expect(confirmIntent(review.id)).rejects.toThrow();
    await expect(prisma().$transaction(async tx => { await guardEmailSendHistory(tx); await tx.emailSendIntent.deleteMany(); })).rejects.toThrow("pending email sends");
    expect(await prisma().emailSendIntent.count()).toBe(1);
    await reconcileIntent(review.id);
    await prisma().$transaction(async tx => { await guardEmailSendHistory(tx); await tx.emailSendIntent.deleteMany(); });
    expect(await prisma().emailSendIntent.count()).toBe(0);
  });
});


it("rejects header line breaks before creating a send intent", async () => {
  const incoming = await incomingReply();
  await prisma().emailMessage.update({ where: { id: incoming.id }, data: { fromName: "Anna\r\nBcc: hidden@example.com" } });
  await expect(prepareReply(incoming.id, "Synthetic answer.")).rejects.toThrow("one line");
  expect(await prisma().emailSendIntent.count()).toBe(0);
  expect(sent).toHaveLength(0);
});

it("detects a corrupted saved attachment", async () => {
  const review = await prepareApplicationEmail("nw");
  const intent = await prisma().emailSendIntent.findUniqueOrThrow({ where: { id: review.id } });
  const payload = intent.payload as { attachments: { data: string }[] };
  payload.attachments[0].data = Buffer.from("corrupted").toString("base64");
  await prisma().emailSendIntent.update({ where: { id: intent.id }, data: { payload } });
  await expect(sendAttachment(intent.id, 0)).rejects.toThrow("could not be verified");
});

it("rejects oversized PDFs without sending or leaving a prepared record", async () => {
  vi.mocked(renderPdf).mockResolvedValueOnce(new Uint8Array(20 * 1024 * 1024));
  await expect(prepareApplicationEmail("nw")).rejects.toThrow("too large");
  expect(await prisma().emailSendIntent.count()).toBe(0);
  expect(sent).toHaveLength(0);
});


it("never replaces a review after another worker has claimed it", async () => {
  const review = await prepareApplicationEmail("nw");
  await prisma().profileField.update({ where: { key: "name" }, data: { value: "A newer source" } });
  let unlock!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const release = new Promise<void>(resolve => { unlock = resolve; });
  const worker = prisma().$transaction(async tx => {
    await tx.emailSendIntent.update({ where: { id: review.id }, data: { state: "SENDING", attemptedAt: new Date() } });
    locked(); await release;
  });
  await ready;
  const replacement = prepareApplicationEmail("nw");
  try {
    await vi.waitFor(async () => {
      const [row] = await prisma().$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%EmailSendIntent%'`;
      expect(row.count).toBeGreaterThan(0);
    });
  } finally { unlock(); }
  await worker;
  expect(await replacement).toMatchObject({ id: review.id, state: "SENDING" });
  expect(await prisma().emailSendIntent.count()).toBe(1);
  expect(sent).toHaveLength(0);
});
