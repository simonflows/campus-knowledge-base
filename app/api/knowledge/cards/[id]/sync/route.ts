import { NextResponse } from "next/server";

import { canEditCard, visibleKnowledgeCard } from "@/lib/auth";
import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import { syncKnowledgeCardRecord } from "@/lib/disk-sync-service";
import { getCardStatus } from "@/lib/knowledge";
import { getKnowledgeCardById } from "@/lib/models";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  if (!verifySameOrigin(_request))
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос" },
      { status: 403 }
    );
  if (!(await isStorageWritable())) {
    return NextResponse.json(
      { error: "База данных недоступна в статическом режиме" },
      { status: 503 }
    );
  }

  const user = await getSessionUser();
  if (!user)
    return NextResponse.json(
      { error: "Войдите для повторной выгрузки" },
      { status: 401 }
    );
  const { id } = await context.params;
  let existing;
  try {
    existing = await getKnowledgeCardById(id);
  } catch {
    return unavailableStorageResponse();
  }

  if (!existing) {
    return NextResponse.json({ error: "Карточка не найдена" }, { status: 404 });
  }

  if (!canEditCard(user, existing)) {
    return NextResponse.json(
      {
        error:
          "Повторить выгрузку может владелец карточки или администратор канона",
      },
      { status: 403 }
    );
  }

  if (getCardStatus(existing) !== "approved") {
    return NextResponse.json(
      { error: "Черновик не выгружается на Диск до одобрения координатором" },
      { status: 409 }
    );
  }

  try {
    const card = await syncKnowledgeCardRecord(existing);

    if (!card) {
      return NextResponse.json(
        { error: "Карточка не найдена" },
        { status: 404 }
      );
    }

    return NextResponse.json(visibleKnowledgeCard(user, card));
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    )
      return NextResponse.json(
        {
          error:
            "Редакция или попытка выгрузки изменилась. Обновите карточку и повторите.",
        },
        { status: 409 }
      );
    console.error("Ошибка повторной выгрузки карточки на Диск:", error);
    return NextResponse.json(
      { error: "Не удалось повторить выгрузку карточки" },
      { status: 500 }
    );
  }
}
