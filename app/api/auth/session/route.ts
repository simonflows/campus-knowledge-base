import { NextRequest, NextResponse } from "next/server";

import { getDemoAccount, toSessionUser } from "@/lib/auth";
import {
  checkLoginRateLimit,
  clearLoginFailures,
  getClientIp,
  getSessionUser,
  isAdminPinRequired,
  LEGACY_SESSION_COOKIE,
  recordFailedLogin,
  SESSION_COOKIE,
  sessionCookieOptions,
  signSessionToken,
  verifyAdminPin,
  verifySameOrigin,
} from "@/lib/auth-server";
import { loginSchema } from "@/lib/validation/access";

export async function GET() {
  const user = await getSessionUser();

  return NextResponse.json({
    user,
    adminPinRequired: isAdminPinRequired(),
  });
}

export async function POST(request: NextRequest) {
  if (!verifySameOrigin(request)) {
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос авторизации" },
      { status: 403 }
    );
  }

  const clientKey = getClientIp(request);
  const rate = checkLoginRateLimit(clientKey);
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: `Слишком много неверных попыток входа. Повторите через ${rate.retryAfterSeconds} сек.`,
      },
      { status: 429 }
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

  const account = getDemoAccount(parsed.data.accountId);

  if (!account) {
    return NextResponse.json(
      { error: "Демонстрационный аккаунт не найден" },
      { status: 404 }
    );
  }

  if (account.role === "admin" && isAdminPinRequired()) {
    if (!verifyAdminPin(parsed.data.pin)) {
      recordFailedLogin(clientKey);
      return NextResponse.json(
        {
          error: parsed.data.pin
            ? "Неверный ПИН-код администратора"
            : "Для входа под Администратором канона требуется ПИН-код (ADMIN_ACCESS_PIN)",
          requiresPin: true,
        },
        { status: 401 }
      );
    }
  }

  clearLoginFailures(clientKey);
  const response = NextResponse.json({ user: toSessionUser(account) });
  response.cookies.set(
    SESSION_COOKIE,
    signSessionToken(account.id),
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
  response.cookies.set(LEGACY_SESSION_COOKIE, "", {
    ...sessionCookieOptions,
    secure: true,
    maxAge: 0,
  });

  return response;
}
