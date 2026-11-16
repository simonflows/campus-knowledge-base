import { AnalyticsWorkspace } from "@/components/analytics/analytics-workspace";
import { isStorageWritable } from "@/lib/db";
import { mockKnowledgeCards } from "@/lib/mock-data";
import { ensureKnowledgeSeed, getCanonicalKnowledgeCards } from "@/lib/models";

export const dynamic = "force-dynamic";

async function getCardsCount(): Promise<{
  cardsCount: number;
  dbAvailable: boolean;
}> {
  if (await isStorageWritable()) {
    try {
      await ensureKnowledgeSeed();
      const cards = await getCanonicalKnowledgeCards();
      return { cardsCount: cards.length, dbAvailable: true };
    } catch (error) {
      console.error("Не удалось загрузить карточки для аналитики:", error);
    }
  }

  return {
    cardsCount: mockKnowledgeCards.length,
    dbAvailable: false,
  };
}

export default async function AnalyticsPage() {
  const { cardsCount, dbAvailable } = await getCardsCount();

  return (
    <AnalyticsWorkspace cardsCount={cardsCount} dbAvailable={dbAvailable} />
  );
}
