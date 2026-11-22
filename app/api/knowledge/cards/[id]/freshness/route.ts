import { NextResponse } from "next/server";
import {
  canAssignCardOwner,
  canEditCard,
  visibleKnowledgeCard,
} from "@/lib/auth";
import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import { getApprovedVersion, type CardFreshness } from "@/lib/knowledge";
import { canVerifyCardFreshness } from "@/lib/knowledge-freshness";
import {
  ensureApprovedCardVersion,
  getCardVersionId,
} from "@/lib/knowledge-versions";
import { getKnowledgeCardById, setKnowledgeCardFreshness } from "@/lib/models";
import { sessionDirectory } from "@/lib/pilot-auth";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import { updateCardFreshnessSchema } from "@/lib/validation/knowledge";

function failure(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  if (!verifySameOrigin(request))
    return failure("Запрещён кросс-доменный запрос", 403);
  const user = await getSessionUser();
  if (!user)
    return failure("Войдите, чтобы обновить актуальность карточки", 401);
  try {
    if (!(await isStorageWritable())) return unavailableStorageResponse();
    const { id } = await context.params;
    const card = await getKnowledgeCardById(id);
    if (!card) return failure("Карточка не найдена", 404);
    const canEdit = canEditCard(user, card);
    if (!canEdit && !canVerifyCardFreshness(user, card))
      return failure(
        "Сверка доступна ответственному, владельцу карточки и координатору",
        403
      );
    const parsed = updateCardFreshnessSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!parsed.success) return failure("Проверьте дату и вид изменения", 400);
    const input = parsed.data;
    if (input.action === "schedule" && !canEdit) {
      return failure(
        "План сверки обновляет владелец карточки или координатор",
        403
      );
    }
    const expected = request.headers.get("If-Match");
    if (!expected)
      return failure("Укажите просмотренную редакцию карточки", 428);
    if (expected !== card.updatedAt)
      return failure("Карточка изменилась. Откройте её заново.", 409);

    const freshness: CardFreshness = { ...card.freshness };
    if (input.action === "verify") {
      const published = getApprovedVersion(card);
      if (!published || getCardVersionId(published) !== input.versionId) {
        return failure(
          "Утверждённая версия изменилась или ещё не появилась",
          409
        );
      }
      await ensureApprovedCardVersion(published);
      freshness.lastVerifiedAt = new Date().toISOString();
      freshness.verifiedVersionId = input.versionId;
      delete freshness.nextReviewAt;
    } else {
      if (input.nextReviewAt) freshness.nextReviewAt = input.nextReviewAt;
      else delete freshness.nextReviewAt;
      if (input.responsibleId !== undefined) {
        if (user.role !== "admin")
          return failure("Ответственного назначает координатор", 403);
        if (input.responsibleId === null) {
          delete freshness.responsibleId;
          delete freshness.responsibleName;
        } else {
          const responsible = sessionDirectory().find(
            (account) =>
              account.id === input.responsibleId &&
              (account.role === "admin" || canAssignCardOwner(account, getApprovedVersion(card) ?? card))
          );
          if (!responsible)
            return failure(
              "Выберите сотрудника с доступом к разделу карточки",
              400
            );
          freshness.responsibleId = responsible.id;
          freshness.responsibleName = responsible.name;
        }
      }
    }

    const updated = await setKnowledgeCardFreshness(id, freshness, expected);
    return updated
      ? NextResponse.json(visibleKnowledgeCard(user, updated), {
          headers: { "Cache-Control": "private, no-store" },
        })
      : failure("Карточка не найдена", 404);
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      return failure("Карточка изменилась. Откройте её заново.", 409);
    }
    return unavailableStorageResponse();
  }
}
