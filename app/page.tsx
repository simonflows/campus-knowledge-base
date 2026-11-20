import { HomeDashboard } from "@/components/home-dashboard";
import { universities } from "@/lib/data";
import { isStorageWritable } from "@/lib/db";
import { mockKnowledgeCards } from "@/lib/mock-data";
import { ensureKnowledgeSeed, getCanonicalKnowledgeCards } from "@/lib/models";
import { canSeeCard } from "@/lib/auth";
import { getSessionUser } from "@/lib/auth-server";
import type { KnowledgeCard, CampusCard } from "@/lib/knowledge";
export const dynamic = "force-dynamic";
export default async function HomePage() {
  const user = await getSessionUser();
  let cards: KnowledgeCard[] = mockKnowledgeCards;
  let live = false;
  if (await isStorageWritable()) {
    try {
      await ensureKnowledgeSeed();
      cards = await getCanonicalKnowledgeCards();
      live = true;
    } catch (error) {
      console.error("Не удалось загрузить данные главной", error);
    }
  }
  const visible = cards.filter((card) => canSeeCard(user, card));
  const passport =
    visible.find(
      (card): card is CampusCard =>
        card.type === "campus" &&
        card.id === "campus-passport" &&
        (card.status ?? "approved") === "approved"
    ) ?? null;
  return (
    <HomeDashboard
      passport={passport}
      universities={universities}
      cardsCount={visible.length}
      live={live}
    />
  );
}
