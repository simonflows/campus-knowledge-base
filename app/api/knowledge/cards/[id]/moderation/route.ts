import { readRouteSession } from "@/lib/account-route-session";
import { NextRequest, NextResponse } from "next/server";

import {
  canConfirmJointParticipation,
  canConfirmStakeholderApproval,
  canModerate,
  canReviewJointParticipation,
  canReviewStakeholderScope,
  missingJointOwnerUniversityIds,
  visibleKnowledgeCard,
} from "@/lib/auth";
import { verifySameOrigin } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import { syncKnowledgeCardRecord } from "@/lib/disk-sync-service";
import {
  confirmKnowledgeIndicator,
  getKnowledgeCardById,
  setKnowledgeCardModeration,
} from "@/lib/models";
import { StrategyWriteError } from "@/lib/strategy-server";
import {
  getCardStatus,
  isCardReadyForPublication,
  getRequiredStakeholderApprovals,
  getRequiredUniversityApprovals,
} from "@/lib/knowledge";
import { getCardVersionId } from "@/lib/knowledge-versions";
import { staffDirectory } from "@/lib/account-directory";
import { moderationActionSchema } from "@/lib/validation/access";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";

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

  const session = await readRouteSession();
  if (session.response) return session.response;
  const { user } = session;

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

  const expectedVersion = request.headers.get("if-match");
  const withinDecisionScope =
    action === "confirm-participation"
      ? canReviewJointParticipation(user, card)
      : action === "confirm-stakeholder"
        ? canReviewStakeholderScope(user, card)
        : canModerate(user);
  if (!withinDecisionScope) {
    return NextResponse.json(
      { error: "Вашей роли не назначено это согласование." },
      { status: 403 }
    );
  }
  if (expectedVersion !== null && expectedVersion !== card.updatedAt) {
    return NextResponse.json(
      { error: "Карточка изменилась. Обновите её и повторите подтверждение." },
      { status: 409 }
    );
  }

  const participantId =
    action === "confirm-participation" &&
    canConfirmJointParticipation(user, card)
      ? user.universityId
      : undefined;
  const stakeholderRole =
    action === "confirm-stakeholder" &&
    canConfirmStakeholderApproval(user, card)
      ? user.role
      : undefined;
  if (
    (action === "confirm-participation" && !participantId) ||
    (action === "confirm-stakeholder" && !stakeholderRole)
  ) {
    return NextResponse.json(
      { error: "Подтверждение уже сохранено или редакция закрыта." },
      { status: 403 }
    );
  }
  if (action !== "reject" && expectedVersion === null) {
    return NextResponse.json(
      { error: "Откройте текущую редакцию перед подтверждением." },
      { status: 428 }
    );
  }
  if (getCardStatus(card) !== "pending") {
    return NextResponse.json(
      { error: "Решение доступно только для редакции на согласовании." },
      { status: 409 }
    );
  }

  if (
    expectedVersion !== null &&
    (action === "confirm-plan" || action === "confirm-actual")
  ) {
    const updated = await confirmKnowledgeIndicator(
      id,
      action === "confirm-plan" ? "plan" : "actual",
      expectedVersion,
      {
        id: user.id,
        name: user.name,
      }
    );
    return updated
      ? NextResponse.json(visibleKnowledgeCard(user, updated))
      : NextResponse.json({ error: "Карточка не найдена" }, { status: 404 });
  }

  const revisionId = getCardVersionId({ ...card, approvedSnapshot: undefined });
  if (participantId || stakeholderRole) {
    const decision = {
      revisionId,
      actorId: user.id,
      at: new Date().toISOString(),
      ...(comment ? { comment } : {}),
    };
    const participantRecords = {
      ...card.participantApprovalRecords,
      ...(participantId ? { [participantId]: decision } : {}),
    };
    const updated = await setKnowledgeCardModeration(
      id,
      {
        ...(participantId
          ? {
              participantApprovalRecords: participantRecords,
              participantApprovals: Object.keys(participantRecords),
            }
          : {}),
        ...(stakeholderRole
          ? {
              stakeholderApprovals: {
                ...card.stakeholderApprovals,
                [stakeholderRole]: decision,
              },
            }
          : {}),
      },
      card.updatedAt
    );
    return updated
      ? NextResponse.json(visibleKnowledgeCard(user, updated))
      : NextResponse.json({ error: "Карточка не найдена" }, { status: 404 });
  }

  if (action === "approve" && !isCardReadyForPublication(card)) {
    return NextResponse.json(
      {
        error:
          card.type === "project" && card.externalParticipantNames?.length
            ? "Согласование внешнего участника не представлено в реестре. Оставьте карточку черновиком до отдельного подтверждения координатором и участниками."
            : "Перед согласованием уточните стадию и контур проекта по источникам",
      },
      { status: 409 }
    );
  }

  if (action === "approve") {
    const directory = await staffDirectory().catch(() => null);
    if (!directory) return unavailableStorageResponse();
    const missingOwnerUniversityIds = missingJointOwnerUniversityIds(
      card,
      directory
    );
    const missingUniversityIds = getRequiredUniversityApprovals(card).filter(
      (universityId) =>
        card.participantApprovalRecords?.[universityId]?.revisionId !==
        revisionId
    );
    const missingStakeholderRoles = getRequiredStakeholderApprovals(
      card
    ).filter(
      (role) => card.stakeholderApprovals?.[role]?.revisionId !== revisionId
    );
    if (
      missingOwnerUniversityIds.length ||
      missingUniversityIds.length ||
      missingStakeholderRoles.length
    ) {
      return NextResponse.json(
        {
          error: missingOwnerUniversityIds.length
            ? "Назначьте ответственного руководителя от каждого вуза-участника."
            : "Сначала получите обязательные подтверждения текущей редакции.",
          missingOwnerUniversityIds,
          missingUniversityIds,
          missingStakeholderRoles,
        },
        { status: 409 }
      );
    }
  }

  const updated = await setKnowledgeCardModeration(
    id,
    {
      status: action === "approve" ? "approved" : "rejected",
      reviewedBy: user.name,
      reviewedAt: new Date().toISOString(),
      reviewComment: comment ?? "",
    },
    card.updatedAt,
    { id: user.id, name: user.name }
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
    if (error instanceof StrategyWriteError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    )
      return NextResponse.json(
        {
          error:
            "Карточка или связанный источник изменился. Обновите данные и повторите подтверждение.",
        },
        { status: 409 }
      );
    return unavailableStorageResponse();
  }
}
