import "../data-workspaces.css";

import { FactCheckWorkspace } from "@/components/fact-check/fact-check-workspace";
import { StorageUnavailable } from "@/components/storage-unavailable";
import { getCanonicalKnowledgeCards } from "@/lib/models";

export const dynamic = "force-dynamic";

export default async function FactCheckPage() {
  const cards = await getCanonicalKnowledgeCards().catch(() => null);
  if (!cards) return <StorageUnavailable title="Проверка текста" />;
  return <FactCheckWorkspace cardsCount={cards.length} />;
}
