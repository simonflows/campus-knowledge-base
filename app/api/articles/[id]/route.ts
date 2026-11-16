import { NextRequest, NextResponse } from "next/server";

import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import { syncArticleRecord } from "@/lib/disk-sync-service";
import { getUniversityById } from "@/lib/knowledge";
import { getArticleById, updateArticle } from "@/lib/models";
import { saveArticleInputSchema } from "@/lib/validation/articles";

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, context: RouteContext) {
  if (!verifySameOrigin(request)) {
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос" },
      { status: 403 }
    );
  }

  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json(
      { error: "Войдите под демонстрационным аккаунтом для изменения статей" },
      { status: 401 }
    );
  }

  if (user.role === "guest") {
    return NextResponse.json(
      { error: "Гость не может изменять статьи в библиотеке канона" },
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
  const existing = await getArticleById(id);

  if (!existing) {
    return NextResponse.json({ error: "Статья не найдена" }, { status: 404 });
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

  const parsed = saveArticleInputSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Проверьте статью перед сохранением",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  if (!getUniversityById(parsed.data.universityId)) {
    return NextResponse.json(
      { error: "Выберите вуз из списка резидентов" },
      { status: 400 }
    );
  }

  if (
    user.role !== "admin" &&
    (user.role === "university_owner" || user.role === "university_pr") &&
    user.universityId &&
    (existing.universityId !== user.universityId ||
      parsed.data.universityId !== user.universityId)
  ) {
    return NextResponse.json(
      {
        error:
          "Представители вуза могут редактировать только статьи своего университета",
      },
      { status: 403 }
    );
  }

  try {
    const updated = await updateArticle(id, parsed.data);

    if (!updated) {
      return NextResponse.json({ error: "Статья не найдена" }, { status: 404 });
    }

    const article = await syncArticleRecord(updated).catch((error) => {
      console.error("Ошибка выгрузки обновлённой статьи на Диск:", error);
      return updated;
    });

    return NextResponse.json(article);
  } catch (error) {
    console.error("Ошибка обновления готовой статьи:", error);
    return NextResponse.json(
      { error: "Не удалось обновить статью" },
      { status: 500 }
    );
  }
}
