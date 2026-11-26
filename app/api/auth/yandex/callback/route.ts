import { NextRequest, NextResponse } from "next/server";
import { accountFailure, accountJson, accountService } from "@/lib/account-server";
import { AccountError } from "@/lib/account-service";
import { deploymentFreezeResponse } from "@/lib/deployment-freeze";
import {
  getClientIp, revokeAccountSession, SESSION_COOKIE, sessionCookieOptions, signAccountSessionToken,
} from "@/lib/auth-server";
import {
  exchangeYandexCode, oauthCookieOptions, readYandexFlow, YANDEX_OAUTH_COOKIE, yandexCodeSchema, yandexOAuthConfig,
} from "@/lib/yandex-oauth";

function finish(response: NextResponse) {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.cookies.set(YANDEX_OAUTH_COOKIE, "", { ...oauthCookieOptions, maxAge: 0 });
  return response;
}

export async function GET(request: NextRequest) {
  if (process.env.CANON_DEPLOY_FREEZE_WRITES === "true") return deploymentFreezeResponse();
  const config = yandexOAuthConfig();
  if (!config) return finish(accountJson({ error: "Вход через Яндекс временно недоступен." }, 503));
  const loginUrl = new URL(config.basePath + "/login", config.origin);
  function retry(reason: "invalid" | "cancelled") {
    loginUrl.searchParams.set("oauth", reason);
    return finish(NextResponse.redirect(loginUrl, 303));
  }

  const query = request.nextUrl.searchParams;
  const cookie = request.cookies.get(YANDEX_OAUTH_COOKIE)?.value;
  const browserSession = request.cookies.get(SESSION_COOKIE)?.value;
  const flow = readYandexFlow(config, cookie, query.get("state"), browserSession);
  if (!flow || ["state", "code", "error"].some(key => query.getAll(key).length > 1)) return retry("invalid");
  const code = yandexCodeSchema.safeParse(query.get("code"));
  if (!query.has("error") && !code.success) return retry("invalid");

  try {
    if (!(await accountService.consumeYandexFlow(flow.state, flow.expiresAt, getClientIp(request))))
      return retry("invalid");
    if (query.get("error") === "access_denied" && !query.has("code")) return retry("cancelled");
    if (query.has("error")) return finish(accountJson({ error: "Вход через Яндекс временно недоступен." }, 503));
    if (!code.success) return retry("invalid");

    const profile = await exchangeYandexCode(config, code.data, flow.verifier);
    const { token, user } = await accountService.loginYandex(profile);
    const signed = signAccountSessionToken(token);
    await revokeAccountSession(browserSession);
    const next = user.role === "author" && ["/work", "/requests"].includes(flow.next) ? "/knowledge" : flow.next;
    const response = NextResponse.redirect(new URL(config.basePath + next, config.origin), 303);
    response.cookies.set(SESSION_COOKIE, signed, sessionCookieOptions);
    return finish(response);
  } catch (error) {
    if (error instanceof AccountError && error.status === 400) return retry("invalid");
    return finish(accountFailure(error));
  }
}
