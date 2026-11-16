import { NextRequest, NextResponse } from "next/server";

import { buildAnalyticsReport } from "@/lib/analytics";
import { isStorageWritable } from "@/lib/db";
import type { KnowledgeCard } from "@/lib/knowledge";
import { mockKnowledgeCards } from "@/lib/mock-data";
import { ensureKnowledgeSeed, getCanonicalKnowledgeCards } from "@/lib/models";
import { analyticsQuerySchema } from "@/lib/validation/analytics";

async function loadCards(): Promise<KnowledgeCard[]> {
  if (await isStorageWritable()) {
    try {
      await ensureKnowledgeSeed();
      return await getCanonicalKnowledgeCards();
    } catch (error) {
      console.error("Не удалось загрузить карточки для аналитики:", error);
    }
  }

  return mockKnowledgeCards;
}

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

  try {
    const cards = await loadCards();
    const report = buildAnalyticsReport(parsed.data.query, cards);

    return NextResponse.json(report);
  } catch (error) {
    console.error("Ошибка сборки аналитики:", error);
    return NextResponse.json(
      { error: "Не удалось собрать аналитику по базе" },
      { status: 500 }
    );
  }
}
