import { HomeDashboard } from "@/components/home-dashboard";
import { universities } from "@/lib/data";
import { getReadableStorageMode } from "@/lib/runtime-storage-policy";
import { StorageUnavailable } from "@/components/storage-unavailable";
import { getCanonicalKnowledgeCards } from "@/lib/models";
import { canSeeCard } from "@/lib/auth";
import { getSessionUser } from "@/lib/auth-server";
import type { CampusCard } from "@/lib/knowledge";

export const dynamic = "force-dynamic";
export default async function HomePage() {
  const data = await Promise.all([
    getSessionUser(),
    getCanonicalKnowledgeCards(),
    getReadableStorageMode(),
  ]).catch(() => null);
  if (!data) return <StorageUnavailable title="Справочник кампуса" />;
  const [user, cards, mode] = data;
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
      showExampleData={mode === "static-export"}
      hasMidisPassport={visible.some((card) => card.id === "university-midis")}
    />
  );
}
