import "../data-workspaces.css";

import { AnalyticsWorkspace } from "@/components/analytics/analytics-workspace";
import { StorageUnavailable } from "@/components/storage-unavailable";
import { getReadableStorageMode } from "@/lib/runtime-storage-policy";
import { getCanonicalKnowledgeCards } from "@/lib/models";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const data = await Promise.all([
    getCanonicalKnowledgeCards(),
    getReadableStorageMode(),
  ]).catch(() => null);
  if (!data) return <StorageUnavailable title="Аналитика кампуса" />;
  const [cards, mode] = data;
  return (
    <AnalyticsWorkspace
      cardsCount={cards.length}
      dbAvailable={mode !== "static-export"}
    />
  );
}
