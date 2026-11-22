import { NextRequest, NextResponse } from "next/server";

import { canManageTypes } from "@/lib/auth";
import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import {
  CardTypeInUseError,
  countKnowledgeCardsByCustomType,
  deleteCardType,
  getCardTypeById,
  updateCardType,
} from "@/lib/models";
import { cardTypeUpdateSchema } from "@/lib/validation/knowledge";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function typeWriteFailure(error: unknown) {
  if (error instanceof CardTypeInUseError) {
    return NextResponse.json({
      error: "Тип используют сохранённые карточки. Сохраните поля или создайте новый тип.",
      cardCount: error.count,
    }, { status: 409 });
  }
  if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
    return NextResponse.json({
      error: "Тип карточки изменился. Обновите страницу и повторите действие.",
    }, { status: 409 });
  }
  return unavailableStorageResponse();
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

    const updated = await updateCardType(id, parsed.data, current.updatedAt);

    if (!updated) {
      return NextResponse.json(
        { error: "Тип карточки не найден" },
        { status: 404 }
      );
    }

    const cardCount = await countKnowledgeCardsByCustomType(id);

    return NextResponse.json({ ...updated, cardCount });
  } catch (error) {
    return typeWriteFailure(error);
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

    await deleteCardType(id, current.updatedAt);

    return NextResponse.json({ success: true });
  } catch (error) {
    return typeWriteFailure(error);
  }
}
