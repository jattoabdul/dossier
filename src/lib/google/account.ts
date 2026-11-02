import "server-only";

import { setTimeout as delay } from "node:timers/promises";

import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret, GOOGLE_TOKEN, SecretUnreadable } from "@/lib/secrets";

import { GoogleError } from "./errors";
import { googleClient, hasScopes, refreshAccessToken, revokeToken, type ScopeGroup } from "./oauth";

// The connected Google account (E15-1) and authorised calls to Google's APIs.
// Access tokens last an hour and are kept in memory only; the refresh token
// is stored encrypted.

const ACCOUNT_ID = "google";

/** What the settings screen may know about the connection: never a token. */
export type GoogleConnection =
  | { status: "not-configured" }
  | { status: "disconnected" }
  | {
      status: "connected";
      email: string;
      canSend: boolean;
      sendDisabled?: boolean;
      canRead: boolean;
      canUseCalendar: boolean;
      lastSyncAt: Date | null;
      syncProblem: string | null;
    };

export async function loadGoogleAccount() {
  return prisma.googleAccount.findUnique({ where: { id: ACCOUNT_ID } });
}

export async function googleConnection(): Promise<GoogleConnection> {
  if (!(await googleClient())) return { status: "not-configured" };
  const account = await loadGoogleAccount();
  if (!account) return { status: "disconnected" };
  return {
    status: "connected",
    email: account.email,
    canSend: hasScopes(account.scopes, "send"),
    sendDisabled: env.DOSSIER_EMAIL_SEND === "off" || env.DOSSIER_DEMO_MODE === "on",
    canRead: hasScopes(account.scopes, "read"),
    canUseCalendar: hasScopes(account.scopes, "calendar"),
    lastSyncAt: account.lastSyncAt,
    syncProblem: account.syncProblem,
  };
}

/**
 * Saves the account after a sign-in. Google only sends a refresh token on
 * first consent; adding scopes later keeps the stored one.
 */
export async function saveGoogleAccount({ email, refreshToken, scopes }: { email: string; refreshToken: string | undefined; scopes: string }) {
  const existing = await loadGoogleAccount();
  const refreshTokenEnc = refreshToken ? encryptSecret(GOOGLE_TOKEN, refreshToken) : existing?.refreshTokenEnc;
  if (!refreshTokenEnc) throw new GoogleError("rejected", "Google didn't give Dossier lasting access. Remove Dossier at myaccount.google.com/permissions and connect again.");
  // Another account replaces the old one, and its sync starts afresh.
  const sameAccount = existing?.email.toLowerCase() === email.toLowerCase();
  const merged = sameAccount ? [...new Set([...existing!.scopes.split(/\s+/), ...scopes.split(/\s+/)])].filter(Boolean).join(" ") : scopes;
  await prisma.googleAccount.upsert({
    where: { id: ACCOUNT_ID },
    create: { id: ACCOUNT_ID, email, refreshTokenEnc, scopes },
    update: { email, refreshTokenEnc, scopes: merged, ...(sameAccount ? {} : { historyId: null, lastSyncAt: null, syncProblem: null }) },
  });
  tokens.clear();
}

/** Disconnects: revokes the grant at Google and forgets the account. Mail already fetched stays. */
export async function disconnectGoogle(): Promise<void> {
  const account = await loadGoogleAccount();
  if (!account) return;
  try {
    await revokeToken(decryptSecret(GOOGLE_TOKEN, account.refreshTokenEnc));
  } catch (error) {
    if (!(error instanceof SecretUnreadable)) throw error;
  }
  await prisma.googleAccount.deleteMany({ where: { id: ACCOUNT_ID } });
  tokens.clear();
}

// On globalThis, so the dev server's hot reloads keep them.
const globalForTokens = globalThis as unknown as { googleTokens?: Map<string, { token: string; expires: number }> };
const tokens = (globalForTokens.googleTokens ??= new Map());

/** A valid access token for the connected account, refreshed when it's about to expire. */
export async function accessToken(group: ScopeGroup, signal?: AbortSignal, expectedEmail?: string): Promise<string> {
  const account = await loadGoogleAccount();
  if (!account) throw new GoogleError("not-connected", "Connect your Google account in Settings → Google first.");
  if (!hasScopes(account.scopes, group)) {
    throw new GoogleError("scope", "Dossier doesn't have that permission yet. Allow it in Settings → Google.");
  }
  if (expectedEmail && account.email.toLowerCase() !== expectedEmail.toLowerCase()) throw new GoogleError("not-connected", "The connected account changed. Review the message again.");
  const tokenKey = `${account.email.toLowerCase()}:${account.refreshTokenEnc}`;
  const cached = tokens.get(tokenKey);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  let refreshToken: string;
  try {
    refreshToken = decryptSecret(GOOGLE_TOKEN, account.refreshTokenEnc);
  } catch {
    throw new GoogleError("revoked", "The saved Google access can't be read, probably since DOSSIER_SECRET changed. Connect your Google account again.");
  }
  const answer = await refreshAccessToken(refreshToken, signal);
  tokens.set(tokenKey, { token: answer.access_token, expires: Date.now() + answer.expires_in * 1000 });
  return answer.access_token;
}

const MAX_BYTES = 30 * 1024 * 1024;

/**
 * Calls a Google API with the account's token and returns its JSON. Errors
 * become GoogleErrors; tokens never reach a message or the log.
 */
export async function googleFetch<T = unknown>(
  group: ScopeGroup,
  url: string | URL,
  { method = "GET", body, signal, expectedEmail }: { method?: string; body?: unknown; signal?: AbortSignal; expectedEmail?: string } = {},
): Promise<T> {
  const token = await accessToken(group, signal, expectedEmail);
  if (expectedEmail && (await loadGoogleAccount())?.email.toLowerCase() !== expectedEmail.toLowerCase()) throw new GoogleError("not-connected", "The connected account changed. Review the message again.");
  const timeout = AbortSignal.timeout(30_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const path = new URL(url).pathname;
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: requestSignal,
        cache: "no-store",
      });
    } catch {
      throw new GoogleError("unavailable", "Couldn't reach Google. Try again in a moment.");
    }
    if (response.status === 401) {
      tokens.clear();
      throw new GoogleError("revoked", "Google no longer accepts Dossier's access. Connect your Google account again.", `${path}: 401`);
    }
    // Gmail uses 403 for quota exhaustion as well as missing permissions.
    const reasons: string[] = [];
    if (response.status === 403) {
      const failure = await response.json().catch(() => null);
      for (const error of Array.isArray(failure?.error?.errors) ? failure.error.errors : []) {
        if (typeof error?.reason === "string") reasons.push(error.reason);
      }
    }
    const rateLimited = response.status === 429 || reasons.some((reason) => ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason));
    const quota = rateLimited || reasons.includes("dailyLimitExceeded");
    if (quota) {
      const retryAfter = response.headers.get("retry-after");
      const wait = retryAfter === null ? 1000 * 2 ** attempt : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
      // Never replay writes, including a send whose outcome may be unknown.
      // Long quota windows are left to the next scheduled check.
      if (rateLimited && method.toUpperCase() === "GET" && attempt < 3 && Number.isFinite(wait) && wait <= 10_000) {
        try {
          await delay(Math.max(1000, wait), undefined, { signal: requestSignal });
          continue;
        } catch {
          // Preserve the actionable quota message on cancellation/timeout.
        }
      }
      throw new GoogleError("quota", "Google asks Dossier to slow down. Try again in a few minutes.", `${path}: ${response.status}`);
    }
    if (response.status === 403) throw new GoogleError("scope", "Google refused that. Check the permissions in Settings → Google.", `${path}: 403`);
    break;
  }
  if (response.status === 404 || response.status === 410) {
    throw new GoogleError("unavailable", "Google couldn't find that. It may have been deleted.", `${path}: ${response.status}`, response.status);
  }
  if (!response.ok) throw new GoogleError("unavailable", "Google had a problem with that. Try again in a moment.", `${path}: HTTP ${response.status}`, response.status);
  if (response.status === 204) return undefined as T;
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new GoogleError("unavailable", "Google's answer was too big.", `${path}: ${length} bytes`);
  return (await response.json()) as T;
}
