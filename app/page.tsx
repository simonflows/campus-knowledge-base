import { HomeDashboard } from "@/components/home-dashboard";
import {
  campusMetrics,
  databaseUpdates,
  heroStats,
  legalEntities,
  universities,
} from "@/lib/data";
import { isStorageWritable } from "@/lib/db";
import { mockArticles, mockKnowledgeCards } from "@/lib/mock-data";
import {
  ensureArticleSeed,
  ensureKnowledgeSeed,
  getAllArticles,
  getCanonicalKnowledgeCards,
} from "@/lib/models";

export const dynamic = "force-dynamic";

async function getHomeCounts() {
  if (await isStorageWritable()) {
    try {
      await Promise.all([ensureKnowledgeSeed(), ensureArticleSeed()]);
      const [cards, articles] = await Promise.all([
        getCanonicalKnowledgeCards(),
        getAllArticles(),
      ]);
      return {
        cardsCount: cards.length,
        articlesCount: articles.length,
      };
    } catch (error) {
      console.error("Не удалось загрузить счётчики для главной:", error);
    }
  }

  return {
    cardsCount: mockKnowledgeCards.length,
    articlesCount: mockArticles.length,
  };
}

export default async function HomePage() {
  const { cardsCount, articlesCount } = await getHomeCounts();

  const liveStats = heroStats.map((stat, index) => {
    if (index === 0) return { ...stat, value: String(cardsCount) };
    if (index === 1) return { ...stat, value: String(articlesCount) };
    return stat;
  });

  return (
    <HomeDashboard
      heroStats={liveStats}
      cardsCount={cardsCount}
      articlesCount={articlesCount}
      campusMetrics={campusMetrics}
      legalEntities={legalEntities}
      universities={universities}
      databaseUpdates={databaseUpdates}
    />
  );
}
