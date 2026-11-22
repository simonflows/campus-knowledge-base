import { isApprovedArticle, type ReadyArticle } from "./articles";
import { getApprovedVersion, type KnowledgeCard } from "./knowledge";
import {
  createPendingDiskSync,
  diskRegistrySequence,
  type DiskAttemptGuard,
  type DiskRegistry,
  type DiskRegistryCommit,
  type DiskRegistryView,
  type DiskSyncInfo,
} from "./disk-sync";
import {
  claimDiskRegistryReceipt,
  finishDiskRegistryReceipt,
  getAllArticles,
  getAllCardTypes,
  getAllKnowledgeCards,
  getArticleById,
  getDiskRegistry,
  getKnowledgeCardById,
  replaceDiskRegistry,
  setArticleDiskSync,
  setKnowledgeCardDiskSync,
  setKnowledgeSnapshotDiskSync,
} from "./models";
import {
  articleRegistryFingerprint,
  cardRegistryFingerprint,
  countArticleSummaryPending,
  countCardSummaryPending,
  diskAttemptDeadline,
  diskRegistryId,
  EMPTY_DISK_REGISTRY_FINGERPRINT,
  ensureDiskBackupTree,
  getArticleDiskFolderSegments,
  getCardDiskFolderSegments,
  isYandexDiskConfigured,
  syncArticleToDisk,
  syncKnowledgeCardToDisk,
  uploadDiskRegistryReceipt,
  uploadEmptyDiskSummary,
  verifyLegacyDiskSummary,
  YandexDiskError,
} from "./yandex-disk";

const STATUS_WRITE_MS = 5_000;
const EXPORT_SCAN_MS = 8_000;

function diskPublicationEnabled() {
  return process.env.NODE_ENV === "production" &&
    process.env.CAMPUS_LOCAL_DEMO !== "true" && process.env.CAMPUS_FULL_LOCAL_DEMO !== "true" &&
    process.env.NEXT_PUBLIC_DEMO_MODE !== "true" && process.env.CAMPUS_DEMO_LOGIN !== "true" &&
    process.env.OUTPUT_MODE !== "export" && isYandexDiskConfigured();
}

export function diskRecoveryEnabled() {
  return diskPublicationEnabled() && process.env.CANON_DISK_RECOVERY === "true";
}

function isDiskConflict(error: unknown) {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

export async function publishDiskRegistryReceipt(registry: DiskRegistry, deadline: AbortSignal) {
  const signal = () => AbortSignal.any([deadline, AbortSignal.timeout(STATUS_WRITE_MS)]);
  const attemptedAt = new Date().toISOString();
  try {
    if (!(await claimDiskRegistryReceipt(registry, attemptedAt, signal()))) return false;
  } catch (error) {
    if (isDiskConflict(error)) return false;
    throw error;
  }
  let path: string;
  try {
    if (registry.sequence === undefined && !(await verifyLegacyDiskSummary(registry, deadline))) {
      await finishDiskRegistryReceipt(registry, attemptedAt, {
        error: "Старый CSV отсутствует или его контрольная сумма не совпадает. Требуется новая сводка.",
        summaryInvalid: true,
      }, AbortSignal.timeout(STATUS_WRITE_MS));
      return false;
    }
    path = await uploadDiskRegistryReceipt(registry, deadline);
  } catch (error) {
    const status = error instanceof YandexDiskError ? error.status : undefined;
    const message = status ? `Диск отклонил запись подтверждения (HTTP ${status}).` : "Не удалось разместить подтверждение сводки.";
    await finishDiskRegistryReceipt(registry, attemptedAt, { error: message }, AbortSignal.timeout(STATUS_WRITE_MS))
      .catch(failure => { if (!isDiskConflict(failure)) throw failure; });
    return false;
  }
  try {
    await finishDiskRegistryReceipt(registry, attemptedAt, { path }, AbortSignal.timeout(STATUS_WRITE_MS));
    return true;
  } catch (error) {
    if (isDiskConflict(error)) return false;
    throw error;
  }
}

export async function confirmEmptyDiskRegistry(
  registry: DiskRegistry, isEmpty: (signal: AbortSignal) => Promise<boolean>,
) {
  const deadline = diskAttemptDeadline();
  if (!(await isEmpty(deadline))) return false;
  const confirmedAt = new Date().toISOString();
  const summaryPath = await uploadEmptyDiskSummary({ ...registry, confirmedAt }, deadline);
  if (!(await isEmpty(deadline))) return false;
  const next: DiskRegistry = {
    id: registry.id, kind: "disk-registry", entityId: "",
    versionId: crypto.randomUUID(), summaryPath, confirmedAt,
    fingerprint: EMPTY_DISK_REGISTRY_FINGERPRINT,
    sequence: diskRegistrySequence(registry) + 1, pendingRows: 0,
  };
  try {
    await replaceDiskRegistry({ expectedVersionId: registry.versionId, next }, AbortSignal.timeout(STATUS_WRITE_MS));
  } catch (error) {
    if (isDiskConflict(error)) return false;
    throw error;
  }
  await publishDiskRegistryReceipt(next, deadline).catch(() => false);
  return true;
}

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
  pendingRows: number;
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
    } catch (error) {
      const status = error instanceof YandexDiskError ? error.status : undefined;
      return finish({
        ...pending,
        status: "failed",
        message: status ? `Диск отклонил выгрузку (HTTP ${status}).` : "Не удалось проверить выгрузку. Повторите попытку.",
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
      const next: DiskRegistry = {
        id: registryId,
        kind: "disk-registry",
        versionId: crypto.randomUUID(),
        entityId,
        summaryPath: uploaded.summaryPath,
        confirmedAt: new Date().toISOString(),
        fingerprint: before.fingerprint,
        sequence: diskRegistrySequence(previous) + 1,
        pendingRows: before.pendingRows,
      };
      const result = await finish(uploaded, {
        expectedVersionId: previous?.versionId,
        next,
      });
      if (diskPublicationEnabled()) await publishDiskRegistryReceipt(next, deadline).catch(() => false);
      return result;
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
    const matches = !selected.summaryInvalid &&
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
  const published = getApprovedVersion(card) ?? card;
  return readRegistry(
    diskRegistryId("cards", getCardDiskFolderSegments(published)),
    async (uploadedId, signal) => {
      const [cards, types] = await Promise.all([
        getAllKnowledgeCards(signal),
        getAllCardTypes(signal),
      ]);
      return cardRegistryFingerprint(published, cards, types, uploadedId);
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
  const published = getApprovedVersion(card);
  if (!published)
    throw Object.assign(new Error("Черновик не выгружается"), { status: 409 });
  const deadline = diskAttemptDeadline();
  const snapshot = published !== card;
  const pending = beginAttempt(published.diskSync, published.updatedAt);
  const writeState = (state: DiskSyncInfo, guard: DiskAttemptGuard, confirmation?: DiskRegistryCommit) => {
    const signal = AbortSignal.timeout(STATUS_WRITE_MS);
    return snapshot ? setKnowledgeSnapshotDiskSync(card, published, state, guard, signal, confirmation)
      : setKnowledgeCardDiskSync(card.id, state, card.updatedAt, guard, signal, confirmation);
  };
  await writeState(pending, { previous: published.diskSync });
  return exportWithRegistry({
    registryId: diskRegistryId("cards", getCardDiskFolderSegments(published)),
    entityId: card.id,
    pending,
    deadline,
    async scan(signal) {
      const [allCards, customTypes] = await Promise.all([
        getAllKnowledgeCards(signal),
        getAllCardTypes(signal),
      ]);
      const current = allCards.find((item) => item.id === card.id);
      const exportable = current && getApprovedVersion(current);
      // A comment can advance updatedAt while preserving this pending export.
      if (
        !exportable || (exportable !== current) !== snapshot ||
        (snapshot && (current?.updatedAt !== card.updatedAt || exportable.updatedAt !== published.updatedAt)) ||
        !isPendingAttempt(exportable.diskSync, pending)
      )
        throw new Error("Карточка изменилась во время выгрузки.");
      return {
        fingerprint: cardRegistryFingerprint(
          published,
          allCards,
          customTypes,
          card.id
        ),
        pendingRows: countCardSummaryPending(published, allCards, card.id),
        upload: async () => {
          if (diskPublicationEnabled()) await ensureDiskBackupTree(deadline);
          return syncKnowledgeCardToDisk(exportable, allCards, customTypes, deadline);
        },
      };
    },
    async finish(state, confirmation) {
      const updated = await writeState(state, pending.attemptId!, confirmation);
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
        pendingRows: countArticleSummaryPending(article, allArticles, article.id),
        upload: async () => {
          if (diskPublicationEnabled()) await ensureDiskBackupTree(deadline);
          return syncArticleToDisk(current, allArticles, deadline);
        },
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
