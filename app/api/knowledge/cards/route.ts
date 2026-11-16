import { NextRequest, NextResponse } from "next/server";

import {
  canCreateCard,
  canSeeCard,
  getUserOwnershipLabel,
  isCardOwner,
} from "@/lib/auth";
import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import { syncKnowledgeCardRecord } from "@/lib/disk-sync-service";
import { folderIds } from "@/lib/knowledge";
import {
  createKnowledgeCard,
  deleteKnowledgeCard,
  ensureKnowledgeSeed,
  getAllKnowledgeCards,
  getCardTypeById,
} from "@/lib/models";
import { mockKnowledgeCards } from "@/lib/mock-data";
import {
  buildCustomFieldValuesSchema,
  knowledgeCardInputSchema,
} from "@/lib/validation/knowledge";

export async function GET() {
  const user = await getSessionUser();
  const dbAvailable = await isStorageWritable();

  if (dbAvailable) {
    try {
      await ensureKnowledgeSeed();
      const cards = await getAllKnowledgeCards();
      return NextResponse.json(cards.filter((card) => canSeeCard(user, card)));
    } catch (error) {
      console.error("Ошибка получения карточек базы знаний:", error);
    }
  }

  return NextResponse.json(
    mockKnowledgeCards.filter((card) => canSeeCard(user, card))
  );
}

function extractUniversityFolderId(folderId: string): string | null {
  const match = /^01_universities\/([^/]+)/.exec(folderId);
  return match?.[1] ?? null;
}

export async function POST(request: NextRequest) {
  if (!verifySameOrigin(request)) {
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос" },
      { status: 403 }
    );
  }

  const user = await getSessionUser();

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

  if (cardInput.type === "campus" && user.role !== "admin") {
    return NextResponse.json(
      {
        error:
          "Создавать и изменять общий паспорт кампуса может только администратор канона",
      },
      { status: 403 }
    );
  }

  if (cardInput.folderId === folderIds.campus && user.role !== "admin") {
    return NextResponse.json(
      { error: "Папку общих параметров кампуса ведёт администратор канона" },
      { status: 403 }
    );
  }

  if (
    (user.role === "university_owner" || user.role === "university_pr") &&
    user.universityId
  ) {
    const folderUniversityId = extractUniversityFolderId(cardInput.folderId);
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

  if (cardInput.type === "custom") {
    try {
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
    } catch (error) {
      console.error("Ошибка проверки пользовательского типа:", error);
      return NextResponse.json(
        { error: "Не удалось проверить поля пользовательского типа" },
        { status: 500 }
      );
    }
  }

  if (user.role !== "admin" && !isCardOwner(user, cardInput.owners)) {
    cardInput = {
      ...cardInput,
      owners: [getUserOwnershipLabel(user), ...cardInput.owners],
    };
  }

  const needsJointConfirmation =
    cardInput.type === "project" && cardInput.isJoint;
  const participantApprovals =
    needsJointConfirmation &&
    user.universityId &&
    cardInput.type === "project" &&
    cardInput.participantUniversityIds.includes(user.universityId)
      ? [user.universityId]
      : [];
  const status =
    user.role === "admin" && !needsJointConfirmation ? "approved" : "pending";

  try {
    const created = await createKnowledgeCard(cardInput, {
      status,
      submittedBy: user.id,
      submittedByName: user.name,
      participantApprovals,
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

    return NextResponse.json(card, { status: 201 });
  } catch (error) {
    console.error("Ошибка создания карточки базы знаний:", error);
    return NextResponse.json(
      { error: "Ошибка создания карточки" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  if (!verifySameOrigin(request)) {
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос" },
      { status: 403 }
    );
  }

  const user = await getSessionUser();

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
    console.error("Ошибка удаления карточки базы знаний:", error);
    return NextResponse.json(
      { error: "Ошибка удаления карточки" },
      { status: 500 }
    );
  }
}
