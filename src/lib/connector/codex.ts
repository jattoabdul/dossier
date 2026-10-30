import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

const KEY = "codexTokenHash";
function tokenHash(token: string) { return createHmac("sha256", `${env.DOSSIER_SECRET}:${env.DOSSIER_PASSWORD}`).update(token).digest("hex"); }
export async function codexEnabled() {
  return env.DOSSIER_DEMO_MODE !== "on" && Boolean((await prisma.setting.findUnique({ where: { key: KEY } }))?.value);
}
export async function verifyCodexToken(token?: string) {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) || env.DOSSIER_DEMO_MODE === "on") return false;
  const stored = (await prisma.setting.findUnique({ where: { key: KEY } }))?.value;
  if (!stored || !/^[a-f0-9]{64}$/.test(stored)) return false;
  return timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(tokenHash(token), "hex"));
}
export async function configureCodex(on: boolean) {
  const filename = env.DOSSIER_CODEX_BRIDGE_FILE;
  if (!filename || env.DOSSIER_DEMO_MODE === "on") throw new Error("Set up a local personal instance first.");
  if (!on) {
    await prisma.setting.deleteMany({ where: { key: KEY } });
    await unlink(filename).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    return;
  }
  const origin = new URL(env.DOSSIER_PUBLIC_URL ?? "http://127.0.0.1:3401");
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") throw new Error("The local Codex connector requires a loopback address.");
  const token = randomBytes(32).toString("base64url");
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ url: `${origin.origin}/api/codex/mcp`, token }), { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: tokenHash(token) }, update: { value: tokenHash(token) } });
    await rename(temp, filename);
  } finally { await unlink(temp).catch(() => {}); }
}
