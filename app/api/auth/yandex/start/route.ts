import { NextRequest, NextResponse } from "next/server";
import { accountJson } from "@/lib/account-server";
import { deploymentFreezeResponse } from "@/lib/deployment-freeze";
import { SESSION_COOKIE, verifySameOrigin } from "@/lib/auth-server";
import { createYandexFlow, oauthCookieOptions, YANDEX_OAUTH_COOKIE, yandexOAuthConfig } from "@/lib/yandex-oauth";

export async function POST(request: NextRequest) {
  if (process.env.CANON_DEPLOY_FREEZE_WRITES === "true") return deploymentFreezeResponse();
  if (!verifySameOrigin(request)) return accountJson({ error: "Недопустимый источник запроса." }, 403);
  const config = yandexOAuthConfig();
  if (!config) return accountJson({ error: "Вход через Яндекс временно недоступен." }, 503);
  const flow = createYandexFlow(config, request.nextUrl.searchParams.get("next"), request.cookies.get(SESSION_COOKIE)?.value);
  const response = NextResponse.redirect(flow.authorizationUrl, 303);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.cookies.set(YANDEX_OAUTH_COOKIE, flow.cookie, oauthCookieOptions);
  return response;
}
