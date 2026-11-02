import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ email: "first@example.com", token: "first-refresh" }));
vi.mock("@/lib/prisma", () => ({ prisma: { googleAccount: { findUnique: async () => ({ email: state.email, refreshTokenEnc: state.token, scopes: "send" }) } } }));
vi.mock("@/lib/secrets", () => ({ decryptSecret: (_key: unknown, token: string) => token, encryptSecret: () => "encrypted", GOOGLE_TOKEN: {}, SecretUnreadable: class extends Error {} }));
vi.mock("./oauth", () => ({ googleClient: async () => ({}), hasScopes: () => true, refreshAccessToken: vi.fn(async (token: string) => ({ access_token: `${token}-access`, expires_in: 3600 })), revokeToken: async () => {} }));
import { accessToken, googleFetch } from "./account";
import { refreshAccessToken } from "./oauth";
beforeEach(() => {
  state.email = "first@example.com"; state.token = "first-refresh";
  (globalThis as unknown as { googleTokens: Map<string, unknown> }).googleTokens.clear();
});
afterEach(() => { vi.unstubAllGlobals(); });
it("does not reuse an old account's token after an overlapping refresh", async () => {
  let release!: () => void;
  vi.mocked(refreshAccessToken).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ access_token: "old-access", expires_in: 3600, scope: "send" }); }));
  const old = accessToken("send", undefined, "first@example.com");
  await vi.waitFor(() => expect(release).toBeDefined());
  state.email = "second@example.com"; state.token = "second-refresh";
  expect(await accessToken("send", undefined, "second@example.com")).toBe("second-refresh-access");
  release(); await old;
  expect(await accessToken("send", undefined, "second@example.com")).toBe("second-refresh-access");
});
it("stops a send if the account switches while its token is refreshing", async () => {
  let release!: () => void;
  vi.mocked(refreshAccessToken).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ access_token: "old-access", expires_in: 3600, scope: "send" }); }));
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const result = expect(googleFetch("send", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", body: { raw: "synthetic" }, expectedEmail: "first@example.com" })).rejects.toThrow("connected account changed");
  await vi.waitFor(() => expect(release).toBeDefined());
  state.email = "second@example.com"; state.token = "second-refresh";
  release(); await result;
  expect(fetch).not.toHaveBeenCalled();
});
