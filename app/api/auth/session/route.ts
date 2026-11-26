import { NextRequest, NextResponse } from "next/server";

import { getDemoAccount, toSessionUser } from "@/lib/auth";
import {
  checkLoginRateLimit,
  clearLoginFailures,
  getClientIp,
  getSessionUser,
  isAdminPinRequired,
  recordFailedLogin,
  SESSION_COOKIE,
  sessionCookieOptions,
  revokeAccountSession,
  signAccountSessionToken,
  signSessionToken,
  verifyAdminPin,
  verifySameOrigin,
} from "@/lib/auth-server";
import { authenticatePilot, demoLoginEnabled, getSessionIdentity, pilotLoginReady } from "@/lib/pilot-auth";
import { loginSchema } from "@/lib/validation/access";
import { accountFailure, accountJson, accountService, readAccountBody, requireEmailAccounts } from "@/lib/account-server";
import { emailLoginSchema } from "@/lib/account-validation";

const sessionResponseOptions = { headers: { "Cache-Control": "private, no-store" } };

export async function GET() {
  try {
    const user = await getSessionUser();
    return NextResponse.json({
      user,
      adminPinRequired: demoLoginEnabled() && isAdminPinRequired(),
      demoLogin: demoLoginEnabled(),
    }, sessionResponseOptions);
  } catch (error) {
    return accountFailure(error);
  }
}

export async function POST(request: NextRequest) {
  if (!verifySameOrigin(request)) {
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос авторизации" },
      { status: 403 }
    );
  }

  let body: unknown;

  try {
    body = await readAccountBody(request);
  } catch (error) {
    return accountFailure(error);
  }

  if (body && typeof body === "object" && "method" in body && body.method === "email") {
    const parsed = emailLoginSchema.safeParse(body);
    if (!parsed.success) return accountJson({ error: parsed.error.issues[0]?.message ?? "Проверьте данные формы." }, 400);
    try {
      requireEmailAccounts();
      const { email, password } = parsed.data;
      const { token, user } = await accountService.login(email, password, getClientIp(request));
      const signed = signAccountSessionToken(token);
      await revokeAccountSession(request.cookies.get(SESSION_COOKIE)?.value);
      const response = accountJson({ user });
      response.cookies.set(SESSION_COOKIE, signed, sessionCookieOptions);
      return response;
    } catch (error) {
      return accountFailure(error);
    }
  }

  const parsed = loginSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? "Выберите аккаунт",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const demo = demoLoginEnabled();
  if ((!demo && !pilotLoginReady()) || (process.env.NODE_ENV === "production" && (process.env.SESSION_SECRET?.length ?? 0) < 32)) {
    return NextResponse.json({ error: "Вход временно недоступен. Обратитесь к администратору." }, { status: 503 });
  }
  const login = parsed.data.accountId;
  const known = getSessionIdentity(demo ? login : "pilot-" + login);
  const accountKey = known ? "account:" + known.user.id : "unknown-account";
  const ip = getClientIp(request);
  const keys = ip ? [accountKey, "ip:" + ip] : [accountKey];
  const delay = Math.max(...keys.map((key) => checkLoginRateLimit(key).retryAfterSeconds));
  if (delay) {
    return NextResponse.json(
      { error: `Слишком много неверных попыток входа. Повторите через ${delay} сек.` },
      { status: 429, headers: { "Retry-After": String(delay) } }
    );
  }
  const demoAccount = demo ? getDemoAccount(parsed.data.accountId) : null;
  const user = demoAccount ? toSessionUser(demoAccount) :
    !demo ? authenticatePilot(parsed.data.accountId, parsed.data.accessKey) : null;
  if (!user) {
    keys.forEach(recordFailedLogin);
    return NextResponse.json({ error: "Неверный логин или ключ доступа" }, { status: 401 });
  }
  if (demo && user.role === "admin" && isAdminPinRequired() && !verifyAdminPin(parsed.data.pin)) {
    keys.forEach(recordFailedLogin);
    return NextResponse.json({ error: "Введите ПИН-код администратора", requiresPin: true }, { status: 401 });
  }

  try {
    await revokeAccountSession(request.cookies.get(SESSION_COOKIE)?.value);
  } catch (error) {
    return accountFailure(error);
  }
  clearLoginFailures(accountKey);
  const response = NextResponse.json({ user }, sessionResponseOptions);
  response.cookies.set(
    SESSION_COOKIE,
    signSessionToken(user.id),
    sessionCookieOptions
  );

  return response;
}

export async function DELETE(request: NextRequest) {
  if (!verifySameOrigin(request)) {
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос завершения сессии" },
      { status: 403 }
    );
  }

  try {
    await revokeAccountSession(request.cookies.get(SESSION_COOKIE)?.value);
  } catch (error) {
    return accountFailure(error);
  }

  const response = NextResponse.json({ user: null }, sessionResponseOptions);
  response.cookies.set(SESSION_COOKIE, "", {
    ...sessionCookieOptions,
    maxAge: 0,
  });
  return response;
}
