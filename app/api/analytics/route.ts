import { NextRequest, NextResponse } from "next/server";

import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import { buildAnalyticsReport } from "@/lib/analytics";
import { getAllCardTypes, getCanonicalKnowledgeCards } from "@/lib/models";
import { analyticsQuerySchema } from "@/lib/validation/analytics";

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

  const data = await Promise.all([
    getCanonicalKnowledgeCards(), getAllCardTypes(),
  ]).catch(() => null);
  if (!data) return unavailableStorageResponse();
  const [cards, types] = data;
  return NextResponse.json(buildAnalyticsReport(parsed.data.query, cards, types));
}
