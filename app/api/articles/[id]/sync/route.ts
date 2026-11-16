import { NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import { retryArticleSync } from "@/lib/disk-sync-service";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
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

  try {
    const article = await retryArticleSync(id);

    if (!article) {
      return NextResponse.json({ error: "Статья не найдена" }, { status: 404 });
    }

    return NextResponse.json(article);
  } catch (error) {
    console.error("Ошибка повторной выгрузки статьи на Диск:", error);
    return NextResponse.json(
      { error: "Не удалось повторить выгрузку статьи" },
      { status: 500 }
    );
  }
}
