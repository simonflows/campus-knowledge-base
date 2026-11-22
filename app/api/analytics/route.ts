import { NextRequest, NextResponse } from "next/server";

import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import { buildAnalyticsReport } from "@/lib/analytics";
import { getAllCardTypes, getCanonicalKnowledgeCards } from "@/lib/models";
import { analyticsQuerySchema } from "@/lib/validation/analytics";
import { assistAnalytics, authorizeFlashAssist } from "@/lib/flash-assist";

export async function POST(request: NextRequest) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Некорректный JSON в теле запроса" },
      { status: 400 }
    );
  }

  const parsed = analyticsQuerySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          parsed.error.issues[0]?.message ?? "Опишите запрос к базе данных",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const { query, flashAssist } = parsed.data;
  const account = flashAssist ? await authorizeFlashAssist(request) : null;
  if (account instanceof Response) return account;
  const data = await Promise.all([
    getCanonicalKnowledgeCards(), getAllCardTypes(),
  ]).catch(() => null);
  if (!data) return unavailableStorageResponse();
  const [cards, types] = data;
  const report = buildAnalyticsReport(query, cards, types);
  return NextResponse.json(
    account
      ? { ...report, flashAssist: await assistAnalytics(request, account, query, types) }
      : report,
    account ? { headers: { "Cache-Control": "no-store" } } : undefined,
  );
}
