import { NextRequest, NextResponse } from "next/server";

import { canEditCard, canRequestEdit, roleLabels } from "@/lib/auth";
import { getSessionUser } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import type { CardEditRequest } from "@/lib/knowledge";
import { getKnowledgeCardById, setKnowledgeCardModeration } from "@/lib/models";
import {
  editRequestCreateSchema,
  editRequestUpdateSchema,
} from "@/lib/validation/access";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
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

  if (!card) {
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

  const updated = await setKnowledgeCardModeration(id, {
    editRequests: [...(card.editRequests ?? []), editRequest],
  });

  return NextResponse.json(updated, { status: 201 });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
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

  if (!card) {
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

  const updated = await setKnowledgeCardModeration(id, {
    editRequests: nextRequests,
  });

  return NextResponse.json(updated);
}
