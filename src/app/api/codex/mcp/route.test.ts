import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ valid: false, fetch: vi.fn(async () => Response.json({ ok: true })) }));
vi.mock("@/lib/connector/codex", () => ({ verifyCodexToken: async () => state.valid }));
vi.mock("@/lib/connector/tools", () => ({ createDossierServer: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@modelcontextprotocol/server", () => ({ createMcpHandler: () => ({ fetch: state.fetch }) }));
import { POST } from "./route";
it("rejects missing credentials before MCP can read data", async () => {
 state.valid = false; state.fetch.mockClear();
 expect((await POST(new Request("http://127.0.0.1/api/codex/mcp", { method: "POST" }))).status).toBe(401);
 expect(state.fetch).not.toHaveBeenCalled();
});
it("refuses browser-origin calls even with a valid bearer token", async () => {
 state.valid = true; state.fetch.mockClear();
 expect((await POST(new Request("http://127.0.0.1/api/codex/mcp", { method: "POST", headers: { origin: "https://untrusted.example" } }))).status).toBe(403);
 expect(state.fetch).not.toHaveBeenCalled();
});
