import { readRouteSession } from "@/lib/account-route-session";
import { NextRequest, NextResponse } from "next/server";

import {
  areCardOwnerIdsAssignable,
  canCreateOrganizationCard,
  canEditCard,
  missingJointOwnerUniversityIds,
  resolveLegacyCardOwnerIds,
  sameCardOwnerScope,
  visibleKnowledgeCard,
} from "@/lib/auth";
import { verifySameOrigin } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import { syncKnowledgeCardRecord } from "@/lib/disk-sync-service";
import { folderIds, getApprovedVersion, getCardStatus, getLegacyCustomDraftUniversityId, getRequiredUniversityApprovals } from "@/lib/knowledge";
import { staffDirectory } from "@/lib/account-directory";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import {
  getCardTypeById,
  getKnowledgeCardById,
  updateKnowledgeCard,
} from "@/lib/models";
import {
  buildCustomFieldValuesSchema,
  canonicalKnowledgeFolder,
  knowledgeCardInputSchema,
} from "@/lib/validation/knowledge";

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, context: RouteContext) {
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
  let current;
  try {
    current = await getKnowledgeCardById(id);
  } catch {
    return unavailableStorageResponse();
  }

  if (!current) {
    return NextResponse.json({ error: "Карточка не найдена" }, { status: 404 });
  }

  if (!canEditCard(user, current)) {
    return NextResponse.json(
      {
        error:
          "Чужую утверждённую карточку изменить нельзя. Отправьте запрос на правку владельцу карточки.",
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

  const input = body && typeof body === "object"
    ? {
        ...body,
        organizationScope: user.role === "admin" && "organizationScope" in body
          ? body.organizationScope
          : current.organizationScope,
      }
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

  const expectedVersion = request.headers.get("if-match");
  if (expectedVersion && expectedVersion !== current.updatedAt)
    return NextResponse.json(
      { error: "Карточка изменилась. Обновите её перед сохранением." },
      { status: 409 }
    );
  if (
    current.type === "university" &&
    cardInput.type === "university" &&
    current.universityId !== cardInput.universityId
  )
    return NextResponse.json(
      { error: "Нельзя изменить вуз паспорта" },
      { status: 400 }
    );

  if (cardInput.type !== current.type ||
      (cardInput.type === "custom" && current.type === "custom" && cardInput.customTypeId !== current.customTypeId)) {
    return NextResponse.json(
      { error: "Тип карточки нельзя изменить после создания" },
      { status: 400 }
    );
  }

  if (cardInput.organizationScope && !canCreateOrganizationCard(cardInput.organizationScope, cardInput)) {
    return NextResponse.json({ error: "Этот тип карточки находится за пределами ответственности организации" }, { status: 400 });
  }
  if (current.type === "laboratory" && getRequiredUniversityApprovals(current).length && cardInput.organizationScope) {
    return NextResponse.json({ error: "Совместная лаборатория сохраняет ответственность вузов. Её нельзя перенести в зону отдельной организации." }, { status: 409 });
  }
  const canonicalFolder = user.role !== "admin" && getLegacyCustomDraftUniversityId(current)
    ? current.folderId
    : canonicalKnowledgeFolder(cardInput);
  if (!canonicalFolder) {
    return NextResponse.json({ error: "Выберите папку из дерева базы знаний" }, { status: 400 });
  }
  cardInput = { ...cardInput, folderId: canonicalFolder };

  if (cardInput.type === "custom") {
    if (current.type === "custom") {
      cardInput = {
        ...cardInput,
        universityId: user.role === "admin" ? cardInput.universityId ?? current.universityId : current.universityId,
      };
    }
    let typeDef;
    try {
      typeDef = await getCardTypeById(cardInput.customTypeId);
    } catch {
      return unavailableStorageResponse();
    }

    if (!typeDef) {
      return NextResponse.json(
        { error: "Пользовательский тип карточки не найден" },
        { status: 400 }
      );
    }

    const construction = typeDef.organizationScope === "chkk";
    if (construction ? user.role !== "admin" && user.role !== "chkk" : cardInput.organizationScope === "chkk") {
      return NextResponse.json({ error: "Изменение зоны доступа через карточку недоступно." }, { status: 403 });
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
  }

  if (user.role !== "admin") {
    cardInput = {
      ...cardInput,
      owners: current.owners,
      ownerIds: current.ownerIds,
    };
    if (!sameCardOwnerScope(current, cardInput)) {
      return NextResponse.json(
        { error: "Папку, вуз и участников проекта меняет координатор" },
        { status: 403 }
      );
    }
  } else {
    const directory = await staffDirectory().catch(() => null);
    if (!directory) return unavailableStorageResponse();
    const assignment = { ...cardInput, requiredApprovalUniversityIds: current.requiredApprovalUniversityIds };
    const published = getApprovedVersion(current);
    const proposedUniversities = cardInput.type === "project" && cardInput.isJoint
      ? cardInput.participantUniversityIds : [];
    if (published?.type === "project") {
      const removedUniversities = getRequiredUniversityApprovals(published).filter(id => !proposedUniversities.includes(id));
      if (removedUniversities.length &&
          missingJointOwnerUniversityIds(published, directory).some(id => removedUniversities.includes(id))) {
        return NextResponse.json({
          error: "Перед изменением состава назначьте руководителей от выбывающих вузов в утверждённой карточке.",
        }, { status: 409 });
      }
    }
    const changedScope = !sameCardOwnerScope(current, cardInput);
    const ownerIds =
      cardInput.ownerIds ?? current.ownerIds ?? resolveLegacyCardOwnerIds(assignment, directory) ??
      (changedScope ? [] : undefined);
    if (
      ownerIds !== undefined &&
      (cardInput.ownerIds !== undefined || changedScope) &&
      !areCardOwnerIdsAssignable(assignment, ownerIds, directory)
    ) {
      return NextResponse.json(
        { error: "Укажите действующих владельцев из этого раздела карточек" },
        { status: 400 }
      );
    }
    cardInput = { ...cardInput, ownerIds };
  }

  try {
    const updated = await updateKnowledgeCard(id, cardInput, {
      id: user.id,
      name: user.name,
      isAdmin: user.role === "admin",
    }, current.updatedAt);

    if (!updated) {
      return NextResponse.json(
        { error: "Карточка не найдена" },
        { status: 404 }
      );
    }

    const card =
      getCardStatus(updated) === "approved"
        ? await syncKnowledgeCardRecord(updated).catch((error) => {
            console.error(
              "Ошибка выгрузки обновлённой карточки на Диск:",
              error
            );
            return updated;
          })
        : updated;

    return NextResponse.json(visibleKnowledgeCard(user, card));
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    )
      return NextResponse.json(
        {
          error:
            "Карточка изменилась. Обновите её перед повторным сохранением.",
        },
        { status: 409 }
      );
    return unavailableStorageResponse();
  }
}
