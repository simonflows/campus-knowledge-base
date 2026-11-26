import { NextResponse } from "next/server";

/** Provider callbacks can write through GET, so HTTP method alone is insufficient. */
export function isDeploymentWriter(pathname: string, method: string) {
  return pathname.startsWith("/api/") && (
    !["GET", "HEAD", "OPTIONS"].includes(method) ||
    (pathname === "/api/auth/yandex/callback" && ["GET", "HEAD"].includes(method))
  );
}

export function deploymentFreezeResponse() {
  return NextResponse.json(
    { error: "Идёт короткое обновление. Повторите действие через несколько секунд." },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Retry-After": "15",
        "X-Canon-Deploy-Freeze": "writes",
      },
    },
  );
}
