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
  signSessionToken,
  verifyAdminPin,
  verifySameOrigin,
} from "@/lib/auth-server";
import { authenticatePilot, demoLoginEnabled, getSessionIdentity, pilotLoginReady } from "@/lib/pilot-auth";
import { loginSchema } from "@/lib/validation/access";

export async function GET() {
  const user = await getSessionUser();

  return NextResponse.json({
    user,
    adminPinRequired: demoLoginEnabled() && isAdminPinRequired(),
    demoLogin: demoLoginEnabled(),
  });
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
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Некорректный JSON в теле запроса" },
      { status: 400 }
    );
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

  clearLoginFailures(accountKey);
  const response = NextResponse.json({ user }, { headers: { "Cache-Control": "private, no-store" } });
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

  const response = NextResponse.json({ user: null });
  response.cookies.set(SESSION_COOKIE, "", {
    ...sessionCookieOptions,
    maxAge: 0,
  });
  return response;
}
