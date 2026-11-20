import { NextRequest, NextResponse } from "next/server";

import {
  areCardOwnerIdsAssignable,
  canAssignCardOwner,
  canCreateCard,
  visibleKnowledgeCard,
  visibleKnowledgeCards,
  getUserOwnershipLabel,
  isCardOwner,
  resolveLegacyCardOwnerIds,
} from "@/lib/auth";
import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import { syncKnowledgeCardRecord } from "@/lib/disk-sync-service";
import { folderIds } from "@/lib/knowledge";
import { sessionDirectory } from "@/lib/pilot-auth";
import {
  createKnowledgeCard,
  deleteKnowledgeCard,
  getAllKnowledgeCards,
  getCardTypeById,
} from "@/lib/models";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import {
  buildCustomFieldValuesSchema,
  knowledgeCardInputSchema,
} from "@/lib/validation/knowledge";

export async function GET() {
  const user = await getSessionUser();
  try {
    const cards = await getAllKnowledgeCards();
    return NextResponse.json(visibleKnowledgeCards(user, cards), { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return unavailableStorageResponse();
  }
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
    } catch {
      return unavailableStorageResponse();
    }
  }

  if (user.role === "admin") {
    const directory = sessionDirectory();
    const ownerIds = cardInput.ownerIds ?? resolveLegacyCardOwnerIds(cardInput, directory) ?? [];
    if (!areCardOwnerIdsAssignable(cardInput, ownerIds, directory)) {
      return NextResponse.json(
        { error: "Владельцы должны иметь доступ к этому разделу карточек" },
        { status: 400 }
      );
    }
    cardInput = { ...cardInput, ownerIds };
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

    return NextResponse.json(visibleKnowledgeCard(user, card), { status: 201 });
  } catch {
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
  } catch {
    return unavailableStorageResponse();
  }
}
