import { SmartEditorWorkspace } from "@/components/editor/smart-editor-workspace";
import { getSessionUser } from "@/lib/auth-server";
import { StorageUnavailable } from "@/components/storage-unavailable";
import { getReadableStorageMode } from "@/lib/runtime-storage-policy";
import { getAllArticles, getCanonicalKnowledgeCards } from "@/lib/models";
import { publicArticle } from "@/lib/articles";

export const dynamic = "force-dynamic";

export default async function EditorPage() {
  const [data, user] = await Promise.all([
    Promise.all([
      getAllArticles(),
      getCanonicalKnowledgeCards(),
      getReadableStorageMode(),
    ]).catch(() => null),
    getSessionUser(),
  ]);
  if (!data) return <StorageUnavailable title="Редактор публикаций" />;
  const [articles, cards, mode] = data;
  const initialArticles = articles
    .map(publicArticle)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <SmartEditorWorkspace
      key={user?.id || "anonymous"}
      initialArticles={initialArticles}
      cardsCount={cards.length}
      dbAvailable={mode === "dynamodb"}
      currentUser={user}
    />
  );
}
