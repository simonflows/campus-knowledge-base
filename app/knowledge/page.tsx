import { KnowledgeBase } from "@/components/knowledge/knowledge-base";
import { canSeeCard, type SessionUser } from "@/lib/auth";
import { getSessionUser } from "@/lib/auth-server";
import { isStorageWritable } from "@/lib/db";
import {
  ensureKnowledgeSeed,
  getAllCardTypes,
  getAllKnowledgeCards,
  getCustomCardCounts,
} from "@/lib/models";
import { mockCustomCardTypes, mockKnowledgeCards } from "@/lib/mock-data";
import type {
  CardTypeDefinition,
  CardTypeWithStats,
  KnowledgeCard,
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
      const [cards, types, counts] = await Promise.all([
        getAllKnowledgeCards(),
        getAllCardTypes(),
        getCustomCardCounts(),
      ]);

      return {
        cards: cards.filter((card) => canSeeCard(user, card)),
        customTypes: withStats(types, counts),
        dbAvailable: true,
      };
    } catch (error) {
      console.error("Не удалось загрузить данные базы знаний:", error);
    }
  }

  return {
    cards: mockKnowledgeCards.filter((card) => canSeeCard(user, card)),
    customTypes: withStats(mockCustomCardTypes, {}),
    dbAvailable: false,
  };
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ card?: string; action?: string; folder?: string }>;
}) {
  const user = await getSessionUser();
  const [{ cards, customTypes, dbAvailable }, params] = await Promise.all([
    getKnowledgeData(user),
    searchParams,
  ]);

  return (
    <KnowledgeBase
      initialCards={cards}
      initialCustomTypes={customTypes}
      initialCardId={params.card ?? null}
      initialAction={params.action ?? null}
      initialFolderId={params.folder ?? null}
      dbAvailable={dbAvailable}
      currentUser={user}
    />
  );
}
