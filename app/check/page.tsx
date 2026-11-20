import "../data-workspaces.css";

import { FactCheckWorkspace } from "@/components/fact-check/fact-check-workspace";
import { isStorageWritable } from "@/lib/db";
import { mockKnowledgeCards } from "@/lib/mock-data";
import { ensureKnowledgeSeed, getCanonicalKnowledgeCards } from "@/lib/models";

export const dynamic = "force-dynamic";

async function getCardsCount(): Promise<number> {
  if (await isStorageWritable()) {
    try {
      await ensureKnowledgeSeed();
      const cards = await getCanonicalKnowledgeCards();
      return cards.length;
    } catch (error) {
      console.error(
        "Не удалось загрузить карточки для проверки текста:",
        error
      );
    }
  }

  return mockKnowledgeCards.length;
}

export default async function FactCheckPage() {
  const cardsCount = await getCardsCount();

  return <FactCheckWorkspace cardsCount={cardsCount} />;
}
