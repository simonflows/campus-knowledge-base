import { SmartEditorWorkspace } from "@/components/editor/smart-editor-workspace";
import { getSessionUser } from "@/lib/auth-server";
import { StorageUnavailable } from "@/components/storage-unavailable";
import { getReadableStorageMode } from "@/lib/runtime-storage-policy";
import { getAllArticles, getCanonicalKnowledgeCards } from "@/lib/models";
import { publicArticle } from "@/lib/articles";
import { showFlashAssist } from "@/lib/flash-assist";

export const dynamic = "force-dynamic";

function linkedId(value?: string | string[]) {
  return typeof value === "string" && value.length <= 100 && /^[a-z0-9][a-z0-9._-]*$/i.test(value)
    ? value : undefined;
}

export default async function EditorPage({ searchParams }: {
  searchParams: Promise<{ draft?: string | string[]; article?: string | string[] }>;
}) {
  const [data, user, params] = await Promise.all([
    Promise.all([
      getAllArticles(),
      getCanonicalKnowledgeCards(),
      getReadableStorageMode(),
    ]).catch(() => null),
    getSessionUser(),
    searchParams,
  ]);
  if (!data) return <StorageUnavailable title="Редактор публикаций" />;
  const [articles, cards, mode] = data;
  const initialArticles = articles
    .map(publicArticle)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const initialDocumentId = linkedId(params.draft);
  const initialArticleId = initialDocumentId ? undefined : linkedId(params.article);

  return (
    <SmartEditorWorkspace
      key={user?.id || "anonymous"}
      initialArticles={initialArticles}
      cardsCount={cards.length}
      dbAvailable={mode === "dynamodb"}
      currentUser={user}
      flashAssistAvailable={showFlashAssist(user)}
      initialDocumentId={initialDocumentId}
      initialArticleId={initialArticleId}
    />
  );
}
