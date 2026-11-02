import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
import { getSession } from "@/lib/auth/session";
import { sendAttachment } from "@/lib/google/send-intent";
import { GET } from "./route";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/google/send-intent", () => ({ sendAttachment: vi.fn() }));
const id = "12345678-1234-4234-8234-123456789012";
const get = (query = `id=${id}&index=0`, headers?: HeadersInit) => GET(new NextRequest(`http://localhost:3000/api/email-send/attachment?${query}`, { headers }), undefined);
beforeEach(() => {
  vi.mocked(getSession).mockResolvedValue({ persistent: false, issuedAt: new Date(), expiresAt: new Date() });
  vi.mocked(sendAttachment).mockReset().mockResolvedValue({ fileName: "Synthetic resume.pdf", pdf: Buffer.from("%PDF synthetic") });
});
it("downloads the frozen PDF privately without rendering a live document", async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(await response.text()).toBe("%PDF synthetic");
  expect(sendAttachment).toHaveBeenCalledWith(id, 0);
});
it("requires a session and rejects cross-origin access", async () => {
  vi.mocked(getSession).mockResolvedValue(null);
  expect((await get()).status).toBe(401);
  expect(sendAttachment).not.toHaveBeenCalled();
  expect((await get(undefined, { origin: "https://unrelated.example", host: "localhost:3000" })).status).toBe(403);
});
it("rejects invalid or missing attachments", async () => {
  expect((await get("id=bad&index=-1")).status).toBe(404);
  expect(sendAttachment).not.toHaveBeenCalled();
  vi.mocked(sendAttachment).mockResolvedValue(null);
  expect((await get()).status).toBe(404);
});
