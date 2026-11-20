import "../data-workspaces.css";

import { BookOpenCheck } from "lucide-react";
import Link from "next/link";

import { KnowledgeBase } from "@/components/knowledge/knowledge-base";
import { visibleKnowledgeCards, type SessionUser } from "@/lib/auth";
import { getSessionUser } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import {
  ensureKnowledgeSeed,
  getAllCardTypes,
  getAllKnowledgeCards,
  customCardCounts,
} from "@/lib/models";
import { mockCustomCardTypes, mockKnowledgeCards } from "@/lib/mock-data";
import {
  getPublicApprovedCard,
  type CardTypeDefinition,
  type CardTypeWithStats,
  type KnowledgeCard,
} from "@/lib/knowledge";

export const dynamic = "force-dynamic";

function withStats(
  types: CardTypeDefinition[],
  counts: Record<string, number>
): CardTypeWithStats[] {
  return types.map((type) => ({ ...type, cardCount: counts[type.id] ?? 0 }));
}

async function getKnowledgeData(user: SessionUser | null): Promise<{
  cards: KnowledgeCard[];
  customTypes: CardTypeWithStats[];
  dbAvailable: boolean;
}> {
  if (await isStorageWritable()) {
    try {
      await ensureKnowledgeSeed();
      const [cards, types] = await Promise.all([
        getAllKnowledgeCards(),
        getAllCardTypes(),
      ]);

      const visible = visibleKnowledgeCards(user, cards);
      return {
        cards: visible,
        customTypes: withStats(types, customCardCounts(visible)),
        dbAvailable: true,
      };
    } catch (error) {
      console.error("Не удалось загрузить данные базы знаний:", error);
    }
  }

  return {
    cards: visibleKnowledgeCards(user, mockKnowledgeCards),
    customTypes: withStats(mockCustomCardTypes, {}),
    dbAvailable: false,
  };
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{
    card?: string;
    action?: string;
    folder?: string;
    q?: string;
    version?: string;
  }>;
}) {
  const user = await getSessionUser();
  const [{ cards, customTypes, dbAvailable }, params] = await Promise.all([
    getKnowledgeData(user),
    searchParams,
  ]);

  const approvedOnly = params.version === "approved";
  return (
    <>
      {approvedOnly ? (
        <div className="atlas-wrap data-index-version">
          <p>
            <BookOpenCheck className="size-4" aria-hidden="true" />
            Утверждённая версия из источника
          </p>
          {params.card ? (
            <Link href={`/knowledge?card=${encodeURIComponent(params.card)}`}>
              Открыть карточку в справочнике
            </Link>
          ) : null}
        </div>
      ) : null}
      <KnowledgeBase
        key={JSON.stringify(params)}
        initialQuery={params.q ?? ""}
        initialCards={
          approvedOnly
            ? cards.flatMap((card) => {
                const approved = getPublicApprovedCard(card);
                return approved ? [approved] : [];
              })
            : cards
        }
        initialCustomTypes={customTypes}
        initialCardId={params.card ?? null}
        initialAction={approvedOnly ? null : (params.action ?? null)}
        initialFolderId={params.folder ?? null}
        dbAvailable={dbAvailable}
        currentUser={approvedOnly ? null : user}
      />
    </>
  );
}
