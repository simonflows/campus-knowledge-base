import { isApprovedArticle, type ReadyArticle } from "./articles";
import { isCardApproved, type KnowledgeCard } from "./knowledge";
import { createPendingDiskSync, type DiskSyncInfo } from "./disk-sync";
import {
  getAllArticles,
  getAllCardTypes,
  getAllKnowledgeCards,
  getArticleById,
  getKnowledgeCardById,
  setArticleDiskSync,
  setKnowledgeCardDiskSync,
} from "./models";
import {
  diskAttemptDeadline,
  syncArticleToDisk,
  syncKnowledgeCardToDisk,
} from "./yandex-disk";

const STATUS_WRITE_MS = 5_000;
const EXPORT_SCAN_MS = 8_000;

function beginAttempt(previous: DiskSyncInfo | undefined, updatedAt: string, revisionId?: string): DiskSyncInfo {
  const sameVersion = previous?.sourceUpdatedAt === updatedAt && previous.sourceRevisionId === revisionId;
  return {
    ...createPendingDiskSync(previous),
    ...(sameVersion && previous),
    status: "pending",
    attemptId: crypto.randomUUID(),
    sourceUpdatedAt: updatedAt,
    ...(revisionId && { sourceRevisionId: revisionId }),
    lastAttemptAt: new Date().toISOString(),
    message: "Выгрузка начата; при прерывании её можно безопасно повторить.",
  };
}

async function runExport(pending: DiskSyncInfo, upload: () => Promise<DiskSyncInfo>) {
  try {
    return { ...await upload(), attemptId: pending.attemptId };
  } catch {
    return { ...pending, status: "failed" as const, message: "Не удалось подготовить выгрузку. Повторите попытку." };
  }
}

export async function syncKnowledgeCardRecord(
  card: KnowledgeCard
): Promise<KnowledgeCard> {
  if (!isCardApproved(card))
    throw Object.assign(new Error("Черновик не выгружается"), { status: 409 });
  const deadline = diskAttemptDeadline();
  const pending = beginAttempt(card.diskSync, card.updatedAt);
  await setKnowledgeCardDiskSync(card.id, pending, card.updatedAt, { previous: card.diskSync }, AbortSignal.timeout(STATUS_WRITE_MS));
  const diskSync = await runExport(pending, async () => {
    const scan = AbortSignal.any([deadline, AbortSignal.timeout(EXPORT_SCAN_MS)]);
    const [allCards, customTypes] = await Promise.all([getAllKnowledgeCards(scan), getAllCardTypes(scan)]);
    return syncKnowledgeCardToDisk(card, allCards, customTypes, deadline);
  });
  const updated = await setKnowledgeCardDiskSync(
    card.id, diskSync, card.updatedAt, pending.attemptId, AbortSignal.timeout(STATUS_WRITE_MS)
  );
  if (!updated) throw new Error("Не удалось подтвердить сохранённое состояние выгрузки.");
  return updated;
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
  const deadline = diskAttemptDeadline();
  const pending = beginAttempt(article.diskSync, article.updatedAt, revisionId);
  await setArticleDiskSync(article.id, pending, article.updatedAt, revisionId, { previous: article.diskSync }, AbortSignal.timeout(STATUS_WRITE_MS));
  const diskSync = await runExport(pending, async () => {
    const scan = AbortSignal.any([deadline, AbortSignal.timeout(EXPORT_SCAN_MS)]);
    return syncArticleToDisk(article, await getAllArticles(scan), deadline);
  });
  await setArticleDiskSync(
    article.id,
    diskSync,
    article.updatedAt,
    revisionId,
    pending.attemptId,
    AbortSignal.timeout(STATUS_WRITE_MS)
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
