"use client";

import { useWorkspaceMode, useWorkspaceRequest } from "@/components/demo/workspace-transport";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  FileSpreadsheet,
  FileText,
  FolderTree,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  createPendingDiskSync,
  diskSyncStatusLabels,
  formatDiskSyncTime,
  lastSuccessfulDiskExport,
  type DiskRegistryView,
  type DiskSyncInfo,
} from "@/lib/disk-sync";
import { cn } from "@/lib/utils";

type DiskSyncedEntity = { diskSync?: DiskSyncInfo };

type DiskSyncPanelProps<T extends DiskSyncedEntity> = {
  diskSync?: DiskSyncInfo | null;
  retryEndpoint: string;
  canRetry: boolean;
  entityLabel: string;
  onSynced?: (entity: T) => void;
  compact?: boolean;
};

export function DiskSyncPanel<T extends DiskSyncedEntity>({
  diskSync,
  retryEndpoint,
  canRetry,
  entityLabel,
  onSynced,
  compact = false,
}: DiskSyncPanelProps<T>) {
  const workspaceRequest = useWorkspaceRequest();
  const demo = useWorkspaceMode() === "demo";
  const [isRetrying, setIsRetrying] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [registryResult, setRegistryResult] = useState<{
    key: string;
    value: DiskRegistryView | null;
  } | null>(null);
  const sync = diskSync ?? createPendingDiskSync();
  const isSynced = sync.status === "synced";
  const isFailed = sync.status === "failed";
  const lastComplete = lastSuccessfulDiskExport(sync);
  const key =
    !demo && canRetry && diskSync
      ? [retryEndpoint, sync.attemptId, sync.lastSyncedAt, refresh].join("|")
      : null;
  const registry =
    registryResult && registryResult.key === key ? registryResult.value : null;

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    workspaceRequest(retryEndpoint, { signal: controller.signal })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as { registry: DiskRegistryView | null })
          : null
      )
      .then((data) => {
        if (!controller.signal.aborted)
          setRegistryResult({ key, value: data?.registry ?? null });
      })
      .catch(() => {
        if (!controller.signal.aborted) setRegistryResult({ key, value: null });
      });
    return () => controller.abort();
  }, [key, retryEndpoint, workspaceRequest]);

  const handleRetry = async () => {
    if (isRetrying) return;
    setIsRetrying(true);

    try {
      const response = await workspaceRequest(retryEndpoint, { method: "POST" });
      const data = (await response.json().catch(() => null)) as
        | (T & { error?: string; diskSync?: DiskSyncInfo })
        | null;

      if (!response.ok || !data) {
        toast.error(
          data?.error || `Не удалось повторить выгрузку ${entityLabel}`
        );
        return;
      }

      onSynced?.(data as T);
      setRefresh((value) => value + 1);

      if (data.diskSync?.status === "synced") {
        toast.success(
          `${entityLabel[0].toUpperCase()}${entityLabel.slice(1)} выгружена на Яндекс Диск`
        );
      } else {
        toast.warning(
          data.diskSync?.status === "pending"
            ? "Нужен повтор выгрузки"
            : "Выгрузка на Яндекс Диск не удалась",
          {
            description:
              data.diskSync?.message ||
              "Карточка сохранена. Можно повторить выгрузку позже.",
          }
        );
      }
    } catch {
      toast.error("Ошибка сети при выгрузке на Яндекс Диск");
    } finally {
      setIsRetrying(false);
    }
  };

  if (demo) return (
    <div className="flex items-center gap-2 rounded-2xl border border-border bg-muted/30 p-3 text-sm">
      <CloudUpload className="size-4 shrink-0" aria-hidden="true" />
      Выгрузка на Яндекс Диск отключена в демо-режиме.
    </div>
  );

  return (
    <div
      className={cn(
        "rounded-2xl border p-4",
        isSynced
          ? "border-emerald-200 bg-emerald-50/60"
          : isFailed
            ? "border-amber-200 bg-amber-50/70"
            : "border-border bg-muted/30",
        compact && "p-3"
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span
            className={cn(
              "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl",
              isSynced
                ? "bg-emerald-100 text-emerald-700"
                : isFailed
                  ? "bg-amber-100 text-amber-700"
                  : "bg-background text-muted-foreground ring-1 ring-border"
            )}
          >
            {isSynced ? (
              <CheckCircle2 className="size-4" />
            ) : isFailed ? (
              <AlertTriangle className="size-4" />
            ) : (
              <CloudUpload className="size-4" />
            )}
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={isSynced ? "secondary" : "outline"}
                className={cn(
                  isSynced && "bg-emerald-100 text-emerald-800",
                  isFailed && "border-amber-300 text-amber-800"
                )}
              >
                {diskSyncStatusLabels[sync.status]}
              </Badge>
              <span className="text-xs text-muted-foreground">
                Последняя выгрузка: {formatDiskSyncTime(sync.lastSyncedAt)}
              </span>
            </div>
            {sync.lastAttemptAt && isFailed ? (
              <p className="text-[11px] text-muted-foreground">
                Последняя попытка: {formatDiskSyncTime(sync.lastAttemptAt)}
              </p>
            ) : null}
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-10 w-full sm:h-7 sm:w-auto"
          onClick={handleRetry}
          disabled={isRetrying || !canRetry}
        >
          {isRetrying ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          {isSynced ? "Выгрузить снова" : "Повторить выгрузку"}
        </Button>
      </div>

      {!isSynced && sync.message ? (
        <p className="mt-3 rounded-xl bg-background/70 px-3 py-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
          {sync.message} {entityLabel[0].toUpperCase()}
          {entityLabel.slice(1)} сохранена, можно повторить выгрузку.
        </p>
      ) : null}

      {sync.filePath && (isSynced || sync.fileUploaded) ? (
        <div className="mt-3 grid gap-1.5 text-[11px] text-muted-foreground">
          <p className="flex items-start gap-1.5">
            <FolderTree className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0">
              Папка на Диске:{" "}
              <span className="break-all font-medium text-foreground/80">
                {sync.folderPath ?? "—"}
              </span>
            </span>
          </p>
          <p className="flex items-start gap-1.5">
            <FileText className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0">
              {isSynced ? "Файл материала" : "Промежуточный Markdown"}:{" "}
              <span className="break-all font-medium text-foreground/80">
                {sync.filePath}
              </span>
            </span>
          </p>
        </div>
      ) : null}

      {registry ? (
        <div className="mt-3 flex min-w-0 items-start gap-1.5 text-xs">
          <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">
              {registry.current
                ? "Сводка папки совпала с опубликованными данными"
                : "Предыдущая полная сводка папки"}
            </p>
            <p className="break-all text-muted-foreground">
              {registry.summaryPath}
            </p>
            <p className="text-muted-foreground">
              {registry.current
                ? "Проверено " + formatDiskSyncTime(registry.checkedAt)
                : "Требуется актуальная сводка. Полная копия от " +
                  formatDiskSyncTime(registry.confirmedAt)}
            </p>
          </div>
        </div>
      ) : null}

      {key ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => setRefresh((value) => value + 1)}
        >
          Сверить сводку папки
        </Button>
      ) : null}

      {lastComplete && (!isSynced || !registry) ? (
        <div className="mt-3 min-w-0 text-xs">
          <p className="font-medium">Последняя полная копия материала</p>
          <p className="break-all text-muted-foreground">
            {lastComplete.filePath}
          </p>
          <p className="break-all text-muted-foreground">
            {lastComplete.summaryPath}
          </p>
        </div>
      ) : null}

      {!canRetry ? (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Повторная выгрузка недоступна в статическом режиме.
        </p>
      ) : null}
    </div>
  );
}
