import { FileClock } from "lucide-react";
import { z } from "zod";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getCardStatus, type KnowledgeCard } from "@/lib/knowledge";

const importedDraft = z.object({
  kind: z.literal("reviewed-package"),
  disposition: z.literal("pending"),
  packageSha256: z.string().regex(/^[a-f0-9]{64}$/i),
});

export function ImportedDraftNotice({ cards }: { cards: KnowledgeCard[] }) {
  const count = cards.filter(
    (card) =>
      getCardStatus(card) === "pending" &&
      importedDraft.safeParse(
        (card as KnowledgeCard & { importProvenance?: unknown })
          .importProvenance
      ).success
  ).length;
  if (!count) return null;

  return (
    <Alert>
      <FileClock aria-hidden="true" />
      <AlertTitle>Импортированные карточки на сверке: {count}</AlertTitle>
      <AlertDescription>
        Эти черновики подготовлены по публичным источникам. Они пока не входят в
        утверждённую базу и не используются как подтверждённые факты в ответах.
        Проверьте источники и недостающие поля, назначьте владельца и получите
        обязательные согласования перед утверждением.
      </AlertDescription>
    </Alert>
  );
}
