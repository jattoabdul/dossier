import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("./account", () => ({ googleFetch: api }));
import { replyRecipient } from "./gmail";

beforeEach(() => { api.mockReset(); });
const read = () => replyRecipient("incoming", "jane@example.com", "thread");
function headers(values: { name: string; value: string }[]) {
  api.mockResolvedValue({ id: "incoming", threadId: "thread", payload: { headers: values } });
}
const from = { name: "From", value: "Recruiter <recruiter@example.com>" };

it("uses Reply-To even when From is a notification address", async () => {
  headers([{ name: "From", value: "Notification <no-reply@example.com>" }, { name: "rEpLy-To", value: "Recruiter <relay@reply.example.com>" }]);
  expect(await read()).toBe("Recruiter <relay@reply.example.com>");
  expect(api.mock.calls[0][0]).toBe("read");
  expect(api.mock.calls[0][2]).toEqual({ expectedEmail: "jane@example.com" });
  expect(String(api.mock.calls[0][1])).toContain("/messages/incoming?format=metadata");
});

it("falls back to a single valid From only when Reply-To is absent", async () => {
  headers([from]); expect(await read()).toBe(from.value);
});

it("normalizes a quoted display name without changing the mailbox", async () => {
  headers([{ name: "Reply-To", value: '"Doe, Jane" <jane@example.com>' }]);
  expect(await read()).toBe("Doe  Jane <jane@example.com>");
});

it.each([
  "", "not an address", "one@example.com, two@example.com", "Group: one@example.com;",
  "One <one@example.com> trailing", "One <one@example.com>\r\nBcc: hidden@example.com",
  "no-reply@example.com", "noreply@example.com", "do_not_reply@example.com", "hit-reply@linkedin.com",
])("blocks an unusable Reply-To without falling back to From: %s", async value => {
  headers([from, { name: "Reply-To", value }]);
  await expect(read()).rejects.toThrow("no usable reply address");
});

it.each([
  [], [from, from], [from, { name: "Reply-To", value: "a@example.com" }, { name: "Reply-To", value: "b@example.com" }],
  [{ name: "From", value: "no-reply@example.com" }], [{ name: "From", value: "hit-reply@linkedin.com" }],
].map(values => ({ values })))("blocks absent, ambiguous or no-reply source headers", async ({ values }) => {
  headers(values); await expect(read()).rejects.toThrow("no usable reply address");
});

it.each(["id", "threadId"])("rejects an unexpected source %s", async key => {
  api.mockResolvedValue({ id: "incoming", threadId: "thread", [key]: "different", payload: { headers: [from] } });
  await expect(read()).rejects.toThrow("no usable reply address");
});

it("does not fall back when Gmail cannot be read", async () => {
  api.mockRejectedValue(new Error("Read unavailable"));
  await expect(read()).rejects.toThrow("Read unavailable");
});
