import "../data-workspaces.css";

import { AnalyticsWorkspace } from "@/components/analytics/analytics-workspace";
import { StorageUnavailable } from "@/components/storage-unavailable";
import { getSessionUser } from "@/lib/auth-server";
import { showFlashAssist } from "@/lib/flash-assist";
import { getReadableStorageMode } from "@/lib/runtime-storage-policy";
import { getCanonicalKnowledgeCards } from "@/lib/models";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const [data, user] = await Promise.all([
    Promise.all([
      getCanonicalKnowledgeCards(),
      getReadableStorageMode(),
    ]).catch(() => null),
    getSessionUser(),
  ]);
  if (!data) return <StorageUnavailable title="Аналитика кампуса" />;
  const [cards, mode] = data;
  return (
    <AnalyticsWorkspace
      cardsCount={cards.length}
      dbAvailable={mode !== "static-export"}
      flashAssistAvailable={showFlashAssist(user)}
    />
  );
}
