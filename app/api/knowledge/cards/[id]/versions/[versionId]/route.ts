import { NextResponse } from "next/server";
import { canSeeCard } from "@/lib/auth";
import { getSessionUser } from "@/lib/auth-server";
import { getApprovedVersion } from "@/lib/knowledge";
import {
  describeApprovedCardVersion,
  getApprovedCardVersion,
  getCardVersionId,
} from "@/lib/knowledge-versions";
import { getKnowledgeCardById } from "@/lib/models";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import { cardVersionIdSchema } from "@/lib/validation/knowledge";

function notFound() {
  return NextResponse.json(
    { error: "Версия карточки недоступна" },
    { status: 404 }
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; versionId: string }> }
) {
  try {
    const { id, versionId } = await context.params;
    if (!cardVersionIdSchema.safeParse(versionId).success) return notFound();
    const [user, card] = await Promise.all([
      getSessionUser(),
      getKnowledgeCardById(id),
    ]);
    const published = card ? getApprovedVersion(card) : null;
    if (!card || (!published && !canSeeCard(user, card))) return notFound();

    const stored = await getApprovedCardVersion(versionId);
    const version =
      stored ??
      (published && getCardVersionId(published) === versionId
        ? describeApprovedCardVersion(published, {
            legacyBaseline: true,
            recordedAt: "",
          })
        : null);
    if (!version || version.cardId !== id) return notFound();
    return NextResponse.json(
      { ...version, actorId: undefined, indicatorConfirmations: undefined },
      {
        headers: { "Cache-Control": "private, no-store" },
      }
    );
  } catch {
    return unavailableStorageResponse();
  }
}
