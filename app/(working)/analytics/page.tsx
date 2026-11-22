import "@/app/data-workspaces.css";

import { AnalyticsWorkspace } from "@/components/analytics/analytics-workspace";
import { StorageUnavailable } from "@/components/storage-unavailable";
import { getSessionUser } from "@/lib/auth-server";
import { getAnalyticsExamples } from "@/lib/analytics";
import { showFlashAssist } from "@/lib/flash-assist";
import { getReadableStorageMode } from "@/lib/runtime-storage-policy";
import { getAllCardTypes, getCanonicalKnowledgeCards } from "@/lib/models";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const user = await getSessionUser();
  if (!user || user.role === "guest") redirect("/login?next=/analytics&reason=staff");
  const data = await Promise.all([
      getCanonicalKnowledgeCards(),
      getReadableStorageMode(),
      getAllCardTypes(),
    ]).catch(() => null);
  if (!data) return <StorageUnavailable title="Аналитика кампуса" />;
  const [cards, mode, types] = data;
  return (
    <AnalyticsWorkspace
      cardsCount={cards.length}
      dbAvailable={mode !== "static-export"}
      flashAssistAvailable={showFlashAssist(user)}
      dynamicExamples={getAnalyticsExamples(cards, types)}
    />
  );
}
