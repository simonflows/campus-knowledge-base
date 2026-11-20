import "../data-workspaces.css";

import { AnalyticsWorkspace } from "@/components/analytics/analytics-workspace";
import { getStorageMode } from "@/lib/db";
import { getCanonicalKnowledgeCards } from "@/lib/models";

export const dynamic = "force-dynamic";

async function getCardsCount(): Promise<{
  cardsCount: number;
  dbAvailable: boolean;
}> {
  const mode = await getStorageMode();
  try {
    const cards = await getCanonicalKnowledgeCards();
    return {
      cardsCount: cards.length,
      dbAvailable: mode === "dynamodb" || mode === "local-json",
    };
  } catch (error) {
    console.error("Не удалось загрузить карточки для аналитики:", error);
    return { cardsCount: 0, dbAvailable: false };
  }
}

export default async function AnalyticsPage() {
  const { cardsCount, dbAvailable } = await getCardsCount();

  return (
    <AnalyticsWorkspace cardsCount={cardsCount} dbAvailable={dbAvailable} />
  );
}
