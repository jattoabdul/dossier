import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("./account", () => ({ googleFetch: api }));
import { findSentMessage } from "./gmail";

const token = "853afbee-e34f-4ca3-926a-35e5da19dbe8";
const attemptedAt = new Date("2026-11-01T12:00:00Z");
const recovery = { token, attemptedAt };
const find = () => findSentMessage("<original@dossier.invalid>", "jane@example.com", recovery);
const message = () => ({
  id: "sent", threadId: "thread", labelIds: ["SENT"], internalDate: String(attemptedAt.getTime()),
  payload: { mimeType: "text/plain", headers: [
    { name: "X-Dossier-Send-Token", value: token },
    { name: "From", value: "Jane <jane@example.com>" },
    { name: "To", value: "recruiter@example.com" },
    { name: "Subject", value: "Synthetic application" },
    { name: "Message-ID", value: "<rewritten@gmail.example>" },
  ], body: { data: Buffer.from("Synthetic text").toString("base64url") } },
});
const stage = (messages = [{ id: "sent" }], nextPageToken?: string) => {
  api.mockResolvedValueOnce({ messages: [] }).mockResolvedValueOnce({ messages, nextPageToken });
};
beforeEach(() => { api.mockReset(); });

it("recovers an independent token using only bounded, account-pinned reads", async () => {
  stage(); api.mockResolvedValueOnce(message());
  expect(await find()).toMatchObject({ id: "sent", messageId: "<rewritten@gmail.example>" });
  const url = new URL(api.mock.calls[1][1]);
  expect(url.searchParams.get("q")).toBe(`in:sent after:${attemptedAt.getTime() / 1000 - 120} before:${attemptedAt.getTime() / 1000 + 600}`);
  expect(url.searchParams.get("maxResults")).toBe("100");
  for (const [scope, , options] of api.mock.calls) {
    expect(scope).toBe("read");
    expect(options).toEqual({ expectedEmail: "jane@example.com" });
  }
});

it.each([
  ["missing token", (m: ReturnType<typeof message>) => { m.payload.headers.shift(); }],
  ["wrong token", (m: ReturnType<typeof message>) => { m.payload.headers[0].value = "another-token"; }],
  ["duplicate token", (m: ReturnType<typeof message>) => { m.payload.headers.push(m.payload.headers[0]); }],
  ["incoming notification", (m: ReturnType<typeof message>) => { m.labelIds = ["INBOX"]; }],
  ["missing time", (m: ReturnType<typeof message>) => { m.internalDate = ""; }],
  ["invalid time", (m: ReturnType<typeof message>) => { m.internalDate = "invalid"; }],
  ["old copy", (m: ReturnType<typeof message>) => { m.internalDate = String(attemptedAt.getTime() - 121_000); }],
  ["later copy", (m: ReturnType<typeof message>) => { m.internalDate = String(attemptedAt.getTime() + 601_000); }],
  ["missing thread", (m: ReturnType<typeof message>) => { m.threadId = ""; }],
  ["duplicate sender", (m: ReturnType<typeof message>) => { m.payload.headers.push(m.payload.headers[1]); }],
  ["missing recipient", (m: ReturnType<typeof message>) => { m.payload.headers.splice(2, 1); }],
  ["extra cc", (m: ReturnType<typeof message>) => { m.payload.headers.push({ name: "Cc", value: "extra@example.com" }); }],
  ["extra bcc", (m: ReturnType<typeof message>) => { m.payload.headers.push({ name: "Bcc", value: "extra@example.com" }); }],
  ["snippet instead of body", (m: ReturnType<typeof message>) => { m.payload.body.data = ""; }],
] as const)("refuses a %s even when the other fields match", async (_name, mutate) => {
  stage(); const m = message(); mutate(m); api.mockResolvedValueOnce(m);
  expect(await find()).toBeNull();
});

it.each(["duplicate", "paginated", "over cap", "empty", "unreadable"])("leaves %s search results unresolved", async mode => {
  if (mode === "empty") stage([]);
  else if (mode === "over cap") stage(Array.from({ length: 101 }, (_, i) => ({ id: String(i) })));
  else stage(mode === "duplicate" ? [{ id: "sent" }, { id: "another" }] : undefined, mode === "paginated" ? "next" : undefined);
  if (mode === "unreadable") {
    api.mockRejectedValueOnce(new Error("Read failed"));
    await expect(find()).rejects.toThrow("Read failed");
  } else {
    api.mockResolvedValue(message());
    expect(await find()).toBeNull();
  }
  if (["paginated", "over cap", "empty"].includes(mode)) expect(api).toHaveBeenCalledTimes(2);
});

it("scans past unrelated messages without treating a similar body as identity", async () => {
  stage([{ id: "other" }, { id: "sent" }]);
  const other = message(); other.payload.headers.shift();
  api.mockResolvedValueOnce(other).mockResolvedValueOnce(message());
  expect(await find()).toMatchObject({ id: "sent" });
});

it.each([undefined, { token: "bad", attemptedAt }, { token, attemptedAt: new Date("bad") }])("does not broaden a legacy or invalid recovery request", async context => {
  api.mockResolvedValueOnce({});
  expect(await findSentMessage("<old@dossier.invalid>", "jane@example.com", context)).toBeNull();
  expect(api).toHaveBeenCalledTimes(1);
});

it.each([{ messages: [{ id: "a" }, { id: "b" }] }, { messages: [], nextPageToken: "next" }])("does not broaden an ambiguous original-ID search", async result => {
  api.mockResolvedValueOnce(result);
  expect(await find()).toBeNull();
  expect(api).toHaveBeenCalledTimes(1);
});
