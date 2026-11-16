import { NextResponse } from "next/server";

import { canEditCard } from "@/lib/auth";
import { getSessionUser } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import { retryKnowledgeCardSync } from "@/lib/disk-sync-service";
import { getCardStatus } from "@/lib/knowledge";
import { getKnowledgeCardById } from "@/lib/models";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  if (!(await isStorageWritable())) {
    return NextResponse.json(
      { error: "База данных недоступна в статическом режиме" },
      { status: 503 }
    );
  }

  const user = await getSessionUser();
  const { id } = await context.params;
  const existing = await getKnowledgeCardById(id);

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
    const card = await retryKnowledgeCardSync(id);

    if (!card) {
      return NextResponse.json(
        { error: "Карточка не найдена" },
        { status: 404 }
      );
    }

    return NextResponse.json(card);
  } catch (error) {
    console.error("Ошибка повторной выгрузки карточки на Диск:", error);
    return NextResponse.json(
      { error: "Не удалось повторить выгрузку карточки" },
      { status: 500 }
    );
  }
}
