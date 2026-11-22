import { NextResponse } from "next/server";

import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { getEditorial } from "@/lib/editorial-models";
import { isStorageWritable } from "@/lib/db";
import { syncArticleRecord } from "@/lib/disk-sync-service";
import { getArticleById } from "@/lib/models";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  if (!verifySameOrigin(_request))
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос" },
      { status: 403 }
    );
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json(
      { error: "Войдите под демонстрационным аккаунтом" },
      { status: 401 }
    );
  }

  if (user.role === "guest") {
    return NextResponse.json(
      { error: "Гость не может запускать выгрузку на Яндекс Диск" },
      { status: 403 }
    );
  }

  if (!(await isStorageWritable())) {
    return NextResponse.json(
      { error: "База данных недоступна в статическом режиме" },
      { status: 503 }
    );
  }

  const { id } = await context.params;
  let existing;
  try {
    existing = await getArticleById(id);
  } catch {
    return unavailableStorageResponse();
  }
  if (!existing)
    return NextResponse.json(
      { error: "Согласованная статья не найдена" },
      { status: 404 }
    );
  if (user.role !== "admin") {
    const draft = await getEditorial(
      existing.originalDraftId ?? id,
      user
    ).catch(() => null);
    if (!draft || draft.ownerId !== user.id)
      return NextResponse.json(
        { error: "Выгрузку запускает автор материала или координатор" },
        { status: 403 }
      );
  }

  try {
    const article = await syncArticleRecord(existing);

    if (!article) {
      return NextResponse.json({ error: "Статья не найдена" }, { status: 404 });
    }

    return NextResponse.json(article);
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    )
      return NextResponse.json(
        {
          error:
            "Согласованная редакция изменилась. Обновите материал и повторите.",
        },
        { status: 409 }
      );
    console.error("Ошибка повторной выгрузки статьи на Диск:", error);
    return NextResponse.json(
      { error: "Не удалось повторить выгрузку статьи" },
      { status: 500 }
    );
  }
}
