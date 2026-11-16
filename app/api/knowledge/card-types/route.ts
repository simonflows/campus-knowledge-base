import { NextRequest, NextResponse } from "next/server";

import { canManageTypes } from "@/lib/auth";
import { getSessionUser } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import {
  createCardType,
  getAllCardTypes,
  getCustomCardCounts,
} from "@/lib/models";
import { mockCustomCardTypes } from "@/lib/mock-data";
import { cardTypeInputSchema } from "@/lib/validation/knowledge";

export async function GET() {
  const dbAvailable = await isStorageWritable();

  if (dbAvailable) {
    try {
      const [types, counts] = await Promise.all([
        getAllCardTypes(),
        getCustomCardCounts(),
      ]);

      return NextResponse.json(
        types.map((type) => ({
          ...type,
          cardCount: counts[type.id] ?? 0,
        }))
      );
    } catch (error) {
      console.error("Ошибка получения типов карточек:", error);
    }
  }

  return NextResponse.json(
    mockCustomCardTypes.map((type) => ({ ...type, cardCount: 0 }))
  );
}

export async function POST(request: NextRequest) {
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
