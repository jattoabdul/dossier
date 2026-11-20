import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usesSqlite } from "@/lib/database";
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
vi.mock("@/lib/notifications/notify", () => ({ emit: vi.fn(async () => 0) }));

vi.mock("@/lib/time-zone", () => ({ userTimeZone: async () => "Europe/Berlin", lastKnownTimeZone: async () => "Europe/Berlin" }));

import { encryptSecret, GOOGLE_TOKEN } from "@/lib/secrets";

import { googleConnection, saveGoogleAccount } from "./account";
import { env } from "@/lib/env";
import { renderPdf } from "@/lib/pdf/render";
import { prepareApplicationEmail, prepareApplicationMessage, prepareReply, sendApplicationEmail, sendReply } from "./send";
import { guardEmailSendHistory } from "./send-guard";
import { activeSendReview, confirmIntent, reconcileIntent, sendAttachment } from "./send-intent";

import { syncInbox } from "./sync";

const prisma = () => db.client!;
const b64 = (text: string) => Buffer.from(text).toString("base64url");

/** `history`: when Gmail added it; before the mailbox's 200 unless given. `deleted`: listed, but gone when fetched. */
type Mail = { replyTo?: string; id: string; threadId: string; from: string; subject: string; text: string; labels?: string[]; date?: string; history?: number; refuse?: number; forbid?: boolean; deleted?: boolean };
const gmailMessage = ({ replyTo, id, threadId, from, subject, text, labels = ["INBOX"], date = "2026-10-17T13:02:00Z" }: Mail) => ({

  id,
  threadId,
  labelIds: labels,
  internalDate: String(new Date(date).getTime()),
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: from },
      ...(replyTo !== undefined ? [{ name: "Reply-To", value: replyTo }] : []),
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
  const refused = (reason: string) =>
    new Response(JSON.stringify({ error: { code: 403, message: reason, errors: [{ reason, domain: "usageLimits" }] } }), { status: 403, headers: { "content-type": "application/json", "retry-after": "0" } });
  if (mail?.forbid) return refused("insufficientPermissions");
  if (mail?.refuse) {
    mail.refuse -= 1;
    return refused("rateLimitExceeded");
  }
  if (mail && !mail.deleted) return json(gmailMessage(mail));
  return new Response("not found", { status: 404 });
}

/** Earlier tests leave an hour-long access token in memory; without it, the refresh token is asked for. */
const forgetAccessTokens = () => (globalThis as { googleTokens?: Map<string, unknown> }).googleTokens?.clear();

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
    reply: () => ({ kind: "INTERVIEW", summary: "Invites you to a call.", questions: ["What is your notice period?"], confirmedTime: null, unrelated: false }),
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
  it("fills in the application's offer from a reply read as one, once (E30-7)", async () => {
    await sendApplicationEmail("nw");
    provider.current = new MockProvider({
      reply: () => ({
        kind: "OFFER",
        summary: "Offers you the role.",
        questions: [],
        confirmedTime: null,
        unrelated: false,
        offer: { salary: "€82,000 a year", decideBy: "2026-12-11", startDate: null, holidays: "27 days", office: "" },
      }),
    });
    const thread = (await prisma().application.findUniqueOrThrow({ where: { id: "nw" } })).emailThreadId!;
    mailbox = [{ id: "m9", threadId: thread, from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "We'd love to offer you the role.", history: 250 }];
    await syncInbox();
    expect(await prisma().offer.findUniqueOrThrow({ where: { applicationId: "nw" } })).toMatchObject({ salary: "€82,000 a year", decideBy: new Date("2026-12-11T00:00:00Z"), holidays: "27 days", fromEmailId: expect.any(String) });
  });

  it("links replies in a known thread or from the company's domain, and has the AI read them", async () => {
    await sendApplicationEmail("nw");
    mailbox = [
      { id: "m1", threadId: "thread-new", from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "Could we talk next week?\n\nOn Mon, Jane wrote:\n> I'm applying" },
      { id: "m2", threadId: "t2", from: "HR <hr@northwind.example>", subject: "Your application", text: "Thanks!" },
      { id: "m3", threadId: "t3", from: "Friend <friend@gmail.com>", subject: "Lunch?", text: "Tomorrow?" },
      { id: "m4", threadId: "t4", from: "Deals <deals@shop.example>", subject: "Sale", text: "50% off", labels: ["INBOX", "CATEGORY_PROMOTIONS"] },
    ];
    const result = await syncInbox();
    expect(result).toEqual({ fetched: 4, kept: 2, read: 2, unread: 0 });

    const kept = await prisma().emailMessage.findMany({ where: { direction: "INCOMING" }, orderBy: { gmailId: "asc" } });
    expect(kept.map((email) => [email.gmailId, email.applicationId, email.kind, email.suggestedStatus])).toEqual([
      // One suggestion per application (#358): the last mail's, as they were sent at the same time.
      ["m1", "nw", "INTERVIEW", null],
      ["m2", "nw", "INTERVIEW", "INTERVIEW"],
    ]);
    expect(kept[0].body).toBe("Could we talk next week?");
    expect(kept[0].questions).toEqual(["What is your notice period?"]);
    const account = await prisma().googleAccount.findUniqueOrThrow({ where: { id: "google" } });
    expect(account).toMatchObject({ historyId: "200", syncProblem: null });

    // The next check carries on from the history: only what's new since.
    mailbox.push({ id: "m6", threadId: "thread-new", from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "Wednesday 14:00 works.", history: 250 });
    expect(await syncInbox()).toEqual({ fetched: 1, kept: 1, read: 1, unread: 0 });
    expect((await prisma().googleAccount.findUniqueOrThrow({ where: { id: "google" } })).historyId).toBe("300");
  });

  it("says who replied about which application on a scheduled check, never what they wrote (E26-6)", async () => {
    const { emit } = await import("@/lib/notifications/notify");
    vi.mocked(emit).mockClear();
    await sendApplicationEmail("nw");
    mailbox = [
      { id: "m1", threadId: "thread-new", from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "Could we talk next week?" },
      { id: "m3", threadId: "t3", from: "Friend <friend@gmail.com>", subject: "Lunch?", text: "Tomorrow?" },
    ];
    await syncInbox({ notify: true });
    const application = await prisma().application.findUniqueOrThrow({ where: { id: "nw" } });
    expect(vi.mocked(emit).mock.calls).toEqual([["reply.arrived", { applicationId: "nw", from: "Anna Keller", title: application.role || application.title, company: application.company }]]);
    expect(JSON.stringify(vi.mocked(emit).mock.calls)).not.toContain("Could we talk");

    // "Check now" never sends it.
    vi.mocked(emit).mockClear();
    mailbox.push({ id: "m6", threadId: "thread-new", from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "Wednesday works.", history: 250 });
    await syncInbox();
    expect(emit).not.toHaveBeenCalled();
  });

  it("skips mail deleted since Gmail listed it, and carries on from the history", async () => {
    await sendApplicationEmail("nw");
    await syncInbox();
    mailbox = [
      { id: "spam", threadId: "t8", from: "Spam <win@prize.example>", subject: "You won", text: "Click", labels: ["SPAM"], history: 250, deleted: true },
      { id: "m7", threadId: "thread-new", from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "Thursday?", history: 250 },
    ];
    expect(await syncInbox()).toEqual({ fetched: 2, kept: 1, read: 1, unread: 0 });
    expect(await prisma().googleAccount.findUniqueOrThrow({ where: { id: "google" } })).toMatchObject({ historyId: "300", syncProblem: null });
  });

  it("asks again when Gmail refuses a message for its rate limit, and leaves one it keeps refusing for the next check (public issue 68)", async () => {
    await sendApplicationEmail("nw");
    await syncInbox();
    mailbox = [
      { id: "m7", threadId: "thread-new", from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "Thursday?", history: 250, refuse: 2 },
      { id: "m8", threadId: "thread-new", from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "Or Friday?", history: 260, refuse: Infinity },
    ];
    expect(await syncInbox()).toEqual({ fetched: 2, kept: 1, read: 1, unread: 1 });
    expect(await prisma().emailMessage.findFirst({ where: { gmailId: "m7" } })).toMatchObject({ applicationId: "nw", kind: "INTERVIEW" });
    // The history stays where it was, so m8 is listed again next time, and Settings says so.
    expect(await prisma().googleAccount.findUniqueOrThrow({ where: { id: "google" } })).toMatchObject({
      historyId: "200",
      syncProblem: "1 message couldn't be read from Gmail. The next check tries again.",
    });
    mailbox[1].refuse = 0;
    expect(await syncInbox()).toEqual({ fetched: 1, kept: 1, read: 1, unread: 0 });
    expect(await prisma().googleAccount.findUniqueOrThrow({ where: { id: "google" } })).toMatchObject({ historyId: "300", syncProblem: null });

    // A 403 for a missing permission still stops the check, as before.
    mailbox.push({ id: "m9", threadId: "thread-new", from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "Hi", history: 350, forbid: true });
    await expect(syncInbox()).rejects.toThrow("Google refused that. Check the permissions in Settings → Google.");
    expect(await prisma().googleAccount.findUniqueOrThrow({ where: { id: "google" } })).toMatchObject({ syncProblem: "Google refused that. Check the permissions in Settings → Google." });
  }, 20_000);

  it("stops asking Google once it refuses the saved access, until the account is connected again (#136)", async () => {
    forgetAccessTokens();
    let tokenCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (!String(url).startsWith("https://oauth2.googleapis.com/token")) return fakeGoogle(String(url), init);
        tokenCalls += 1;
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }),
    );
    await expect(syncInbox()).rejects.toThrow("Google no longer accepts Dossier's access.");
    expect(await googleConnection()).toMatchObject({ status: "connected", signInProblem: expect.stringContaining("Connect your Google account again") });
    await expect(syncInbox()).rejects.toThrow("Google no longer accepts Dossier's access.");
    expect(tokenCalls).toBe(1);

    await saveGoogleAccount({ email: "jane@gmail.com", refreshToken: "new-refresh", scopes });
    expect(await googleConnection()).toMatchObject({ signInProblem: null, syncProblem: null });
  });

  it("pauses, but keeps, saved access it can't read, since the old DOSSIER_SECRET reads it again (#136)", async () => {
    forgetAccessTokens();
    const other = encryptSecret(GOOGLE_TOKEN, "refresh", "o".repeat(40));
    await prisma().googleAccount.update({ where: { id: "google" }, data: { refreshTokenEnc: other } });
    expect(await googleConnection()).toMatchObject({ signInProblem: expect.stringContaining("DOSSIER_SECRET changed") });
    await expect(syncInbox()).rejects.toThrow("can't be read");
    expect(await prisma().googleAccount.findUniqueOrThrow({ where: { id: "google" } })).toMatchObject({ refreshTokenEnc: other });
  });

  it("unlinks a mail matched by the company's name or domain that the AI finds unrelated, and keeps a thread's reply linked (public issue 65)", async () => {
    await sendApplicationEmail("nw");
    provider.current = new MockProvider({
      reply: (call) => {
        const other = String(call.messages[0].content).includes("200061456");
        return { kind: other ? "REJECTION" : "INTERVIEW", summary: other ? "Declines the support role." : "Invites you.", questions: [], confirmedTime: null, unrelated: other };
      },
    });
    mailbox = [
      { id: "m1", threadId: "thread-new", from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "We won't go ahead with Technical Support Engineering 200061456." },
      { id: "m2", threadId: "t2", from: "Careers <careers@northwind.example>", subject: "Your application", text: "Technical Support Engineering 200061456: we won't go ahead." },
      { id: "m3", threadId: "t2", from: "Careers <careers@northwind.example>", subject: "Re: Your application", text: "Best wishes." },
    ];
    expect(await syncInbox()).toEqual({ fetched: 3, kept: 3, read: 3, unread: 0 });
    const kept = await prisma().emailMessage.findMany({ where: { direction: "INCOMING" }, orderBy: { gmailId: "asc" } });
    expect(kept.map((email) => [email.gmailId, email.applicationId, email.kind, email.suggestedStatus])).toEqual([
      // In the thread Dossier wrote in: linked whatever it says.
      ["m1", "nw", "REJECTION", "REJECTED"],
      // By the domain only, and about another role: waits for a look, with the rest of its thread.
      ["m2", null, "REJECTION", null],
      ["m3", null, "INTERVIEW", null],
    ]);
  });

  it("logs no mail content when reading fails or Gmail refuses a mail (#358)", async () => {
    const logged: string[] = [];
    const spies = (["error", "warn", "log", "info"] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" "))));
    try {
      await sendApplicationEmail("nw");
      // The model fails in a way that echoes what it was given.
      provider.current = new MockProvider({ reply: (call) => Promise.reject(new Error(`Bad request: ${String(call.messages[0].content)}`)) });
      mailbox = [{ id: "m1", threadId: "thread-new", from: "Anna Keller <anna.keller@northwind.example>", subject: "Re: Application, salary 81,500", text: "Your notice period is ZEBRA-7731, right?" }];
      expect(await syncInbox()).toMatchObject({ kept: 1, read: 0 });
      // A refused mail stops the check, which says so in Settings; that's logged too.
      mailbox = [...mailbox, { id: "m2", threadId: "t2", from: "Hidden Sender <hidden.sender@northwind.example>", subject: "Private subject QUOKKA", text: "Private body QUOKKA", forbid: true, history: 250 }];
      await expect(syncInbox()).rejects.toThrow();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(logged.some((line) => line.startsWith("[reading a reply]"))).toBe(true);
    expect(logged.some((line) => line.startsWith("[inbox check]"))).toBe(true);
    for (const secret of ["ZEBRA-7731", "81,500", "anna.keller", "Anna Keller", "QUOKKA", "hidden.sender", "notice period"]) {
      expect(logged.join("\n"), secret).not.toContain(secret);
    }
  });

  it("keeps one status suggestion per application, the newest mail's, whatever order they're read in (#358)", async () => {
    await sendApplicationEmail("nw");
    mailbox = [
      { id: "m1", threadId: "thread-new", from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "Could we talk?", date: "2026-10-18T09:00:00Z" },
      { id: "m2", threadId: "thread-new", from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "Could we talk next week?", date: "2026-10-17T09:00:00Z" },
    ];
    await syncInbox();
    const kept = await prisma().emailMessage.findMany({ where: { direction: "INCOMING" }, orderBy: { gmailId: "asc" } });
    expect(kept.map((email) => [email.gmailId, email.suggestedStatus])).toEqual([
      ["m1", "INTERVIEW"],
      ["m2", null],
    ]);
  });

  it("keeps a thread moved to another application there, even the one it was sent from (public #134)", async () => {
    await sendApplicationEmail("nw");
    await prisma().application.create({ data: { id: "lg", company: "Ledgerly", role: "Designer", status: "SENT" } });
    mailbox = [{ id: "m1", threadId: "thread-new", from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "Could we talk?" }];
    await syncInbox();
    // Moved by hand, as the application's Email tab does.
    await prisma().emailMessage.updateMany({ where: { threadId: "thread-new" }, data: { applicationId: "lg" } });
    mailbox.push({ id: "m2", threadId: "thread-new", from: "Anna Keller <a.keller@northwind.example>", subject: "Re: Application", text: "Wednesday?", history: 250 });
    await syncInbox();
    expect((await prisma().emailMessage.findFirstOrThrow({ where: { gmailId: "m2" } })).applicationId).toBe("lg");
  });

  it("leaves out drafts, even in a known thread", async () => {
    await sendApplicationEmail("nw");
    mailbox = [{ id: "d1", threadId: "thread-new", from: "Jane Doe <jane@gmail.com>", subject: "Re: Application", text: "Hi Anna,", labels: ["DRAFT"] }];
    expect(await syncInbox()).toEqual({ fetched: 1, kept: 0, read: 0, unread: 0 });
    expect(await prisma().emailMessage.findFirst({ where: { gmailId: "d1" } })).toBeNull();
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
    expect(await syncInbox()).toEqual({ fetched: 2, kept: 2, read: 0, unread: 0 });
    const kept = await prisma().emailMessage.findMany({ where: { threadId: "ambiguous" } });
    expect(kept).toHaveLength(2);
    expect(kept.every((email) => email.applicationId === null && email.suggestedStatus === null)).toBe(true);
    expect(await syncInbox()).toEqual({ fetched: 0, kept: 0, read: 0, unread: 0 });
    expect(await prisma().emailMessage.count({ where: { threadId: "ambiguous" } })).toBe(2);
  });

  it("narrows the first known-app lookup and skips classification without a usable model", async () => {
    provider.current = null;
    mailbox = [{ id: "domain", threadId: "domain-thread", from: "HR <hr@northwind.example>", subject: "Your application", text: "Thanks!" }];
    expect(await syncInbox({ backfillDays: 60 })).toEqual({ fetched: 1, kept: 1, read: 0, unread: 0 });
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
    expect(await syncInbox()).toEqual({ fetched: 4, kept: 1, read: 1, unread: 0 });
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
function searchableSent({ loseResponse = false, mismatch = false, ambiguous = false, unavailable = false, rewriteId = false, wrongFrom = false, wrongBody = false, wrongThread = false } = {}) {
  const original = fetch;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/messages") && u.searchParams.get("q")?.startsWith("in:sent ")) {
      if (unavailable) return new Response("unavailable", { status: 503 });
      return Response.json({ messages: (rewriteId && u.searchParams.get("q")?.includes("rfc822msgid:") ? [] : sent).map((_, i) => ({ id: `sent-${i + 1}` })), ...(ambiguous ? { nextPageToken: "next" } : {}) });
    }
    if (/messages\/sent-\d+$/.test(u.pathname)) {
      const index = Number(u.pathname.split("-").at(-1)) - 1;
      const raw = Buffer.from(sent[index].raw, "base64url").toString("utf8");
      const header = (name: string) => new RegExp(`^${name}: (.+)`, "m").exec(raw)?.[1].trim() ?? "";
      const body = /Content-Type: text\/plain[^]*?Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(raw)?.[1] ?? "";
      return Response.json({ id: `sent-${index + 1}`, threadId: wrongThread ? "wrong-thread" : sent[index].threadId ?? "thread-new", labelIds: ["SENT"], internalDate: String(Date.now()),
        payload: { mimeType: "text/plain", headers: ["From", "To", "Subject", "Message-ID", "X-Dossier-Send-Token"].map(name => ({ name, value: wrongFrom && name === "From" ? "other@example.com" : rewriteId && name === "Message-ID" ? "<rewritten@gmail.example>" : mismatch && name === "To" ? "someone-else@example.com" : header(name) })), body: { data: wrongBody ? b64("Different body") : Buffer.from(body, "base64").toString("base64url") } } });
    }
    const result = await original(url, init);
    if (loseResponse && u.pathname.endsWith("/messages/send")) throw new Error("lost response");
    return result;
  }));
}

async function incomingReply() {
  mailbox.push({ id: "incoming", threadId: "reply-thread", from: "Anna <recruiter@northwind.example>", subject: "Interview", text: "Are you free?" });
  return prisma().emailMessage.create({ data: { gmailId: "incoming", threadId: "reply-thread", applicationId: "nw", direction: "INCOMING", fromAddress: "recruiter@northwind.example", fromName: "Anna", toAddress: "jane@gmail.com", subject: "Interview", body: "Are you free?", messageId: "<incoming@northwind.example>", sentAt: new Date(), replyDraft: "Yes, Tuesday works." } });
}

describe("durable, reviewed Gmail sends", () => {
  it("uses the notification Reply-To relay in the review instead of the From address", async () => {
    const email = await incomingReply();
    mailbox[0].from = "Recruiter <hit-reply@linkedin.example>";
    mailbox[0].replyTo = "Recruiter <synthetic-relay@reply.linkedin.example>";
    await prisma().emailMessage.update({ where: { id: email.id }, data: { fromName: "Recruiter", fromAddress: "hit-reply@linkedin.example" } });
    const review = await prepareReply(email.id, "Synthetic answer.");
    expect(review.to).toBe("Recruiter <synthetic-relay@reply.linkedin.example>");
    expect(sent).toHaveLength(0);
  });

  it("blocks an old unverified reply review and requires a new recipient review", async () => {
    const email = await incomingReply();
    const review = await prepareReply(email.id, "Synthetic answer.");
    const intent = await prisma().emailSendIntent.findUniqueOrThrow({ where: { id: review.id } });
    const payload = { ...intent.payload as Record<string, unknown> };
    delete payload.replyRecipientVerified;
    await prisma().emailSendIntent.update({ where: { id: review.id }, data: { payload: payload as NonNullable<typeof intent.payload>, fingerprint: "legacy" } });
    await expect(confirmIntent(review.id)).rejects.toThrow("Review this reply again");
    expect(sent).toHaveLength(0);
    const next = await prepareReply(email.id, "Synthetic answer.");
    expect(next.id).not.toBe(review.id);
    await expect(confirmIntent(review.id)).rejects.toThrow("uncertain");
    expect(sent).toHaveLength(0);
  });

  it("leaves a legacy rewritten-ID send uncertain when no token was frozen", async () => {
    searchableSent({ loseResponse: true, rewriteId: true });
    const review = await prepareApplicationEmail("nw");
    const intent = await prisma().emailSendIntent.findUniqueOrThrow({ where: { id: review.id } });
    const payload = { ...intent.payload as Record<string, unknown> };
    delete payload.sendToken;
    await prisma().emailSendIntent.update({ where: { id: review.id }, data: { payload: payload as NonNullable<typeof intent.payload> } });
    await expect(confirmIntent(review.id)).rejects.toThrow("uncertain");
    await expect(reconcileIntent(review.id)).rejects.toThrow("uncertain");
    await expect(confirmIntent(review.id)).rejects.toThrow("uncertain");
    expect(sent).toHaveLength(1);
  });

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
    expect((await prisma().application.findUniqueOrThrow({ where: { id: "nw" } })).frozen).toMatchObject({ profile: { basics: { name: "Jane Doe" } } });
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

  it.each(["APPLICATION", "REPLY"])("recovers a rewritten Message-ID and lost receipt for %s without another POST", async kind => {
    searchableSent({ loseResponse: true, rewriteId: true });
    const review = kind === "APPLICATION" ? await prepareApplicationEmail("nw") : await prepareReply((await incomingReply()).id, "Synthetic answer.");
    await expect(confirmIntent(review.id)).rejects.toThrow("uncertain");
    expect((await reconcileIntent(review.id)).state).toBe("SENT");
    expect((await reconcileIntent(review.id)).state).toBe("SENT");
    expect(sent).toHaveLength(1);
    expect(await prisma().emailMessage.count({ where: { direction: "OUTGOING" } })).toBe(1);
    expect((await prisma().emailMessage.findFirstOrThrow({ where: { direction: "OUTGOING" } })).messageId).toBe("<rewritten@gmail.example>");
  });

  it.each(["recipient", "sender", "body", "thread"])("rejects rewritten-ID recovery with a mismatched %s", async field => {
    searchableSent({ loseResponse: true, rewriteId: true, mismatch: field === "recipient", wrongFrom: field === "sender", wrongBody: field === "body", wrongThread: field === "thread" });
    const review = await prepareReply((await incomingReply()).id, "Synthetic answer.");
    await expect(confirmIntent(review.id)).rejects.toThrow("uncertain");
    await expect(reconcileIntent(review.id)).rejects.toThrow("uncertain");
    await expect(confirmIntent(review.id)).rejects.toThrow("uncertain");
    expect(sent).toHaveLength(1);
    expect(await prisma().emailMessage.count({ where: { direction: "OUTGOING" } })).toBe(0);
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


it.skipIf(usesSqlite())("never replaces a review after another worker has claimed it", async () => {
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


describe("reviewed follow-up messages", () => {
  async function messageDraft() {
    await incomingReply();
    const draft = { kind: "follow-up", to: "untrusted@example.com", subject: "Draft subject", body: "Synthetic follow-up.", writtenWith: "test", at: new Date().toISOString() };
    await prisma().application.update({ where: { id: "nw" }, data: { emailThreadId: "reply-thread", messageDraft: draft } });
    return draft;
  }
  it("reviews the verified recipient and freezes text before confirming once", async () => {
    const draft = await messageDraft();
    mailbox[0].replyTo = "Recruiter <synthetic-relay@reply.linkedin.example>";
    const review = await prepareApplicationMessage("nw");
    expect(review.to).toBe("Recruiter <synthetic-relay@reply.linkedin.example>");
    expect(sent).toHaveLength(0);
    await prisma().application.update({ where: { id: "nw" }, data: { messageDraft: { ...draft, body: "Newer unsent edit." } } });
    await Promise.allSettled([confirmIntent(review.id), confirmIntent(review.id)]);
    expect(sent).toHaveLength(1);
    expect((await prisma().application.findUniqueOrThrow({ where: { id: "nw" } })).messageDraft).toMatchObject({ body: "Newer unsent edit." });
    expect((await prisma().emailMessage.findFirstOrThrow({ where: { direction: "OUTGOING" } })).body).toBe(review.body);
  });
  it("recovers a rewritten ID and lost receipt without resending the follow-up", async () => {
    await messageDraft();
    searchableSent({ loseResponse: true, rewriteId: true });
    const review = await prepareApplicationMessage("nw");
    await expect(confirmIntent(review.id)).rejects.toThrow("uncertain");
    expect((await prepareApplicationMessage("nw", true)).id).toBe(review.id);
    expect((await reconcileIntent(review.id)).state).toBe("SENT");
    expect(sent).toHaveLength(1);
    expect((await prisma().application.findUniqueOrThrow({ where: { id: "nw" } })).messageDraft).toBeNull();
  });
});
