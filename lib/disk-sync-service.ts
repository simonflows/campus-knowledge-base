import { isApprovedArticle, type ReadyArticle } from "./articles";
import { isCardApproved, type KnowledgeCard } from "./knowledge";
import {
  createPendingDiskSync,
  type DiskRegistry,
  type DiskRegistryCommit,
  type DiskRegistryView,
  type DiskSyncInfo,
} from "./disk-sync";
import {
  getAllArticles,
  getAllCardTypes,
  getAllKnowledgeCards,
  getArticleById,
  getDiskRegistry,
  getKnowledgeCardById,
  setArticleDiskSync,
  setKnowledgeCardDiskSync,
} from "./models";
import {
  articleRegistryFingerprint,
  cardRegistryFingerprint,
  diskAttemptDeadline,
  diskRegistryId,
  getArticleDiskFolderSegments,
  getCardDiskFolderSegments,
  syncArticleToDisk,
  syncKnowledgeCardToDisk,
} from "./yandex-disk";

const STATUS_WRITE_MS = 5_000;
const EXPORT_SCAN_MS = 8_000;

function beginAttempt(
  previous: DiskSyncInfo | undefined,
  updatedAt: string,
  revisionId?: string
): DiskSyncInfo {
  const sameVersion =
    previous?.sourceUpdatedAt === updatedAt &&
    previous.sourceRevisionId === revisionId;
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

function isPendingAttempt(
  observed: DiskSyncInfo | undefined,
  pending: DiskSyncInfo
): boolean {
  return (
    observed?.status === "pending" && observed.attemptId === pending.attemptId
  );
}

type RegistrySnapshot = {
  fingerprint: string;
  upload: () => Promise<DiskSyncInfo>;
};

async function exportWithRegistry<Result>({
  registryId,
  entityId,
  pending,
  deadline,
  scan,
  finish,
}: {
  registryId: string;
  entityId: string;
  pending: DiskSyncInfo;
  deadline: AbortSignal;
  scan: (signal: AbortSignal) => Promise<RegistrySnapshot>;
  finish: (
    state: DiskSyncInfo,
    confirm?: DiskRegistryCommit
  ) => Promise<Result>;
}): Promise<Result> {
  const scanSignal = () =>
    AbortSignal.any([deadline, AbortSignal.timeout(EXPORT_SCAN_MS)]);
  const pendingRetry: DiskSyncInfo = {
    ...createPendingDiskSync(pending),
    attemptId: pending.attemptId,
    sourceUpdatedAt: pending.sourceUpdatedAt,
    ...(pending.sourceRevisionId && {
      sourceRevisionId: pending.sourceRevisionId,
    }),
    lastAttemptAt: pending.lastAttemptAt,
    message:
      "Данные папки изменились во время выгрузки. Повторите выгрузку для получения свежей сводки.",
  };
  // A second pass uses the same source attempt, a fresh folder snapshot and the
  // latest registry guard. Never take over another revision or another attempt.
  for (let pass = 0; pass < 2 && !deadline.aborted; pass++) {
    let previous: DiskRegistry | null;
    let before: RegistrySnapshot;
    let uploaded: DiskSyncInfo;
    let afterFingerprint: string | undefined;
    try {
      previous = await getDiskRegistry(registryId, scanSignal());
      before = await scan(scanSignal());
      uploaded = { ...(await before.upload()), attemptId: pending.attemptId };
      if (uploaded.status === "synced") {
        afterFingerprint = (await scan(scanSignal())).fingerprint;
      }
    } catch {
      return finish({
        ...pending,
        status: "failed",
        message: "Не удалось проверить выгрузку. Повторите попытку.",
      });
    }
    if (uploaded.status !== "synced") return finish(uploaded);
    if (afterFingerprint !== before.fingerprint) continue;
    if (!uploaded.summaryPath || !uploaded.lastSyncedAt) {
      return finish({
        ...pending,
        status: "failed",
        message: "Диск не подтвердил полный комплект файлов.",
      });
    }

    try {
      return await finish(uploaded, {
        expectedVersionId: previous?.versionId,
        next: {
          id: registryId,
          kind: "disk-registry",
          versionId: crypto.randomUUID(),
          entityId,
          summaryPath: uploaded.summaryPath,
          confirmedAt: new Date().toISOString(),
          fingerprint: before.fingerprint,
        },
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "ConditionalCheckFailedException"
      )
        throw error;
    }
  }
  return finish(pendingRetry);
}

async function readRegistry(
  id: string,
  digest: (uploadedId: string, signal: AbortSignal) => Promise<string>
): Promise<DiskRegistryView | null> {
  const signal = AbortSignal.timeout(EXPORT_SCAN_MS);
  let selected = await getDiskRegistry(id, signal);
  for (let check = 0; selected && check < 2; check++) {
    const matches =
      selected.fingerprint === (await digest(selected.entityId, signal));
    const latest = await getDiskRegistry(id, signal);
    if (latest?.versionId === selected.versionId)
      return {
        summaryPath: selected.summaryPath,
        confirmedAt: selected.confirmedAt,
        checkedAt: new Date().toISOString(),
        current: matches,
      };
    selected = latest;
  }
  return selected
    ? {
        summaryPath: selected.summaryPath,
        confirmedAt: selected.confirmedAt,
        checkedAt: new Date().toISOString(),
        current: false,
      }
    : null;
}

export function readKnowledgeCardDiskRegistry(card: KnowledgeCard) {
  return readRegistry(
    diskRegistryId("cards", getCardDiskFolderSegments(card)),
    async (uploadedId, signal) => {
      const [cards, types] = await Promise.all([
        getAllKnowledgeCards(signal),
        getAllCardTypes(signal),
      ]);
      return cardRegistryFingerprint(card, cards, types, uploadedId);
    }
  );
}

export function readArticleDiskRegistry(article: ReadyArticle) {
  return readRegistry(
    diskRegistryId("articles", getArticleDiskFolderSegments(article)),
    async (uploadedId, signal) =>
      articleRegistryFingerprint(
        article,
        await getAllArticles(signal),
        uploadedId
      )
  );
}

export async function syncKnowledgeCardRecord(
  card: KnowledgeCard
): Promise<KnowledgeCard> {
  if (!isCardApproved(card))
    throw Object.assign(new Error("Черновик не выгружается"), { status: 409 });
  const deadline = diskAttemptDeadline();
  const pending = beginAttempt(card.diskSync, card.updatedAt);
  await setKnowledgeCardDiskSync(
    card.id,
    pending,
    card.updatedAt,
    { previous: card.diskSync },
    AbortSignal.timeout(STATUS_WRITE_MS)
  );
  return exportWithRegistry({
    registryId: diskRegistryId("cards", getCardDiskFolderSegments(card)),
    entityId: card.id,
    pending,
    deadline,
    async scan(signal) {
      const [allCards, customTypes] = await Promise.all([
        getAllKnowledgeCards(signal),
        getAllCardTypes(signal),
      ]);
      const current = allCards.find((item) => item.id === card.id);
      // A comment can advance updatedAt while preserving this pending export.
      if (
        !current ||
        !isCardApproved(current) ||
        !isPendingAttempt(current.diskSync, pending)
      )
        throw new Error("Карточка изменилась во время выгрузки.");
      return {
        fingerprint: cardRegistryFingerprint(
          card,
          allCards,
          customTypes,
          card.id
        ),
        upload: () =>
          syncKnowledgeCardToDisk(current, allCards, customTypes, deadline),
      };
    },
    async finish(state, confirmation) {
      const updated = await setKnowledgeCardDiskSync(
        card.id,
        state,
        card.updatedAt,
        pending.attemptId,
        AbortSignal.timeout(STATUS_WRITE_MS),
        confirmation
      );
      if (!updated)
        throw new Error(
          "Не удалось подтвердить сохранённое состояние выгрузки."
        );
      return updated;
    },
  });
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
  await setArticleDiskSync(
    article.id,
    pending,
    article.updatedAt,
    revisionId,
    { previous: article.diskSync },
    AbortSignal.timeout(STATUS_WRITE_MS)
  );
  return exportWithRegistry({
    registryId: diskRegistryId(
      "articles",
      getArticleDiskFolderSegments(article)
    ),
    entityId: article.id,
    pending,
    deadline,
    async scan(signal) {
      const allArticles = await getAllArticles(signal);
      const current = allArticles.find((item) => item.id === article.id);
      if (
        !current ||
        current.updatedAt !== article.updatedAt ||
        current.approval?.revisionId !== revisionId ||
        !isPendingAttempt(current.diskSync, pending)
      )
        throw new Error("Статья изменилась во время выгрузки.");
      return {
        fingerprint: articleRegistryFingerprint(
          article,
          allArticles,
          article.id
        ),
        upload: () => syncArticleToDisk(current, allArticles, deadline),
      };
    },
    async finish(state, confirmation) {
      await setArticleDiskSync(
        article.id,
        state,
        article.updatedAt,
        revisionId,
        pending.attemptId,
        AbortSignal.timeout(STATUS_WRITE_MS),
        confirmation
      );
      return { ...article, diskSync: state };
    },
  });
}

export async function retryArticleSync(
  id: string
): Promise<ReadyArticle | null> {
  const article = await getArticleById(id);

  if (!article) return null;

  return syncArticleRecord(article);
}
