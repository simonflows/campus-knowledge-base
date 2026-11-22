export const DISK_SYNC_STATUSES = ["pending", "synced", "failed"] as const;

export type DiskSyncStatus = (typeof DISK_SYNC_STATUSES)[number];

type SuccessfulDiskExport = {
  syncedAt: string;
  filePath: string;
  summaryPath: string;
  pointerPaths?: string[];
  sourceUpdatedAt?: string;
  sourceRevisionId?: string;
};

export type DiskSyncInfo = {
  status: DiskSyncStatus;
  lastAttemptAt: string | null;
  lastSyncedAt: string | null;
  message: string | null;
  folderPath: string | null;
  filePath: string | null;
  summaryPath: string | null;
  attemptId?: string;
  sourceUpdatedAt?: string;
  sourceRevisionId?: string;
  fileUploaded?: boolean;
  summaryUploaded?: boolean;
  pointerPaths?: string[];
  lastSuccessfulExport?: SuccessfulDiskExport;
};

export type DiskRegistry = {
  id: string;
  kind: "disk-registry";
  versionId: string;
  entityId: string;
  summaryPath: string;
  confirmedAt: string;
  fingerprint: string;
  sequence?: number;
  pendingRows?: number;
  receiptPath?: string;
  receiptLastAttemptAt?: string;
  receiptError?: string;
  summaryInvalid?: boolean;
  rebuildLastAttemptAt?: string;
  rebuildError?: string;
};

export type DiskRegistryContent = "cards" | "articles";

export type DiskRegistryCommit = {
  next: DiskRegistry;
  expectedVersionId?: string;
};

export type DiskRegistryView = {
  summaryPath: string;
  confirmedAt: string;
  checkedAt: string;
  current: boolean;
};

export const diskSyncStatusLabels: Record<DiskSyncStatus, string> = {
  pending: "Не выгружено",
  synced: "Синхронизировано с Яндекс Диском",
  failed: "Ошибка выгрузки на Яндекс Диск",
};

// Disk writes do not advance the content version. Compare the observed attempt as well.
function observedProgressCondition(sync?: DiskSyncInfo, snapshot = false) {
  const path = snapshot ? "approvedSnapshot.diskSync" : "diskSync";
  const statusName = snapshot ? "#snapshotSyncStatus" : "#syncStatus";
  const statusValue = snapshot ? ":snapshotSyncStatus" : ":syncStatus";
  const attemptValue = snapshot ? ":snapshotAttempt" : ":observedAttempt";
  const state = sync
    ? `${path}.${statusName} = ${statusValue}`
    : `attribute_not_exists(${path})`;
  const attempt = sync?.attemptId
    ? `${path}.attemptId = ${attemptValue}`
    : `attribute_not_exists(${path}.attemptId)`;
  return {
    ConditionExpression: `${state} AND ${attempt}`,
    ...(sync && { ExpressionAttributeNames: { [statusName]: "status" } }),
    ExpressionAttributeValues: {
      ...(sync && { [statusValue]: sync.status }),
      ...(sync?.attemptId && { [attemptValue]: sync.attemptId }),
    },
  };
}

export function observedExportCondition(record: { updatedAt: string; diskSync?: DiskSyncInfo; approvedSnapshot?: { diskSync?: DiskSyncInfo } }) {
  const progress = observedProgressCondition(record.diskSync);
  const snapshot = record.approvedSnapshot ? observedProgressCondition(record.approvedSnapshot.diskSync, true) : undefined;
  return {
    ...(progress.ExpressionAttributeNames || snapshot?.ExpressionAttributeNames
      ? { ExpressionAttributeNames: { ...progress.ExpressionAttributeNames, ...snapshot?.ExpressionAttributeNames } }
      : {}),
    ConditionExpression: "updatedAt = :previousUpdatedAt AND " + progress.ConditionExpression +
      (snapshot ? " AND " + snapshot.ConditionExpression : ""),
    ExpressionAttributeValues: {
      ...progress.ExpressionAttributeValues, ...snapshot?.ExpressionAttributeValues, ":previousUpdatedAt": record.updatedAt,
    },
  };
}

export type DiskAttemptGuard = string | { previous?: DiskSyncInfo };

export function diskAttemptMatches(current: DiskSyncInfo | undefined, guard?: DiskAttemptGuard) {
  if (guard === undefined) return true;
  if (typeof guard === "string") return current?.attemptId === guard;
  return current?.status === guard.previous?.status && current?.attemptId === guard.previous?.attemptId;
}

export function diskAttemptCondition(guard?: DiskAttemptGuard, snapshot = false) {
  if (guard === undefined) return { ConditionExpression: "", ExpressionAttributeValues: {}, ExpressionAttributeNames: {} };
  if (typeof guard === "string") return {
    ConditionExpression: ` AND ${snapshot ? "approvedSnapshot." : ""}diskSync.attemptId = :attempt`,
    ExpressionAttributeValues: { ":attempt": guard }, ExpressionAttributeNames: {},
  };
  const progress = observedProgressCondition(guard.previous, snapshot);
  return { ...progress, ConditionExpression: " AND " + progress.ConditionExpression };
}

export const DISK_RECOVERY_ACTIVE_MS = 90_000;
export const DISK_RECOVERY_FAILURE_MS = 300_000;

export function diskRecoveryDue(
  sync: DiskSyncInfo | undefined, updatedAt: string, revisionId: string | undefined, now: number,
): boolean {
  const age = now - Date.parse(sync?.lastAttemptAt ?? "");
  if (sync?.status === "pending" && sync.attemptId && age < DISK_RECOVERY_ACTIVE_MS) return false;
  if (sync?.status === "failed" && age < DISK_RECOVERY_FAILURE_MS) return false;
  return !isDiskSyncCurrent(sync, updatedAt, revisionId);
}

export function isDiskSyncCurrent(sync: DiskSyncInfo | undefined, updatedAt: string, revisionId?: string) {
  return sync?.status === "synced" && sync.sourceUpdatedAt === updatedAt &&
    sync.sourceRevisionId === revisionId && Boolean(sync.filePath && sync.summaryPath);
}

export function diskReceiptDue(registry: DiskRegistry, now: number): boolean {
  const age = now - Date.parse(registry.receiptLastAttemptAt ?? "");
  return !registry.receiptPath && !(age < (registry.receiptError ? DISK_RECOVERY_FAILURE_MS : DISK_RECOVERY_ACTIVE_MS));
}

export function diskRegistrySequence(registry?: DiskRegistry | null): number {
  const stored = registry?.sequence ?? 0;
  if (!Number.isSafeInteger(stored) || stored < 0) throw new Error("Некорректный номер сводки Диска.");
  return stored;
}

export function lastSuccessfulDiskExport(
  previous?: DiskSyncInfo
): SuccessfulDiskExport | undefined {
  if (
    previous?.status !== "synced" ||
    !previous.lastSyncedAt ||
    !previous.filePath ||
    !previous.summaryPath
  )
    return previous?.lastSuccessfulExport;
  const {
    lastSyncedAt: syncedAt,
    filePath,
    summaryPath,
    sourceUpdatedAt,
    sourceRevisionId,
    pointerPaths,
  } = previous;
  return {
    syncedAt,
    filePath,
    summaryPath,
    ...(sourceUpdatedAt && { sourceUpdatedAt }),
    ...(sourceRevisionId && { sourceRevisionId }),
    ...(pointerPaths && { pointerPaths }),
  };
}

export function createPendingDiskSync(previous?: DiskSyncInfo): DiskSyncInfo {
  const success = lastSuccessfulDiskExport(previous);
  return {
    status: "pending",
    lastAttemptAt: null,
    lastSyncedAt: success?.syncedAt ?? previous?.lastSyncedAt ?? null,
    ...(success && { lastSuccessfulExport: success }),
    message: null,
    folderPath: null,
    filePath: null,
    summaryPath: null,
  };
}

export function formatDiskSyncTime(value: string | null | undefined): string {
  if (!value) return "ещё не выгружалось";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
}
