import { NextRequest, NextResponse } from "next/server";

import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import { buildAnalyticsReport } from "@/lib/analytics";
import {
  getAllCardTypes,
  getAllKnowledgeCards,
  getCanonicalKnowledgeCards,
} from "@/lib/models";
import { buildStrategyAnalyticsReport } from "@/lib/strategy-analytics";
import { analyticsRequestSchema } from "@/lib/validation/analytics";
import { assistAnalytics, authorizeFlashAssist } from "@/lib/flash-assist";
import { buildAnalyticsWithAi } from "@/lib/canon-analytics-ai";
import { JsonBodyError, readBoundedJson } from "@/lib/http-json";
import { readRouteSession } from "@/lib/account-route-session";

async function loadAnalyticsSnapshot() {
  const [cards, types] = await Promise.all([
    getCanonicalKnowledgeCards(),
    getAllCardTypes(),
  ]);
  return { cards, types };
}

export async function POST(request: NextRequest) {
  const session = await readRouteSession();
  if (session.response) return session.response;
  const user = session.user;
  if (!user)
    return NextResponse.json(
      {
        error:
          "Для аналитики войдите в аккаунт сотрудника. Локальные примеры доступны в демо.",
      },
      { status: 401 }
    );
  if (user.role === "guest")
    return NextResponse.json(
      {
        error:
          "Гостевой доступ позволяет читать карточки и проверять текст. Аналитика доступна сотрудникам.",
      },
      { status: 403 }
    );
  let body: unknown;

  try {
    body = await readBoundedJson(request, 16 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: "Некорректный JSON в теле запроса" },
      { status: error instanceof JsonBodyError ? error.status : 400 }
    );
  }

  const parsed = analyticsRequestSchema.safeParse(body);

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

  if (parsed.data.mode === "strategy") {
    const cards = await getAllKnowledgeCards(request.signal).catch(() => null);
    if (!cards) return unavailableStorageResponse();
    const report = buildStrategyAnalyticsReport(parsed.data, cards);
    const headers = { "Cache-Control": "private, no-store" };
    return report
      ? NextResponse.json(report, { headers })
      : NextResponse.json(
          {
            error:
              "Документ или фильтр недоступен. Обновите список документов.",
          },
          { status: 404, headers }
        );
  }

  const { query, flashAssist, useAi } = parsed.data;
  const account =
    flashAssist || useAi ? await authorizeFlashAssist(request) : null;
  if (account instanceof Response) return account;
  const snapshot = await loadAnalyticsSnapshot().catch(() => null);
  if (!snapshot) return unavailableStorageResponse();
  if (useAi && account) {
    const report = await buildAnalyticsWithAi({
      request,
      accountId: account,
      query,
      snapshot,
      loadCurrent: loadAnalyticsSnapshot,
    });
    if (!report) return unavailableStorageResponse();
    return NextResponse.json(report, {
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  const report = buildAnalyticsReport(query, snapshot.cards, snapshot.types);
  return NextResponse.json(
    account
      ? {
          ...report,
          flashAssist: await assistAnalytics(
            request,
            account,
            query,
            snapshot.types
          ).catch(() => ({ status: "failed" })),
        }
      : report,
    account ? { headers: { "Cache-Control": "no-store" } } : undefined
  );
}
