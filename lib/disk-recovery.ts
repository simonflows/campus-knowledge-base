import { isApprovedArticle, type ReadyArticle } from "./articles";
import { getWritableStorageMode } from "./db";
import {
  confirmEmptyDiskRegistry, diskRecoveryEnabled, publishDiskRegistryReceipt, syncArticleRecord, syncKnowledgeCardRecord,
} from "./disk-sync-service";
import {
  DISK_RECOVERY_FAILURE_MS, diskReceiptDue, diskRecoveryDue, isDiskSyncCurrent, type DiskRegistry,
} from "./disk-sync";
import { getApprovedVersion, type CardTypeDefinition, type KnowledgeCard } from "./knowledge";
import { getAllArticles, getAllCardTypes, getAllDiskRegistries, getAllKnowledgeCards, noteDiskRegistryRebuildError } from "./models";
import {
  articleRegistryFingerprint, cardRegistryFingerprint, countArticleSummaryPending, countCardSummaryPending,
  diskAttemptDeadline, diskRegistryFolder, diskRegistryId, EMPTY_DISK_REGISTRY_FINGERPRINT, ensureDiskBackupTree,
  getArticleDiskFolderSegments, getCardDiskFolderSegments, isDiskBackupTreeReady, YandexDiskError,
} from "./yandex-disk";

type Material =
  | { kind: "cards"; stored: KnowledgeCard; approved: KnowledgeCard }
  | { kind: "articles"; approved: ReadyArticle };

type Inventory = {
  cards: KnowledgeCard[];
  articles: ReadyArticle[];
  types: CardTypeDefinition[];
  registries: DiskRegistry[];
};

type RecoveryJob =
  | { action: "transfer"; queuedAt: number; material: Material }
  | { action: "receipt"; queuedAt: number; registry: DiskRegistry }
  | { action: "empty"; queuedAt: number; registry: DiskRegistry };

function folder(material: Material): string {
  return material.kind === "cards"
    ? diskRegistryId("cards", getCardDiskFolderSegments(material.approved))
    : diskRegistryId("articles", getArticleDiskFolderSegments(material.approved));
}

function revisionId(material: Material) {
  return material.kind === "articles" ? material.approved.approval?.revisionId : undefined;
}

function current(material: Material) {
  return isDiskSyncCurrent(material.approved.diskSync, material.approved.updatedAt, revisionId(material));
}

function ageKey(at?: string | null) {
  return Date.parse(at ?? "") || 0;
}

export function planDiskRecovery(inventory: Inventory, now: number): RecoveryJob[] {
  const materials: Material[] = [
    ...inventory.cards.flatMap(stored => {
      const approved = getApprovedVersion(stored);
      return approved ? [{ kind: "cards" as const, stored, approved }] : [];
    }),
    ...inventory.articles.filter(isApprovedArticle).map(approved => ({ kind: "articles" as const, approved })),
  ];
  const groups = new Map<string, Material[]>();
  const jobs: RecoveryJob[] = [];
  const scheduledFolders = new Set<string>();
  for (const material of materials) {
    const id = folder(material);
    const group = groups.get(id) ?? [];
    group.push(material);
    groups.set(id, group);
    const { diskSync, updatedAt } = material.approved;
    if (diskRecoveryDue(diskSync, updatedAt, revisionId(material), now)) {
      jobs.push({ action: "transfer", queuedAt: ageKey(diskSync?.lastAttemptAt), material });
      scheduledFolders.add(id);
    }
  }

  for (const registry of inventory.registries) {
    if (!diskRegistryFolder(registry)) continue;
    const assets = groups.get(registry.id) ?? [];
    groups.delete(registry.id);
    const sample = assets[0];
    const pending = sample?.kind === "cards"
      ? countCardSummaryPending(sample.approved, inventory.cards, registry.entityId)
      : sample ? countArticleSummaryPending(sample.approved, inventory.articles, registry.entityId) : 0;
    const fingerprint = sample?.kind === "cards"
      ? cardRegistryFingerprint(sample.approved, inventory.cards, inventory.types, registry.entityId)
      : sample ? articleRegistryFingerprint(sample.approved, inventory.articles, registry.entityId) : EMPTY_DISK_REGISTRY_FINGERPRINT;
    const queuedAt = ageKey(registry.confirmedAt);
    if (registry.summaryInvalid || registry.fingerprint !== fingerprint) {
      if (!sample && !(now - ageKey(registry.rebuildLastAttemptAt) < DISK_RECOVERY_FAILURE_MS)) {
        jobs.push({ action: "empty", queuedAt, registry });
      } else if (!scheduledFolders.has(registry.id)) {
        const ready = assets.find(current);
        if (ready) jobs.push({ action: "transfer", queuedAt, material: ready });
      }
    } else if (diskReceiptDue(registry, now)) {
      jobs.push({ action: "receipt", queuedAt, registry: { ...registry, pendingRows: registry.pendingRows ?? pending } });
    }
  }
  for (const assets of groups.values()) {
    if (assets.every(current)) {
      jobs.push({ action: "transfer", queuedAt: ageKey(assets[0].approved.diskSync?.lastAttemptAt), material: assets[0] });
    }
  }
  return jobs.sort((left, right) => left.queuedAt - right.queuedAt);
}

async function folderIsEmpty(registry: DiskRegistry, signal: AbortSignal): Promise<boolean> {
  const scope = diskRegistryFolder(registry);
  if (!scope) return false;
  if (scope.kind === "articles") {
    return !(await getAllArticles(signal)).some(article => diskRegistryId("articles", getArticleDiskFolderSegments(article)) === registry.id);
  }
  return !(await getAllKnowledgeCards(signal)).some(raw => {
    const published = getApprovedVersion(raw);
    return published && diskRegistryId("cards", getCardDiskFolderSegments(published)) === registry.id;
  });
}

export async function runDiskRecoveryPass(now = Date.now()) {
  if (!diskRecoveryEnabled() || await getWritableStorageMode() !== "dynamodb") return 0;
  const initialized = isDiskBackupTreeReady();
  await ensureDiskBackupTree();
  const signal = AbortSignal.timeout(8_000);
  const [cards, articles, types, registries] = await Promise.all([
    getAllKnowledgeCards(signal), getAllArticles(signal), getAllCardTypes(signal), getAllDiskRegistries(signal),
  ]);
  const jobs = planDiskRecovery({ cards, articles, types, registries }, now).slice(0, initialized ? 2 : 1);
  for (const job of jobs) {
    try {
      if (job.action === "receipt") {
        await publishDiskRegistryReceipt(job.registry, diskAttemptDeadline());
      } else if (job.action === "empty") {
        await confirmEmptyDiskRegistry(job.registry, signal => folderIsEmpty(job.registry, signal));
      } else if (job.material.kind === "cards") {
        await syncKnowledgeCardRecord(job.material.stored);
      } else {
        await syncArticleRecord(job.material.approved);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") continue;
      if (job.action !== "empty") throw error;
      const status = error instanceof YandexDiskError ? error.status : undefined;
      await noteDiskRegistryRebuildError(job.registry, status
        ? `Не удалось обновить пустую сводку (HTTP ${status}).`
        : "Не удалось обновить пустую сводку.", AbortSignal.timeout(5_000));
    }
  }
  return jobs.length;
}

const runtime = globalThis as typeof globalThis & { canonDiskRecoveryRunning?: boolean };

export function startDiskRecovery() {
  if (!diskRecoveryEnabled() || runtime.canonDiskRecoveryRunning) return;
  runtime.canonDiskRecoveryRunning = true;
  const schedule = (delay: number) => setTimeout(async () => {
    let next = 60_000;
    try {
      await runDiskRecoveryPass();
    } catch (error) {
      const status = error instanceof YandexDiskError ? error.status : undefined;
      console.warn(status ? `Канон: автоповтор Диска отложен (HTTP ${status}).` : "Канон: автоповтор Диска отложен.");
      next = DISK_RECOVERY_FAILURE_MS;
    }
    schedule(next);
  }, delay).unref();
  schedule(15_000);
}
