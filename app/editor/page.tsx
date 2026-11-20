import { SmartEditorWorkspace } from "@/components/editor/smart-editor-workspace";
import { getSessionUser } from "@/lib/auth-server";
import { isStorageWritable, isDatabaseAvailable } from "@/lib/db";
import { mockArticles, mockKnowledgeCards } from "@/lib/mock-data";
import {
  ensureArticleSeed,
  ensureKnowledgeSeed,
  getAllArticles,
  getCanonicalKnowledgeCards,
} from "@/lib/models";
import type { ReadyArticle } from "@/lib/articles";
import { isApprovedArticle, publicArticle } from "@/lib/articles";

export const dynamic = "force-dynamic";

async function getEditorData(): Promise<{
  articles: ReadyArticle[];
  cardsCount: number;
  dbAvailable: boolean;
}> {
  if (await isStorageWritable()) {
    try {
      await Promise.all([ensureKnowledgeSeed(), ensureArticleSeed()]);
      const [articles, cards] = await Promise.all([
        getAllArticles(),
        getCanonicalKnowledgeCards(),
      ]);

      return {
        articles: articles.map(publicArticle).sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt)
        ),
        cardsCount: cards.length,
        dbAvailable: await isDatabaseAvailable(),
      };
    } catch (error) {
      console.error("Не удалось загрузить данные умного редактора:", error);
    }
  }

  return {
    articles: mockArticles.filter(isApprovedArticle).map(publicArticle),
    cardsCount: mockKnowledgeCards.length,
    dbAvailable: false,
  };
}

export default async function EditorPage() {
  const [{ articles, cardsCount, dbAvailable }, user] = await Promise.all([
    getEditorData(),
    getSessionUser(),
  ]);

  return (
    <SmartEditorWorkspace
      key={user?.id || "anonymous"}
      initialArticles={articles}
      cardsCount={cardsCount}
      dbAvailable={dbAvailable}
      currentUser={user}
    />
  );
}
