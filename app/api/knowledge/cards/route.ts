import { readRouteSession } from "@/lib/account-route-session";
import { NextRequest, NextResponse } from "next/server";

import {
  areCardOwnerIdsAssignable,
  canAssignCardOwner,
  canCreateOrganizationCard,
  canCreateCard,
  visibleKnowledgeCard,
  visibleKnowledgeCards,
  getUserOwnershipLabel,
  isCardOwner,
  resolveLegacyCardOwnerIds,
} from "@/lib/auth";
import { verifySameOrigin } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import { syncKnowledgeCardRecord } from "@/lib/disk-sync-service";
import { folderIds, getUniversityIdFromFolder, isCardReadyForPublication, stakeholderApprovalRoles } from "@/lib/knowledge";
import { staffDirectory } from "@/lib/account-directory";
import {
  createKnowledgeCard,
  deleteKnowledgeCard,
  getAllKnowledgeCards,
  getCardTypeById,
} from "@/lib/models";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import {
  buildCustomFieldValuesSchema,
  canonicalKnowledgeFolder,
  knowledgeCardInputSchema,
} from "@/lib/validation/knowledge";

export async function GET() {
  const session = await readRouteSession();
  if (session.response) return session.response;
  const { user } = session;
  try {
    const cards = await getAllKnowledgeCards();
    return NextResponse.json(visibleKnowledgeCards(user, cards), { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return unavailableStorageResponse();
  }
}

export async function POST(request: NextRequest) {
  if (!verifySameOrigin(request)) {
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос" },
      { status: 403 }
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

  if (!canCreateCard(user)) {
    return NextResponse.json(
      {
        error:
          "Создавать карточки могут администратор канона, владельцы и PR-команды вузов, АНО «РИОН» и ООО «ЧКК»",
      },
      { status: 403 }
    );
  }

  const dbAvailable = await isStorageWritable();

  if (!dbAvailable) {
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

  const organizationRole = user.role === "rio" || user.role === "chkk" ? user.role : undefined;
  const input = body && typeof body === "object" && user.role !== "admin"
    ? { ...body, organizationScope: organizationRole }
    : body;
  const parsed = knowledgeCardInputSchema.safeParse(input);

  if (!parsed.success) {
    const hasPlacementError = parsed.error.issues.some(
      (issue) => issue.path[0] === "placementStatus"
    );

    return NextResponse.json(
      {
        error: hasPlacementError
          ? "Выберите статус размещения лаборатории"
          : "Некорректные данные карточки",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  let cardInput = parsed.data;

  if (cardInput.type === "campus" && user.role !== "admin") {
    return NextResponse.json(
      {
        error:
          "Создавать и изменять общий паспорт кампуса может только администратор канона",
      },
      { status: 403 }
    );
  }

  const organizationScope = cardInput.organizationScope;
  if (organizationScope && !canCreateOrganizationCard(organizationScope, cardInput)) {
    return NextResponse.json(
      { error: "Этот тип карточки находится за пределами ответственности организации" },
      { status: 403 }
    );
  }

  if (
    (user.role === "university_owner" || user.role === "university_pr") &&
    user.universityId
  ) {
    const folderUniversityId = getUniversityIdFromFolder(cardInput.folderId);
    if (folderUniversityId && folderUniversityId !== user.universityId) {
      return NextResponse.json(
        { error: "Нельзя создавать карточки в папке другого университета" },
        { status: 403 }
      );
    }

    if (cardInput.type === "project") {
      if (cardInput.isJoint) {
        if (!cardInput.participantUniversityIds.includes(user.universityId)) {
          return NextResponse.json(
            {
              error:
                "В совместном проекте должен быть указан ваш университет среди участников",
            },
            { status: 403 }
          );
        }
      } else {
        cardInput = {
          ...cardInput,
          initiatorUniversityId: user.universityId,
        };
      }
    }
  }

  const canonicalFolder = canonicalKnowledgeFolder(cardInput);
  if (!canonicalFolder) {
    return NextResponse.json({ error: "Выберите папку из дерева базы знаний" }, { status: 400 });
  }
  cardInput = { ...cardInput, folderId: canonicalFolder };
  if (cardInput.type === "custom" && user.role !== "admin") {
    cardInput = { ...cardInput, universityId: user.universityId };
  }

  if (cardInput.type === "custom") {
    try {
      const typeDef = await getCardTypeById(cardInput.customTypeId);

      if (!typeDef) {
        return NextResponse.json(
          { error: "Пользовательский тип карточки не найден" },
          { status: 400 }
        );
      }

      const construction = typeDef.organizationScope === "chkk";
      if (construction ? user.role !== "admin" && user.role !== "chkk" : cardInput.organizationScope === "chkk") {
        return NextResponse.json({ error: "Этот тип не доступен для создания в вашей зоне ответственности." }, { status: 403 });
      }

      const customFields = buildCustomFieldValuesSchema(typeDef).safeParse(
        cardInput.customFields
      );

      if (!customFields.success) {
        return NextResponse.json(
          {
            error: "Проверьте заполнение полей карточки",
            details: customFields.error.flatten(),
          },
          { status: 400 }
        );
      }

      cardInput = {
        ...cardInput,
        ...(construction ? { organizationScope: "chkk", folderId: folderIds.chkkParameters, universityId: undefined } : {}),
        customFields: customFields.data,
      };
    } catch {
      return unavailableStorageResponse();
    }
  }

  if (user.role === "admin") {
    const directory = await staffDirectory().catch(() => null);
    if (!directory) return unavailableStorageResponse();
    const ownerIds = cardInput.ownerIds ?? resolveLegacyCardOwnerIds(cardInput, directory) ?? [];
    if (!areCardOwnerIdsAssignable(cardInput, ownerIds, directory)) {
      return NextResponse.json(
        { error: "Владельцы должны иметь доступ к этому разделу карточек" },
        { status: 400 }
      );
    }
    cardInput = { ...cardInput, ownerIds };
  } else if (user.role === "university_pr") {
    cardInput = { ...cardInput, ownerIds: [] };
  } else {
    cardInput = {
      ...cardInput,
      owners: isCardOwner(user, cardInput.owners)
        ? cardInput.owners
        : [getUserOwnershipLabel(user), ...cardInput.owners],
      ownerIds: canAssignCardOwner(user, cardInput) ? [user.id] : [],
    };
  }

  const needsJointConfirmation =
    cardInput.type === "project" && cardInput.isJoint;
  const requiredStakeholders = stakeholderApprovalRoles(cardInput);
  const status = user.role === "admin" && !needsJointConfirmation &&
    !requiredStakeholders.length && isCardReadyForPublication(cardInput) ? "approved" : "pending";

  try {
    const created = await createKnowledgeCard(cardInput, {
      status,
      submittedBy: user.id,
      submittedByName: user.name,
      participantApprovals: [],
      ...(requiredStakeholders.length ? { requiredApprovalStakeholderRoles: requiredStakeholders } : {}),
    });
    const card =
      status === "approved"
        ? await syncKnowledgeCardRecord(created).catch((error) => {
            console.error(
              "Ошибка автоматической выгрузки карточки на Диск:",
              error
            );
            return created;
          })
        : created;

    return NextResponse.json(visibleKnowledgeCard(user, card), { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException")
      return NextResponse.json({ error: "Тип карточки изменился. Обновите страницу и повторите действие." }, { status: 409 });
    return unavailableStorageResponse();
  }
}

export async function DELETE(request: NextRequest) {
  if (!verifySameOrigin(request)) {
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос" },
      { status: 403 }
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

  if (user.role !== "admin") {
    return NextResponse.json(
      { error: "Удалять карточки может только администратор канона" },
      { status: 403 }
    );
  }

  const dbAvailable = await isStorageWritable();

  if (!dbAvailable) {
    return NextResponse.json(
      { error: "База данных недоступна в статическом режиме" },
      { status: 503 }
    );
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json(
      { error: "Параметр id обязателен" },
      { status: 400 }
    );
  }

  try {
    await deleteKnowledgeCard(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException")
      return NextResponse.json({ error: "Карточка изменилась. Обновите страницу и повторите действие." }, { status: 409 });
    return unavailableStorageResponse();
  }
}
