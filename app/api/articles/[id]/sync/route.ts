import { NextResponse } from "next/server";

import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { isApprovedArticle } from "@/lib/articles";
import { getEditorial } from "@/lib/editorial-models";
import { isStorageWritable } from "@/lib/db";
import {
  readArticleDiskRegistry,
  syncArticleRecord,
} from "@/lib/disk-sync-service";
import { getArticleById } from "@/lib/models";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";

type RouteContext = { params: Promise<{ id: string }> };

async function authorizedArticle(context: RouteContext) {
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
    let draft;
    try {
      draft = await getEditorial(existing.originalDraftId ?? id, user);
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "status" in error &&
          [403, 404].includes(Number(error.status))
        )
      ) {
        return unavailableStorageResponse();
      }
    }
    if (!draft || draft.ownerId !== user.id)
      return NextResponse.json(
        { error: "Выгрузку запускает автор материала или координатор" },
        { status: 403 }
      );
  }
  return existing;
}

export async function GET(_request: Request, context: RouteContext) {
  const article = await authorizedArticle(context);
  if (article instanceof Response) return article;
  try {
    const registry = await readArticleDiskRegistry(article);
    return NextResponse.json(
      { registry },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch {
    return unavailableStorageResponse();
  }
}

export async function POST(request: Request, context: RouteContext) {
  if (!verifySameOrigin(request))
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос" },
      { status: 403 }
    );
  const existing = await authorizedArticle(context);
  if (existing instanceof Response) return existing;
  if (!isApprovedArticle(existing)) {
    return NextResponse.json(
      { error: "Материал ещё не согласован" },
      { status: 409 }
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
    return unavailableStorageResponse();
  }
}
