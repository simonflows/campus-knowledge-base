import { NextRequest, NextResponse } from "next/server";

import { canManageTypes } from "@/lib/auth";
import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import {
  countKnowledgeCardsByCustomType,
  deleteCardType,
  getCardTypeById,
  updateCardType,
} from "@/lib/models";
import { cardTypeUpdateSchema } from "@/lib/validation/knowledge";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function fieldsChanged(
  current: {
    id: string;
    name: string;
    type: string;
    required: boolean;
    options: string[];
  }[],
  next: {
    id: string;
    name: string;
    type: string;
    required: boolean;
    options: string[];
  }[]
): boolean {
  const normalize = (fields: typeof current) =>
    fields.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      required: field.required,
      options: field.options,
    }));

  return JSON.stringify(normalize(current)) !== JSON.stringify(normalize(next));
}

async function getAdminDeniedResponse() {
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

  return null;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  if (!verifySameOrigin(request)) {
    return NextResponse.json({ error: "Недопустимый источник запроса" }, { status: 403 });
  }
  const denied = await getAdminDeniedResponse();

  if (denied) return denied;

  const dbAvailable = await isStorageWritable();

  if (!dbAvailable) {
    return NextResponse.json(
      { error: "База данных недоступна в статическом режиме" },
      { status: 503 }
    );
  }

  const { id } = await context.params;

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Некорректный JSON в теле запроса" },
      { status: 400 }
    );
  }

  const parsed = cardTypeUpdateSchema.safeParse(body);

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
    const current = await getCardTypeById(id);

    if (!current) {
      return NextResponse.json(
        { error: "Тип карточки не найден" },
        { status: 404 }
      );
    }

    if (parsed.data.fields) {
      const cardCount = await countKnowledgeCardsByCustomType(id);

      if (cardCount > 0 && fieldsChanged(current.fields, parsed.data.fields)) {
        return NextResponse.json(
          {
            error: `По типу «${current.name}» уже сохранено ${cardCount} карточек. Если переименовать или удалить поля, значения в существующих карточках перестанут отображаться. Сначала удалите карточки этого типа или создайте новый тип.`,
            cardCount,
          },
          { status: 409 }
        );
      }
    }

    const updated = await updateCardType(id, parsed.data);

    if (!updated) {
      return NextResponse.json(
        { error: "Тип карточки не найден" },
        { status: 404 }
      );
    }

    const cardCount = await countKnowledgeCardsByCustomType(id);

    return NextResponse.json({ ...updated, cardCount });
  } catch (error) {
    console.error("Ошибка обновления типа карточки:", error);
    return NextResponse.json(
      { error: "Ошибка обновления типа карточки" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  if (!verifySameOrigin(request)) {
    return NextResponse.json({ error: "Недопустимый источник запроса" }, { status: 403 });
  }
  const denied = await getAdminDeniedResponse();

  if (denied) return denied;

  const dbAvailable = await isStorageWritable();

  if (!dbAvailable) {
    return NextResponse.json(
      { error: "База данных недоступна в статическом режиме" },
      { status: 503 }
    );
  }

  const { id } = await context.params;

  try {
    const current = await getCardTypeById(id);

    if (!current) {
      return NextResponse.json(
        { error: "Тип карточки не найден" },
        { status: 404 }
      );
    }

    const cardCount = await countKnowledgeCardsByCustomType(id);

    if (cardCount > 0) {
      return NextResponse.json(
        {
          error: `Нельзя удалить тип «${current.name}»: по нему сохранено ${cardCount} карточек. Сначала удалите эти карточки.`,
          cardCount,
        },
        { status: 409 }
      );
    }

    await deleteCardType(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Ошибка удаления типа карточки:", error);
    return NextResponse.json(
      { error: "Ошибка удаления типа карточки" },
      { status: 500 }
    );
  }
}
