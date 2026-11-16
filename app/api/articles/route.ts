import { NextRequest, NextResponse } from "next/server";

import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import { syncArticleRecord } from "@/lib/disk-sync-service";
import { getUniversityById } from "@/lib/knowledge";
import { mockArticles } from "@/lib/mock-data";
import {
  clearDemoArticles,
  createArticle,
  deleteArticle,
  ensureArticleSeed,
  getAllArticles,
  getArticleById,
} from "@/lib/models";
import { saveArticleInputSchema } from "@/lib/validation/articles";

function sortByFreshness<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function GET() {
  if (await isStorageWritable()) {
    try {
      await ensureArticleSeed();
      const articles = await getAllArticles();
      return NextResponse.json(sortByFreshness(articles));
    } catch (error) {
      console.error("Ошибка получения готовых статей:", error);
    }
  }

  return NextResponse.json(sortByFreshness(mockArticles));
}

export async function POST(request: NextRequest) {
  if (!verifySameOrigin(request)) {
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос" },
      { status: 403 }
    );
  }

  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json(
      { error: "Войдите под демонстрационным аккаунтом для сохранения статей" },
      { status: 401 }
    );
  }

  if (user.role === "guest") {
    return NextResponse.json(
      { error: "Гость не может сохранять статьи в библиотеку канона" },
      { status: 403 }
    );
  }

  if (!(await isStorageWritable())) {
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
    parsed.data.universityId !== user.universityId
  ) {
    return NextResponse.json(
      { error: "Представитель вуза может сохранять статью только в папку своего университета" },
      { status: 403 }
    );
  }

  try {
    const created = await createArticle(parsed.data);
    const article = await syncArticleRecord(created).catch((error) => {
      console.error("Ошибка автоматической выгрузки статьи на Диск:", error);
      return created;
    });

    return NextResponse.json(article, { status: 201 });
  } catch (error) {
    console.error("Ошибка сохранения готовой статьи:", error);
    return NextResponse.json(
      { error: "Не удалось сохранить статью в «Готовые_статьи»" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  if (!verifySameOrigin(request)) {
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос" },
      { status: 403 }
    );
  }

  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json(
      { error: "Войдите под демонстрационным аккаунтом" },
      { status: 401 }
    );
  }

  if (user.role === "guest") {
    return NextResponse.json(
      { error: "Гость не может удалять статьи из библиотеки канона" },
      { status: 403 }
    );
  }

  if (!(await isStorageWritable())) {
    return NextResponse.json(
      { error: "База данных недоступна в статическом режиме" },
      { status: 503 }
    );
  }

  const searchParams = new URL(request.url).searchParams;
  const scope = searchParams.get("scope");

  if (scope === "demo") {
    if (user.role !== "admin") {
      return NextResponse.json(
        { error: "Очищать стартовые демо-статьи может только администратор канона" },
        { status: 403 }
      );
    }

    try {
      const removed = await clearDemoArticles();
      return NextResponse.json({ success: true, clearedDemo: true, removed });
    } catch (error) {
      console.error("Ошибка очистки демо-статей:", error);
      return NextResponse.json(
        { error: "Не удалось очистить демо-статьи" },
        { status: 500 }
      );
    }
  }

  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json(
      { error: "Параметр id обязателен" },
      { status: 400 }
    );
  }

  const existing = await getArticleById(id);

  if (!existing) {
    return NextResponse.json({ error: "Статья не найдена" }, { status: 404 });
  }

  const canDelete =
    user.role === "admin" ||
    (Boolean(user.universityId) &&
      (user.role === "university_owner" || user.role === "university_pr") &&
      existing.universityId === user.universityId);

  if (!canDelete) {
    return NextResponse.json(
      {
        error:
          "Удалять статьи могут только администратор канона или представители вуза-автора",
      },
      { status: 403 }
    );
  }

  try {
    await deleteArticle(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Ошибка удаления готовой статьи:", error);
    return NextResponse.json(
      { error: "Не удалось удалить статью" },
      { status: 500 }
    );
  }
}
