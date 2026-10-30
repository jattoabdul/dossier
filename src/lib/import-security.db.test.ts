import { afterAll, expect, it, vi } from "vitest";
import { createTestClient, resetDatabase } from "@/test/db";
import { buildExport } from "@/lib/data-export";
import { importExport, parseExport } from "@/lib/data-import";
import { encryptApiKey } from "@/lib/ai/api-key";
import { resolveAiConfig } from "@/lib/ai/config";
import { OpenAICompatibleProvider } from "@/lib/ai/providers/openai-compatible";
import { settingsFromRows } from "@/lib/settings";

vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(40) } }));
vi.mock("@/lib/settings-data", () => ({ loadSettings: async () => ({}) }));
const db = createTestClient();
afterAll(async () => { vi.unstubAllGlobals(); await db.$disconnect(); });

it("a crafted export cannot redirect the preserved API key or enable automation", async () => {
  await resetDatabase(db);
  await db.setting.createMany({ data: [
    { key: "provider", value: "OPENAI" },
    { key: "baseUrl", value: "https://trusted.invalid/v1" },
    { key: "model", value: "synthetic" },
    { key: "apiKeyEnc", value: encryptApiKey("SYNTHETIC_REVIEW_KEY") },
  ] });
  const exported = await buildExport(db);
  expect(exported.apiKey).toBeUndefined();
  exported.settings.push({ key: "baseUrl", value: "https://attacker.invalid/v1" }, { key: "provider", value: "ANTHROPIC" }, { key: "agentEnabled", value: "true" });
  const parsed = parseExport(JSON.stringify(exported));
  if (!parsed.ok) throw new Error(parsed.error);
  await importExport(db, parsed.data);
  const config = resolveAiConfig(settingsFromRows(await db.setting.findMany()), {});
  const calls: {url: string; auth: string | null}[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), auth: new Headers(init?.headers).get("authorization") });
    return Response.json({ data: [{ id: "synthetic" }], object: "list" });
  });
  const provider = new OpenAICompatibleProvider("OPENAI", config.baseUrl, config.apiKey, config.model, 1000);
  await provider.listModels();
  expect(settingsFromRows(await db.setting.findMany()).agentEnabled).toBe(false);
  expect(calls).toEqual([{ url: "https://trusted.invalid/v1/models", auth: "Bearer SYNTHETIC_REVIEW_KEY" }]);
  // fetch was intercepted: no secret, request or profile left this process.
});
