import { isIP } from "node:net";
import crypto from "node:crypto";
import { cookies } from "next/headers";

import type { SessionUser } from "./auth";
import { demoLoginEnabled, getSessionIdentity } from "./pilot-auth";

export const SESSION_COOKIE = "__Host-vibecraft-session";
export const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;
export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: true,
  path: "/",
  maxAge: SESSION_LIFETIME_SECONDS,
};
const demoRuntime = globalThis as typeof globalThis & { campusDemoSigningKey?: Buffer };

function signingKey() {
  const configured = process.env.SESSION_SECRET;
  if (configured && configured.length >= 32) return configured;
  return demoLoginEnabled() && process.env.NODE_ENV !== "production" ? (demoRuntime.campusDemoSigningKey ??= crypto.randomBytes(32)) : null;
}

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const failedLoginBuckets = new Map<
  string,
  { count: number; resetAt: number }
>();

let nextLoginCleanup = 0;

function loginBucketKey(key: string, now: number) {
  if (now >= nextLoginCleanup) {
    for (const [bucket, failure] of failedLoginBuckets) {
      if (now >= failure.resetAt) failedLoginBuckets.delete(bucket);
    }
    nextLoginCleanup = now + 60_000;
  }
  // The account directory already bounds the number of account buckets.
  if (key.startsWith("account:") || key === "unknown-account" || failedLoginBuckets.has(key)) return key;
  return failedLoginBuckets.size >= 4096 ? "overflow" : key;
}

export function getClientIp(request: Request): string | null {
  // Enable only behind an ingress that overwrites client-supplied forwarding headers.
  if (process.env.CAMPUS_TRUST_PROXY !== "true") return null;
  const address = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return address && isIP(address) ? address : null;
}

export function checkLoginRateLimit(key: string): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  const bucket = loginBucketKey(key, now);
  const entry = failedLoginBuckets.get(bucket);
  if (!entry) return { allowed: true, retryAfterSeconds: 0 };

  if (now >= entry.resetAt) {
    failedLoginBuckets.delete(bucket);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (entry.count >= MAX_LOGIN_FAILURES) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordFailedLogin(key: string): void {
  const now = Date.now();
  const bucket = loginBucketKey(key, now);
  const current = failedLoginBuckets.get(bucket);
  if (!current || now >= current.resetAt) {
    failedLoginBuckets.set(bucket, {
      count: 1,
      resetAt: now + LOGIN_WINDOW_MS,
    });
    return;
  }

  current.count += 1;
}

export function clearLoginFailures(key: string): void {
  failedLoginBuckets.delete(key);
}

export function verifySameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return !site || site === "same-origin" || site === "none";
  try {
    const supplied = new URL(origin);
    if (!["http:", "https:"].includes(supplied.protocol) || supplied.origin !== origin) return false;
    if (process.env.CAMPUS_PUBLIC_ORIGIN) {
      return supplied.origin === new URL(process.env.CAMPUS_PUBLIC_ORIGIN).origin;
    }
    const destination = new URL(request.url);
    const host = request.headers.get("host");
    return supplied.protocol === destination.protocol && supplied.host === (host?.toLowerCase() ?? destination.host);
  } catch {
    return false;
  }
}

function computeSignature(payload: string, binding: string) {
  const key = signingKey();
  if (!key) return null;
  return crypto.createHmac("sha256", key).update(JSON.stringify([payload, binding])).digest("hex");
}

export function signSessionToken(id: string, now = Date.now()): string {
  const identity = getSessionIdentity(id);
  const expires = Math.floor(now / 1000) + SESSION_LIFETIME_SECONDS;
  const payload = `v2.${id}.${expires}`;
  const signature = identity && computeSignature(payload, identity.binding);
  if (!signature) throw new Error("Настройте учётные записи и SESSION_SECRET");
  return `${payload}.${signature}`;
}

export function verifySessionToken(token?: string | null, now = Date.now()): string | null {
  if (!token || token.length > 256) return null;
  const match = /^v2\.([a-z0-9_-]+)\.(\d{1,12})\.([0-9a-f]{64})$/.exec(token);
  if (!match) return null;
  const [, id, expires, signature] = match;
  if (Number(expires) <= Math.floor(now / 1000)) return null;
  const identity = getSessionIdentity(id);
  const expected = identity && computeSignature(`v2.${id}.${expires}`, identity.binding);
  if (!expected || !crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) return null;
  return id;
}

export function isAdminPinRequired(): boolean {
  return Boolean(process.env.ADMIN_ACCESS_PIN?.trim());
}

export function verifyAdminPin(pin: string | undefined): boolean {
  const configured = process.env.ADMIN_ACCESS_PIN?.trim();
  if (!configured) return true;
  if (!pin) return false;

  const a = Buffer.from(pin.trim(), "utf8");
  const b = Buffer.from(configured, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const id = verifySessionToken(store.get(SESSION_COOKIE)?.value);
  return id ? getSessionIdentity(id)?.user ?? null : null;
}
