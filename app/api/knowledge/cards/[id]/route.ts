import { NextRequest, NextResponse } from "next/server";

import {
  areCardOwnerIdsAssignable,
  canEditCard,
  resolveLegacyCardOwnerIds,
  sameCardOwnerScope,
  visibleKnowledgeCard,
} from "@/lib/auth";
import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import { syncKnowledgeCardRecord } from "@/lib/disk-sync-service";
import { folderIds, getCardStatus } from "@/lib/knowledge";
import { sessionDirectory } from "@/lib/pilot-auth";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import {
  getCardTypeById,
  getKnowledgeCardById,
  updateKnowledgeCard,
} from "@/lib/models";
import {
  buildCustomFieldValuesSchema,
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

  const user = await getSessionUser();

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

  const parsed = knowledgeCardInputSchema.safeParse(body);

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

  if (cardInput.type === "custom") {
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
      folderId: folderIds.customType(typeDef.id),
      customFields: customFields.data,
    };
  }

  if (user.role !== "admin") {
    cardInput = {
      ...cardInput,
      owners: current.owners,
      ownerIds: current.ownerIds,
      folderId: current.folderId,
    };
    if (!sameCardOwnerScope(current, cardInput)) {
      return NextResponse.json(
        { error: "Папку, вуз и участников проекта меняет координатор" },
        { status: 403 }
      );
    }
  } else {
    const directory = sessionDirectory();
    const changedScope = !sameCardOwnerScope(current, cardInput);
    const ownerIds =
      cardInput.ownerIds ?? current.ownerIds ?? resolveLegacyCardOwnerIds(cardInput, directory) ??
      (changedScope ? [] : undefined);
    if (
      ownerIds !== undefined &&
      (cardInput.ownerIds !== undefined || changedScope) &&
      !areCardOwnerIdsAssignable(cardInput, ownerIds, directory)
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
