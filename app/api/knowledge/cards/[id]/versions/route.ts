import { NextResponse } from "next/server";
import { canSeeCard } from "@/lib/auth";
import { getSessionUser } from "@/lib/auth-server";
import { getApprovedVersion } from "@/lib/knowledge";
import { canVerifyCardFreshness } from "@/lib/knowledge-freshness";
import {
  describeApprovedCardVersion,
  getApprovedCardVersions,
  getCardVersionId,
} from "@/lib/knowledge-versions";
import { getKnowledgeCardById } from "@/lib/models";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const [user, card] = await Promise.all([
      getSessionUser(),
      getKnowledgeCardById(id),
    ]);
    const published = card ? getApprovedVersion(card) : null;
    if (!card || (!published && !canSeeCard(user, card))) {
      return NextResponse.json(
        { error: "Карточка не найдена" },
        { status: 404 }
      );
    }
    const currentVersionId = published ? getCardVersionId(published) : null;
    const versions = await getApprovedCardVersions(id);
    if (
      published &&
      !versions.some((version) => version.id === currentVersionId)
    ) {
      versions.unshift(
        describeApprovedCardVersion(published, {
          legacyBaseline: true,
          recordedAt: "",
        })
      );
    }
    return NextResponse.json(
      {
        currentVersionId,
        cardUpdatedAt: card.updatedAt,
        publishedUpdatedAt: published?.updatedAt ?? null,
        canVerifyFreshness: canVerifyCardFreshness(user, card),
        versions: versions.map(
          ({ id, recordedAt, actorName, reason, legacyBaseline }) => ({
            id,
            recordedAt,
            actorName,
            reason,
            legacyBaseline,
          })
        ),
        ...(user?.role === "admin" && {
          responsibleId: card.freshness?.responsibleId,
        }),
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch {
    return unavailableStorageResponse();
  }
}
