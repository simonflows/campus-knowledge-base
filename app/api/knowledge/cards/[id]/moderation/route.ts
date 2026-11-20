import { NextRequest, NextResponse } from "next/server";

import { canConfirmJointParticipation, canModerate, visibleKnowledgeCard } from "@/lib/auth";
import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import { syncKnowledgeCardRecord } from "@/lib/disk-sync-service";
import { getKnowledgeCardById, setKnowledgeCardModeration } from "@/lib/models";
import {
  isJointFullyApproved,
  getRequiredUniversityApprovals,
} from "@/lib/knowledge";
import { moderationActionSchema } from "@/lib/validation/access";

type RouteContext = { params: Promise<{ id: string }> };

async function handlePost(request: NextRequest, context: RouteContext) {
  if (!verifySameOrigin(request))
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

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Некорректный JSON в теле запроса" },
      { status: 400 }
    );
  }

  const parsed = moderationActionSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? "Некорректное действие",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const { action, comment } = parsed.data;

  if (action === "confirm-participation") {
    if (!canConfirmJointParticipation(user, card) || !user.universityId) {
      return NextResponse.json(
        {
          error:
            "Подтвердить участие может только представитель вуза-участника, которого ещё нет в подтверждениях",
        },
        { status: 403 }
      );
    }

    const approvals = Array.from(
      new Set([...(card.participantApprovals ?? []), user.universityId])
    );
    const updated = await setKnowledgeCardModeration(
      id,
      {
        participantApprovals: approvals,
      },
      card.updatedAt
    );

    return updated ? NextResponse.json(visibleKnowledgeCard(user, updated)) : NextResponse.json({ error: "Карточка не найдена" }, { status: 404 });
  }

  if (!canModerate(user)) {
    return NextResponse.json(
      { error: "Модерировать карточки может только администратор канона" },
      { status: 403 }
    );
  }

  if (
    action === "approve" &&
    getRequiredUniversityApprovals(card).length > 0 &&
    !isJointFullyApproved(card)
  ) {
    return NextResponse.json(
      {
        error:
          "Совместный проект нельзя одобрить до подтверждения обоих вузов-участников",
        missingUniversityIds: getRequiredUniversityApprovals(card).filter(
          (universityId) =>
            !(card.participantApprovals ?? []).includes(universityId)
        ),
      },
      { status: 409 }
    );
  }

  const updated = await setKnowledgeCardModeration(
    id,
    {
      status: action === "approve" ? "approved" : "rejected",
      reviewedBy: user.name,
      reviewedAt: new Date().toISOString(),
      reviewComment: comment ?? "",
    },
    card.updatedAt
  );

  if (!updated) {
    return NextResponse.json({ error: "Карточка не найдена" }, { status: 404 });
  }

  if (action === "approve") {
    const synced = await syncKnowledgeCardRecord(updated).catch((error) => {
      console.error("Ошибка выгрузки одобренной карточки на Диск:", error);
      return updated;
    });

    return NextResponse.json(visibleKnowledgeCard(user, synced));
  }

  return NextResponse.json(visibleKnowledgeCard(user, updated));
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    return await handlePost(request, context);
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    )
      return NextResponse.json(
        {
          error: "Карточка изменилась. Обновите её и повторите подтверждение.",
        },
        { status: 409 }
      );
    console.error("Ошибка подтверждения карточки:", error);
    return NextResponse.json(
      { error: "Не удалось сохранить подтверждение" },
      { status: 500 }
    );
  }
}
