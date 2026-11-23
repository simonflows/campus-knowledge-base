"use client";

import { AppLink } from "@/components/navigation/workspace-navigation";

import { useWorkspaceRequest } from "@/components/demo/workspace-transport";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { EditorialDocument } from "@/lib/editorial";
import type { EditorialReadiness } from "@/lib/editorial-readiness";

const checkLabels = {
  missing: "Нет проверки",
  stale: "Результат устарел",
  passed: "Пройдена",
  attention: "Требуется сверка",
};
const diskLabels = {
  missing: "Нет выгрузки",
  pending: "Ожидается",
  failed: "Ошибка выгрузки",
  stale: "Выгружалась другая редакция",
  synced: "Подтверждена",
};

type ReadinessLoad =
  | {
      status: "ready";
      data: EditorialReadiness;
      refreshedAfterConflict?: boolean;
    }
  | { status: "conflict" }
  | { status: "error"; message: string };

function matchReadiness(
  data: EditorialReadiness | null,
  id: string,
  revisionId: string,
  version: number
): ReadinessLoad {
  if (data?.documentId !== id)
    return { status: "error", message: "Паспорт недоступен" };
  return data.revisionId === revisionId && data.version === version
    ? { status: "ready", data }
    : { status: "conflict" };
}

async function readReadiness(
  endpoint: string,
  signal: AbortSignal,
  request: ReturnType<typeof useWorkspaceRequest>
): Promise<EditorialReadiness> {
  const response = await request(endpoint, { signal, cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || "Паспорт недоступен");
  return data;
}

export function EditorialReadinessPanel({
  document,
  dirty,
  onRefreshDraft,
}: {
  document: EditorialDocument;
  dirty: boolean;
  onRefreshDraft: (signal: AbortSignal) => Promise<void>;
}) {
  const workspaceRequest = useWorkspaceRequest();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<{
    scope: string;
    load: ReadinessLoad;
  } | null>(null);
  const [comment, setComment] = useState("");
  const [actionError, setActionError] = useState<{
    scope: string;
    message: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const { id, revisionId, version } = document;
  const endpoint = `/api/editor/drafts/${encodeURIComponent(id)}/readiness`;
  const scope = JSON.stringify([id, revisionId, version]);
  const load = loaded?.scope === scope ? loaded.load : null;
  const current = load?.status === "ready" ? load.data : null;
  const conflict = load?.status === "conflict";
  const error =
    load?.status === "error"
      ? load.message
      : actionError?.scope === scope
        ? actionError.message
        : null;
  const sourceTitle = (id: string) =>
    document.content.sourceCardTitles[
      document.content.sourceCardIds.indexOf(id)
    ] || id;

  useEffect(() => {
    if (!open) return;
    const read = new AbortController();
    controller.current = read;
    void readReadiness(endpoint, read.signal, workspaceRequest)
      .then((data) => {
        if (!read.signal.aborted) {
          setLoaded({
            scope,
            load: matchReadiness(data, id, revisionId, version),
          });
          setActionError(null);
        }
      })
      .catch((failure: Error) => {
        if (!read.signal.aborted)
          setLoaded({
            scope,
            load: { status: "error", message: failure.message },
          });
      });
    return () => controller.current?.abort();
  }, [endpoint, id, open, revisionId, scope, version, workspaceRequest]);

  async function reloadDraft() {
    if (busy) return;
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    setBusy(true);
    setActionError(null);
    try {
      await onRefreshDraft(request.signal);
    } catch (failure) {
      if (!request.signal.aborted)
        setActionError({ scope, message: (failure as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function update(action: "check" | "review-sources") {
    if (busy || dirty) return;
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    setBusy(true);
    setActionError(null);
    try {
      const body = {
        action,
        version,
        revisionId,
        ...(action === "review-sources" && {
          sourceVersions: current?.changedSources
            .slice(0, 20)
            .map(({ cardId, currentVersionId }) => ({
              cardId,
              versionId: currentVersionId,
            })),
          comment: comment.trim(),
        }),
      };
      const response = await workspaceRequest(endpoint, {
        method: "POST",
        signal: request.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (request.signal.aborted) return;
      if (response.status === 409) {
        try {
          const data = await readReadiness(
            endpoint,
            request.signal,
            workspaceRequest
          );
          if (request.signal.aborted) return;
          const refreshed = matchReadiness(data, id, revisionId, version);
          setLoaded({
            scope,
            load:
              refreshed.status === "ready"
                ? { ...refreshed, refreshedAfterConflict: true }
                : refreshed,
          });
        } catch {
          if (!request.signal.aborted)
            setLoaded({
              scope,
              load: {
                status: "error",
                message:
                  "Не удалось обновить паспорт. Закройте и откройте его, чтобы повторить загрузку.",
              },
            });
        }
        return;
      }
      const next = await response.json();
      if (request.signal.aborted) return;
      if (!response.ok) throw new Error(next?.error || "Паспорт недоступен");
      const nextLoad = matchReadiness(next, id, revisionId, version);
      setLoaded({ scope, load: nextLoad });
      if (nextLoad.status === "ready" && action === "review-sources")
        setComment("");
    } catch (failure) {
      if (!request.signal.aborted)
        setActionError({ scope, message: (failure as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <details
      className="desk-inspector-section"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-semibold">
        Состояние редакции и источников
      </summary>
      {dirty && !conflict && (
        <p className="text-sm text-muted-foreground">
          Сохраните правки, чтобы проверить новую редакцию.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {open && !load && (
        <p className="text-sm text-muted-foreground">Загружаем паспорт…</p>
      )}
      {load?.status === "ready" && load.refreshedAfterConflict && (
        <p role="status" className="text-sm text-muted-foreground">
          Паспорт обновлён. Проверьте данные перед повторным действием.
        </p>
      )}
      {conflict && (
        <div className="mt-2 flex flex-col gap-2 text-sm">
          <p role="alert">Уже сохранена другая редакция.</p>
          <p className="text-muted-foreground">
            {dirty
              ? "Загрузите сохранённый текст для сравнения. Ваши правки останутся в редакторе."
              : "Загрузите актуальный черновик, чтобы открыть его паспорт."}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void reloadDraft()}
          >
            {busy ? "Загружаем черновик…" : "Загрузить актуальный черновик"}
          </Button>
        </div>
      )}
      {current && (
        <div className="mt-2 flex flex-col gap-2 text-sm">
          <p>
            <strong>Редакция {current.revisionNumber}.</strong>{" "}
            {current.ready && !dirty ? "Готова" : "Требуется внимание"}
          </p>
          <p>
            Согласование:{" "}
            {current.approval.approvedAt
              ? new Date(current.approval.approvedAt).toLocaleString("ru-RU")
              : "Эта редакция не согласована"}
          </p>
          <p>
            Проверка: {checkLabels[current.check.status]}. Выгрузка:{" "}
            {diskLabels[current.disk.status]}.
          </p>
          {current.check.summary && (
            <p>
              Подтверждено: {current.check.summary.green}. Уточнить:{" "}
              {current.check.summary.yellow}. Исправить:{" "}
              {current.check.summary.red}.
            </p>
          )}
          {current.check.findings.map((finding) => (
            <p key={finding.id}>
              {finding.title}: {finding.quote}
            </p>
          ))}
          {current.reasons.map((reason) => (
            <p key={reason} className="text-muted-foreground">
              {reason}
            </p>
          ))}
          {current.reviewedSourceVersions.map(
            ({ cardId, versionId, comment }) => (
              <p key={cardId}>
                Сверено с новой версией{" "}
                <AppLink
                  className="underline"
                  href={`/knowledge?card=${encodeURIComponent(cardId)}&version=${encodeURIComponent(versionId)}`}
                >
                  {sourceTitle(cardId)}
                </AppLink>
                . {comment}
              </p>
            )
          )}
          {current.unknownSources.map((id) => (
            <p key={id}>
              Версия не зафиксирована или недоступна: {sourceTitle(id)}
            </p>
          ))}
          {current.overdueSources.map((id) => (
            <p key={id}>Срок сверки истёк: {sourceTitle(id)}</p>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={dirty || busy}
            onClick={() => void update("check")}
          >
            Проверить сохранённую редакцию
          </Button>
          {current.changedSources.length > 0 && (
            <div className="flex flex-col gap-2">
              <p>
                Откройте обновлённые карточки и сверьте утверждения в материале.
              </p>
              {current.changedSources
                .slice(0, 20)
                .map(({ cardId, currentVersionId }) => (
                  <AppLink
                    className="underline"
                    key={cardId}
                    href={`/knowledge?card=${encodeURIComponent(cardId)}&version=${encodeURIComponent(currentVersionId)}`}
                  >
                    {sourceTitle(cardId)} — обновлённая версия
                  </AppLink>
                ))}
              <Textarea
                aria-label="Основание сверки"
                placeholder="Что сверили с новой версией"
                value={comment}
                maxLength={1000}
                onChange={(event) => setComment(event.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={dirty || busy || !comment.trim()}
                onClick={() => void update("review-sources")}
              >
                Проверил по новой версии
              </Button>
            </div>
          )}
        </div>
      )}
    </details>
  );
}
