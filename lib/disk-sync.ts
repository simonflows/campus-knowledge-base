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
};

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
function observedProgressCondition(sync?: DiskSyncInfo) {
  const state = sync
    ? "diskSync.#syncStatus = :syncStatus"
    : "attribute_not_exists(diskSync)";
  const attempt = sync?.attemptId
    ? "diskSync.attemptId = :observedAttempt"
    : "attribute_not_exists(diskSync.attemptId)";
  return {
    ConditionExpression: `${state} AND ${attempt}`,
    ...(sync && { ExpressionAttributeNames: { "#syncStatus": "status" } }),
    ExpressionAttributeValues: {
      ...(sync && { ":syncStatus": sync.status }),
      ...(sync?.attemptId && { ":observedAttempt": sync.attemptId }),
    },
  };
}

export function observedExportCondition(record: { updatedAt: string; diskSync?: DiskSyncInfo }) {
  const progress = observedProgressCondition(record.diskSync);
  return {
    ...progress,
    ConditionExpression: "updatedAt = :previousUpdatedAt AND " + progress.ConditionExpression,
    ExpressionAttributeValues: { ...progress.ExpressionAttributeValues, ":previousUpdatedAt": record.updatedAt },
  };
}

export type DiskAttemptGuard = string | { previous?: DiskSyncInfo };

export function diskAttemptMatches(current: DiskSyncInfo | undefined, guard?: DiskAttemptGuard) {
  if (guard === undefined) return true;
  if (typeof guard === "string") return current?.attemptId === guard;
  return current?.status === guard.previous?.status && current?.attemptId === guard.previous?.attemptId;
}

export function diskAttemptCondition(guard?: DiskAttemptGuard) {
  if (guard === undefined) return { ConditionExpression: "", ExpressionAttributeValues: {}, ExpressionAttributeNames: {} };
  if (typeof guard === "string") return {
    ConditionExpression: " AND diskSync.attemptId = :attempt", ExpressionAttributeValues: { ":attempt": guard }, ExpressionAttributeNames: {},
  };
  const progress = observedProgressCondition(guard.previous);
  return { ...progress, ConditionExpression: " AND " + progress.ConditionExpression };
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
