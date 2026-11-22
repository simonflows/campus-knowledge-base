import { NextRequest, NextResponse } from "next/server";

import { canManageTypes, visibleKnowledgeCards } from "@/lib/auth";
import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import {
  createCardType,
  getAllCardTypes,
  customCardCounts,
  getAllKnowledgeCards,
} from "@/lib/models";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import { cardTypeInputSchema } from "@/lib/validation/knowledge";

export async function GET() {
  try {
    const [types, cards, user] = await Promise.all([
      getAllCardTypes(), getAllKnowledgeCards(), getSessionUser(),
    ]);
    const counts = customCardCounts(visibleKnowledgeCards(user, cards));
    return NextResponse.json(types.map((type) => ({
      ...type, cardCount: counts[type.id] ?? 0,
    })), { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return unavailableStorageResponse();
  }
}

export async function POST(request: NextRequest) {
  if (!verifySameOrigin(request)) {
    return NextResponse.json({ error: "Недопустимый источник запроса" }, { status: 403 });
  }
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json(
      { error: "Войдите под демонстрационным аккаунтом" },
      { status: 401 }
    );
  }

  if (!canManageTypes(user)) {
    return NextResponse.json(
      {
        error: "Конструктором типов управляет только администратор канона",
      },
      { status: 403 }
    );
  }

  const dbAvailable = await isStorageWritable();

  if (!dbAvailable) {
    return NextResponse.json(
      { error: "База данных недоступна в статическом режиме" },
      { status: 503 }
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

  const parsed = cardTypeInputSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Некорректные данные типа карточки",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  try {
    const cardType = await createCardType({
      ...parsed.data,
      id: crypto.randomUUID(),
    });

    return NextResponse.json({ ...cardType, cardCount: 0 }, { status: 201 });
  } catch (error) {
    console.error("Ошибка создания типа карточки:", error);
    return NextResponse.json(
      { error: "Ошибка создания типа карточки" },
      { status: 500 }
    );
  }
}
