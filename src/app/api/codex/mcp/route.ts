import { createMcpHandler } from "@modelcontextprotocol/server";
import { verifyCodexToken } from "@/lib/connector/codex";
import { createDossierServer } from "@/lib/connector/tools";
import { env } from "@/lib/env";
const handler = createMcpHandler(() => createDossierServer(env.DOSSIER_PUBLIC_URL ?? "http://127.0.0.1:3401", "codex-chat"));
export async function POST(request: Request) {
  const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!(await verifyCodexToken(token))) return Response.json({ error: "unauthorized" }, { status: 401 });
  // The local stdio bridge has no browser Origin. Refuse browser-originated calls.
  if (request.headers.has("origin")) return new Response(null, { status: 403 });
  if (Number(request.headers.get("content-length") ?? 0) > 1_000_000) return new Response(null, { status: 413 });
  return handler.fetch(request, { authInfo: { token: token!, clientId: "codex-local", scopes: ["dossier"] } });
}
