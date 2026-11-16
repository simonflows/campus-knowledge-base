import { NextRequest, NextResponse } from "next/server";

import { canEditCard } from "@/lib/auth";
import { getSessionUser } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import { syncKnowledgeCardRecord } from "@/lib/disk-sync-service";
import { folderIds, getCardStatus } from "@/lib/knowledge";
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
  const current = await getKnowledgeCardById(id);

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

  if (cardInput.type !== current.type) {
    return NextResponse.json(
      { error: "Тип карточки нельзя изменить после создания" },
      { status: 400 }
    );
  }

  if (cardInput.type === "custom") {
    const typeDef = await getCardTypeById(cardInput.customTypeId);

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
      folderId: current.folderId,
    };
  }

  try {
    const updated = await updateKnowledgeCard(id, cardInput);

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

    return NextResponse.json(card);
  } catch (error) {
    console.error("Ошибка обновления карточки базы знаний:", error);
    return NextResponse.json(
      { error: "Ошибка обновления карточки" },
      { status: 500 }
    );
  }
}
