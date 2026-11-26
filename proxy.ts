import { NextRequest, NextResponse } from "next/server";
import { deploymentFreezeResponse, isDeploymentWriter } from "./lib/deployment-freeze";

/** A server-only release switch; client headers, cookies and roles cannot change it. */
export function proxy(request: NextRequest) {
  if (
    process.env.CANON_DEPLOY_FREEZE_WRITES === "true" &&
    isDeploymentWriter(request.nextUrl.pathname, request.method)
  ) {
    return deploymentFreezeResponse();
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
