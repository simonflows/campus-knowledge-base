import { NextRequest, NextResponse } from "next/server";

/** A server-only release switch; client headers, cookies and roles cannot change it. */
export function proxy(request: NextRequest) {
  if (
    process.env.CANON_DEPLOY_FREEZE_WRITES === "true" &&
    request.nextUrl.pathname.startsWith("/api/") &&
    !["GET", "HEAD", "OPTIONS"].includes(request.method)
  ) {
    return NextResponse.json(
      {
        error:
          "Идёт короткое обновление. Повторите сохранение через несколько секунд.",
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": "15",
          "X-Canon-Deploy-Freeze": "writes",
        },
      }
    );
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
