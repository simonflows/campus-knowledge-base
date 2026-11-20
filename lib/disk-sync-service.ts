import { isApprovedArticle, type ReadyArticle } from "./articles";
import { isCardApproved, type KnowledgeCard } from "./knowledge";
import { createPendingDiskSync } from "./disk-sync";
import {
  getAllArticles,
  getAllCardTypes,
  getAllKnowledgeCards,
  getArticleById,
  getKnowledgeCardById,
  setArticleDiskSync,
  setKnowledgeCardDiskSync,
} from "./models";
import { syncArticleToDisk, syncKnowledgeCardToDisk } from "./yandex-disk";

export async function syncKnowledgeCardRecord(
  card: KnowledgeCard
): Promise<KnowledgeCard> {
  if (!isCardApproved(card))
    throw Object.assign(new Error("Черновик не выгружается"), { status: 409 });
  const attemptId = crypto.randomUUID();
  const pending = {
    ...(card.diskSync ?? createPendingDiskSync()),
    status: "pending" as const,
    attemptId,
    sourceUpdatedAt: card.updatedAt,
    lastAttemptAt: new Date().toISOString(),
    message: "Выгрузка начата; при прерывании её можно безопасно повторить.",
  };
  await setKnowledgeCardDiskSync(card.id, pending, card.updatedAt);
  const [allCards, customTypes] = await Promise.all([
    getAllKnowledgeCards(),
    getAllCardTypes(),
  ]);
  const diskSync = await syncKnowledgeCardToDisk(card, allCards, customTypes);

  diskSync.attemptId = attemptId;
  await setKnowledgeCardDiskSync(card.id, diskSync, card.updatedAt, attemptId);

  return { ...card, diskSync };
}

export async function retryKnowledgeCardSync(
  id: string
): Promise<KnowledgeCard | null> {
  const card = await getKnowledgeCardById(id);

  if (!card) return null;

  return syncKnowledgeCardRecord(card);
}

export async function syncArticleRecord(
  article: ReadyArticle
): Promise<ReadyArticle> {
  if (!isApprovedArticle(article))
    throw Object.assign(new Error("Статья не согласована"), { status: 409 });
  const revisionId = article.approval!.revisionId;
  const attemptId = crypto.randomUUID();
  const pending = {
    ...(article.diskSync ?? createPendingDiskSync()),
    status: "pending" as const,
    attemptId,
    sourceUpdatedAt: article.updatedAt,
    sourceRevisionId: revisionId,
    lastAttemptAt: new Date().toISOString(),
    message: "Выгрузка начата; при прерывании её можно безопасно повторить.",
  };
  await setArticleDiskSync(article.id, pending, article.updatedAt, revisionId);
  const allArticles = await getAllArticles();
  const diskSync = await syncArticleToDisk(article, allArticles);

  diskSync.attemptId = attemptId;
  await setArticleDiskSync(
    article.id,
    diskSync,
    article.updatedAt,
    revisionId,
    attemptId
  );

  return { ...article, diskSync };
}

export async function retryArticleSync(
  id: string
): Promise<ReadyArticle | null> {
  const article = await getArticleById(id);

  if (!article) return null;

  return syncArticleRecord(article);
}
