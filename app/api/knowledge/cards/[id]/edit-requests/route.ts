import { NextRequest, NextResponse } from "next/server";

import { canEditCard, canRequestEdit, roleLabels, visibleKnowledgeCard } from "@/lib/auth";
import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import type { SessionUser } from "@/lib/auth";
import type { CardEditRequest, KnowledgeCard } from "@/lib/knowledge";
import { getKnowledgeCardById, setKnowledgeCardModeration } from "@/lib/models";
import {
  editRequestCreateSchema,
  editRequestUpdateSchema,
} from "@/lib/validation/access";

type RouteContext = { params: Promise<{ id: string }> };

async function saveRequests(card: KnowledgeCard, editRequests: CardEditRequest[], user: SessionUser, status = 200) {
  try {
    const updated = await setKnowledgeCardModeration(card.id, { editRequests }, card.updatedAt);
    if (!updated) return NextResponse.json({ error: "Карточка не найдена" }, { status: 404 });
    return NextResponse.json(visibleKnowledgeCard(user, updated), {
      status, headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
      return NextResponse.json({ error: "Карточка изменилась. Обновите страницу и повторите действие." }, { status: 409 });
    }
    return NextResponse.json({ error: "Не удалось сохранить запрос на правку" }, { status: 503 });
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  if (!verifySameOrigin(request)) {
    return NextResponse.json({ error: "Недопустимый источник запроса" }, { status: 403 });
  }
  if (!(await isStorageWritable())) {
    return NextResponse.json(
      { error: "База данных недоступна в статическом режиме" },
      { status: 503 }
    );
  }

  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json(
      { error: "Войдите под демонстрационным аккаунтом" },
      { status: 401 }
    );
  }

  const { id } = await context.params;
  const card = await getKnowledgeCardById(id);

  if (!card || !visibleKnowledgeCard(user, card)) {
    return NextResponse.json({ error: "Карточка не найдена" }, { status: 404 });
  }

  if (!canRequestEdit(user, card)) {
    return NextResponse.json(
      {
        error:
          user.role === "guest"
            ? "Гость не может отправлять запросы на правку"
            : "У вас есть право редактировать эту карточку напрямую",
      },
      { status: 403 }
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

  const parsed = editRequestCreateSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? "Опишите, что нужно изменить",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const editRequest: CardEditRequest = {
    id: crypto.randomUUID(),
    authorId: user.id,
    authorName: user.name,
    authorRole: roleLabels[user.role],
    authorOrganization: user.organization,
    message: parsed.data.message,
    createdAt: new Date().toISOString(),
    status: "open",
  };

  return saveRequests(card, [...(card.editRequests ?? []), editRequest], user, 201);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  if (!verifySameOrigin(request)) {
    return NextResponse.json({ error: "Недопустимый источник запроса" }, { status: 403 });
  }
  if (!(await isStorageWritable())) {
    return NextResponse.json(
      { error: "База данных недоступна в статическом режиме" },
      { status: 503 }
    );
  }

  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json(
      { error: "Войдите под демонстрационным аккаунтом" },
      { status: 401 }
    );
  }

  const { id } = await context.params;
  const card = await getKnowledgeCardById(id);

  if (!card || !visibleKnowledgeCard(user, card)) {
    return NextResponse.json({ error: "Карточка не найдена" }, { status: 404 });
  }

  if (!canEditCard(user, card)) {
    return NextResponse.json(
      {
        error:
          "Закрывать запросы на правку может только владелец карточки или администратор канона",
      },
      { status: 403 }
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

  const parsed = editRequestUpdateSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? "Некорректное действие",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const requestToUpdate = (card.editRequests ?? []).find(
    (item) => item.id === parsed.data.requestId
  );

  if (!requestToUpdate) {
    return NextResponse.json(
      { error: "Запрос на правку не найден" },
      { status: 404 }
    );
  }

  const now = new Date().toISOString();
  const nextRequests = (card.editRequests ?? []).map((item) => {
    if (item.id !== parsed.data.requestId) return item;

    if (parsed.data.action === "resolve") {
      return {
        ...item,
        status: "resolved" as const,
        resolvedBy: user.name,
        resolvedAt: now,
        resolution: parsed.data.resolution ?? "",
      };
    }

    return {
      id: item.id,
      authorId: item.authorId,
      authorName: item.authorName,
      authorRole: item.authorRole,
      authorOrganization: item.authorOrganization,
      message: item.message,
      createdAt: item.createdAt,
      status: "open" as const,
    };
  });

  return saveRequests(card, nextRequests, user);
}
