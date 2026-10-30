import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("./account", () => ({ googleFetch: api }));
import { searchMessages } from "./gmail";
beforeEach(() => api.mockReset());
it("follows search pages within the requested bound", async () => {
  api.mockResolvedValueOnce({ messages: [{ id: "a" }], nextPageToken: "second" }).mockResolvedValueOnce({ messages: [{ id: "b" }] });
  expect(await searchMessages("company", { max: 2, requireComplete: true })).toEqual(["a", "b"]);
  expect(new URL(api.mock.calls[1][1]).searchParams.get("pageToken")).toBe("second");
  expect(new URL(api.mock.calls[1][1]).searchParams.get("maxResults")).toBe("1");
});
it("fails a truncated sync search instead of silently skipping older mail", async () => {
  api.mockResolvedValue({ messages: [{ id: "a" }], nextPageToken: "more" });
  await expect(searchMessages("company", { max: 1, requireComplete: true })).rejects.toThrow("too much mail");
  expect(api).toHaveBeenCalledTimes(1);
});
