import { NextResponse } from "next/server";
import { version } from "@/package.json";
export function GET() {
  const configured = process.env.CAMPUS_SOURCE_REVISION ?? "";
  return NextResponse.json({ version, revision: /^[0-9a-f]{40}$/.test(configured) ? configured : "local" }, { headers: { "Cache-Control": "no-store" } });
}
