import "@/app/data-workspaces.css";

import { FactCheckWorkspace } from "@/components/fact-check/fact-check-workspace";
import { StorageUnavailable } from "@/components/storage-unavailable";
import { getSessionUser } from "@/lib/auth-server";
import { showFlashAssist } from "@/lib/flash-assist";
import { getCanonicalKnowledgeCards } from "@/lib/models";
import { buildApprovedFactExample } from "@/lib/fact-training-example";
import { getCardVersionId } from "@/lib/knowledge-versions";

export const dynamic = "force-dynamic";

export default async function FactCheckPage() {
  const [cards, user] = await Promise.all([
    getCanonicalKnowledgeCards().catch(() => null),
    getSessionUser(),
  ]);
  if (!cards) return <StorageUnavailable title="Проверка текста" />;
  return (
    <FactCheckWorkspace
      cardsCount={cards.length}
      flashAssistAvailable={showFlashAssist(user)}
      approvedExample={buildApprovedFactExample(cards, getCardVersionId)}
    />
  );
}
