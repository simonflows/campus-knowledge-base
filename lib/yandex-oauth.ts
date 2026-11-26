import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { yandexAccountsEnabled } from "./account-directory";
import { AccountError } from "./account-service";
import { accountEmailSchema, accountReturnPath, accountReturnPathSchema } from "./account-validation";
import { readYandexJson } from "./yandex-metadata-iam";

const authorizeEndpoint = "https://oauth.yandex.ru/authorize";
const tokenEndpoint = "https://oauth.yandex.ru/token";
const profileEndpoint = "https://login.yandex.ru/info?format=json";
const seconds = () => Math.floor(Date.now() / 1000);
export const YANDEX_OAUTH_COOKIE = "__Host-vibecraft-oauth";
export const oauthCookieOptions = {
  httpOnly: true, sameSite: "lax" as const, secure: true, path: "/", maxAge: 8 * 60,
};

export function yandexOAuthConfig() {
  if (!yandexAccountsEnabled()) return null;
  const clientId = process.env.YANDEX_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.YANDEX_OAUTH_CLIENT_SECRET?.trim();
  const signingSecret = process.env.SESSION_SECRET;
  const basePath = process.env.BASE_PATH || "";
  if (!clientId || !/^[a-zA-Z0-9_-]{1,128}$/.test(clientId) || !clientSecret ||
      !signingSecret || signingSecret.length < 32 ||
      (basePath && !/^(?:\/[a-zA-Z0-9_-]+)+$/.test(basePath))) return null;
  try {
    const url = new URL(process.env.CAMPUS_PUBLIC_ORIGIN ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return {
      clientId, clientSecret, signingSecret, basePath, origin: url.origin,
      redirectUri: url.origin + basePath + "/api/auth/yandex/callback",
    };
  } catch {
    return null;
  }
}

type OAuthConfig = NonNullable<ReturnType<typeof yandexOAuthConfig>>;
const nonce = z.string().regex(/^[a-zA-Z0-9_-]{43}$/);
const flowSchema = z.object({
  state: nonce,
  verifier: nonce,
  expiresAt: z.number().int(),
  next: accountReturnPathSchema,
  binding: nonce,
});
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
function sign(config: OAuthConfig, payload: string) {
  return createHmac("sha256", config.signingSecret)
    .update(JSON.stringify(["yandex-oauth-v1", config.clientId, config.redirectUri, payload]))
    .digest("base64url");
}
function equal(left: string, right: string) {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function createYandexFlow(config: OAuthConfig, next: unknown, browserSession?: string, now = seconds()) {
  const flow = {
    state: randomBytes(32).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"),
    expiresAt: now + oauthCookieOptions.maxAge,
    next: accountReturnPath(next),
    binding: hash(browserSession ?? ""),
  };
  const payload = Buffer.from(JSON.stringify(flow)).toString("base64url");
  const authorizationUrl = new URL(authorizeEndpoint);
  authorizationUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "login:info login:email",
    state: flow.state,
    code_challenge: hash(flow.verifier),
    code_challenge_method: "S256",
    force_confirm: "yes",
  }).toString();
  return { authorizationUrl, cookie: payload + "." + sign(config, payload) };
}

export function readYandexFlow(
  config: OAuthConfig, cookie: string | undefined, state: string | null, browserSession?: string, now = seconds(),
) {
  if (!state || !nonce.safeParse(state).success || !cookie || cookie.length > 1024) return null;
  const match = /^([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]{43})$/.exec(cookie);
  if (!match || !equal(match[2], sign(config, match[1]))) return null;
  try {
    const parsed = flowSchema.safeParse(JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")));
    if (!parsed.success || parsed.data.expiresAt <= now || !equal(parsed.data.state, state) ||
        !equal(parsed.data.binding, hash(browserSession ?? ""))) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export const yandexCodeSchema = z.string().regex(/^[\x21-\x7e]{1,512}$/);
const tokenErrorSchema = z.object({ error: z.string() });
const credentialsSchema = z.object({ access_token: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/) });
const profileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
  client_id: z.string(),
  real_name: z.string().optional(),
  display_name: z.string().optional(),
  default_email: z.string().optional(),
});
function yandexUnavailable() {
  return new AccountError("Вход через Яндекс временно недоступен. Повторите позже.", 503);
}

export async function exchangeYandexCode(config: OAuthConfig, code: string, verifier: string, fetcher = fetch) {
  try {
    const signal = AbortSignal.timeout(6500);
    const options = { cache: "no-store", redirect: "error", signal } as const;
    const tokenResponse = await fetcher(tokenEndpoint, {
      ...options,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(config.clientId + ":" + config.clientSecret).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: config.redirectUri,
      }),
    });
    if (!tokenResponse.ok) {
      if (tokenResponse.status === 400) {
        const providerError = tokenErrorSchema.safeParse(await readYandexJson(tokenResponse, 4096, signal));
        if (providerError.success && providerError.data.error === "invalid_grant")
          throw new AccountError("Ссылка входа больше не действует. Начните вход снова.", 400);
      } else {
        void tokenResponse.body?.cancel().catch(() => undefined);
      }
      throw yandexUnavailable();
    }
    const credentials = credentialsSchema.parse(await readYandexJson(tokenResponse, 16_384, signal));
    const profileResponse = await fetcher(profileEndpoint, {
      ...options, headers: { Authorization: "OAuth " + credentials.access_token },
    });
    if (!profileResponse.ok) {
      void profileResponse.body?.cancel().catch(() => undefined);
      throw yandexUnavailable();
    }
    const profile = profileSchema.parse(await readYandexJson(profileResponse, 16_384, signal));
    if (profile.client_id !== config.clientId) throw yandexUnavailable();
    const name = (profile.real_name?.trim() || profile.display_name?.trim() || "")
      .replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 120) || "Автор Канона";
    const email = accountEmailSchema.safeParse(profile.default_email);
    return { subject: profile.id, name, ...(email.success ? { email: email.data } : {}) };
  } catch (error) {
    if (error instanceof AccountError) throw error;
    throw yandexUnavailable();
  }
}
