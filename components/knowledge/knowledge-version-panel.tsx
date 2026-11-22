"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  canAssignCardOwner,
  canEditCard,
  type CardOwnerCandidate,
  type SessionUser,
} from "@/lib/auth";
import {
  getApprovedVersion,
  getCardStatus,
  getUniversityFullName,
  type KnowledgeCard,
  type VerifiedCardFact,
} from "@/lib/knowledge";
import { isReviewOverdue } from "@/lib/knowledge-freshness";
import type { ApprovedCardVersion } from "@/lib/knowledge-versions";
import {
  knowledgeSourceSchema,
  updateCardFreshnessSchema,
  verifiedCardFactSchema,
} from "@/lib/validation/knowledge";

type ListedVersion = Pick<
  ApprovedCardVersion,
  "id" | "recordedAt" | "actorName" | "reason" | "legacyBaseline"
>;
type VersionHistory = {
  currentVersionId: string | null;
  cardUpdatedAt: string;
  publishedUpdatedAt: string | null;
  canVerifyFreshness: boolean;
  versions: ListedVersion[];
  responsibleId?: string;
};
type VersionDetail = Omit<ApprovedCardVersion, "actorId">;
type Load<T> =
  | { status: "loading" | "error"; data?: never }
  | { status: "loaded"; data: T };

const russianDate = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeZone: "UTC",
});
const formatDate = (value?: string) =>
  value && Number.isFinite(Date.parse(value))
    ? russianDate.format(new Date(value))
    : "Не указана";

export function knowledgeVersionHref(cardId: string, versionId: string) {
  return (
    "/knowledge?" + new URLSearchParams({ card: cardId, version: versionId })
  );
}

function versionsApi(cardId: string, versionId?: string) {
  return (
    "/api/knowledge/cards/" +
    encodeURIComponent(cardId) +
    "/versions" +
    (versionId ? "/" + encodeURIComponent(versionId) : "")
  );
}

function useVersionResource<T>(url: string | null, refresh = 0): Load<T> {
  const key = url && `${refresh}:${url}`;
  const [loaded, setLoaded] = useState<{ key: string; result: Load<T> } | null>(
    null
  );
  useEffect(() => {
    if (!url || !key) return;
    const request = new AbortController();
    fetch(url, { signal: request.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return (await response.json()) as T;
      })
      .then((data) => {
        if (!request.signal.aborted)
          setLoaded({ key, result: { status: "loaded", data } });
      })
      .catch(() => {
        if (!request.signal.aborted)
          setLoaded({ key, result: { status: "error" } });
      });
    return () => request.abort();
  }, [key, url]);
  return loaded && loaded.key === key ? loaded.result : { status: "loading" };
}

function freshnessLabel(
  card: KnowledgeCard,
  currentVersionId: string | null | undefined
) {
  const freshness = card.freshness;
  if (isReviewOverdue(freshness?.nextReviewAt)) return "Срок сверки прошёл";
  if (!freshness?.lastVerifiedAt || !freshness.verifiedVersionId)
    return "Сверка не зафиксирована";
  if (currentVersionId && freshness.verifiedVersionId !== currentVersionId)
    return "Нужно сверить новую версию";
  return currentVersionId ? "Текущая версия сверена" : "Есть запись о сверке";
}

function VersionCaption({ version }: { version: ListedVersion }) {
  return (
    <span className="flex min-w-0 flex-col gap-1 text-sm">
      <span>
        {version.legacyBaseline
          ? "Начальный снимок истории"
          : formatDate(version.recordedAt)}
      </span>
      <span className="break-words text-muted-foreground">
        {version.actorName ? version.actorName + " · " : ""}
        {version.reason}
      </span>
    </span>
  );
}

export function KnowledgeVersionPanel({
  card,
  currentUser,
  ownerCandidates,
  dbAvailable,
  onUpdated,
}: {
  card: KnowledgeCard;
  currentUser: SessionUser | null;
  ownerCandidates: CardOwnerCandidate[];
  dbAvailable: boolean;
  onUpdated: (card: KnowledgeCard) => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const loaded = useVersionResource<VersionHistory>(
    versionsApi(card.id),
    refresh
  );
  const history = loaded.data;
  const displayedVersionId =
    history &&
    history.publishedUpdatedAt === getApprovedVersion(card)?.updatedAt
      ? history.currentVersionId
      : null;
  const canEdit = dbAvailable && canEditCard(currentUser, card);
  const verification =
    dbAvailable && history?.canVerifyFreshness && displayedVersionId
      ? {
          versionId: displayedVersionId,
          expectedUpdatedAt: history.cardUpdatedAt,
        }
      : null;
  const [scheduled, setScheduled] = useState(false);
  const [nextReviewAt, setNextReviewAt] = useState(
    card.freshness?.nextReviewAt ?? ""
  );
  const [responsible, setResponsible] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const dateInput = useId();
  const staff = ownerCandidates.filter((account) =>
    canAssignCardOwner(account, getApprovedVersion(card) ?? card)
  );

  async function update(data: unknown, expectedUpdatedAt = card.updatedAt) {
    if (saving) return;
    const parsed = updateCardFreshnessSchema.safeParse(data);
    if (!parsed.success) {
      toast.error("Проверьте дату сверки");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(
        "/api/knowledge/cards/" + encodeURIComponent(card.id) + "/freshness",
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "If-Match": expectedUpdatedAt,
          },
          body: JSON.stringify(parsed.data),
        }
      );
      if (!response.ok) {
        const failure: { error?: string } = await response
          .json()
          .catch(() => ({}));
        toast.error(failure.error ?? "Не удалось обновить актуальность");
        return;
      }
      const updated = (await response.json()) as KnowledgeCard;
      toast.success(
        parsed.data.action === "verify"
          ? "Сверка зафиксирована"
          : "План сверки сохранён"
      );
      onUpdated(updated);
      setNextReviewAt(updated.freshness?.nextReviewAt ?? "");
      setRefresh((previous) => previous + 1);
      setScheduled(false);
    } catch {
      toast.error("Не удалось связаться с базой знаний");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Актуальность и история</CardTitle>
          <Badge variant="outline">
            {freshnessLabel(card, displayedVersionId)}
          </Badge>
        </CardHeader>
        <CardContent className="grid gap-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Ответственный</dt>
              <dd className="break-words">
                {card.freshness?.responsibleName ?? "Не назначен"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Последняя сверка</dt>
              <dd>{formatDate(card.freshness?.lastVerifiedAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Следующая сверка</dt>
              <dd>{formatDate(card.freshness?.nextReviewAt)}</dd>
            </div>
          </dl>
          {canEdit || verification ? (
            <div className="flex flex-wrap gap-2">
              {canEdit ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setScheduled(!scheduled)}
                  aria-expanded={scheduled}
                >
                  Изменить план сверки
                </Button>
              ) : null}
              {verification ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={saving}
                  onClick={() =>
                    void update(
                      {
                        action: "verify",
                        versionId: verification.versionId,
                      },
                      verification.expectedUpdatedAt
                    )
                  }
                >
                  Подтвердить сверку опубликованной версии
                </Button>
              ) : null}
            </div>
          ) : null}
          {canEdit && scheduled ? (
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void update({
                  action: "schedule",
                  nextReviewAt: nextReviewAt || null,
                  ...(responsible !== undefined && {
                    responsibleId:
                      responsible === "unassigned" ? null : responsible,
                  }),
                });
              }}
            >
              <div className="grid gap-1">
                <label htmlFor={dateInput} className="text-sm font-medium">
                  Дата следующей сверки
                </label>
                <Input
                  id={dateInput}
                  type="date"
                  value={nextReviewAt}
                  onChange={(event) => setNextReviewAt(event.target.value)}
                />
              </div>
              {currentUser?.role === "admin" ? (
                <Select
                  value={responsible ?? history?.responsibleId ?? "unassigned"}
                  onValueChange={(value) => setResponsible(value ?? undefined)}
                >
                  <SelectTrigger aria-label="Ответственный за сверку">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">
                      Без ответственного
                    </SelectItem>
                    <SelectItem value={currentUser.id}>
                      {currentUser.name}
                    </SelectItem>
                    {staff.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.ownershipLabel}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <Button type="submit" size="sm" disabled={saving}>
                Сохранить план
              </Button>
            </form>
          ) : null}
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              Утверждённые версии
              {history?.versions.length ? ` (${history.versions.length})` : ""}
            </summary>
            <div className="mt-3 grid gap-3">
              {loaded.status === "loading" ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Загружаем историю…
                </p>
              ) : null}
              {loaded.status === "error" ? (
                <p role="alert" className="text-sm text-muted-foreground">
                  История сейчас недоступна.
                </p>
              ) : null}
              {history?.versions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Утверждённых версий пока нет.
                </p>
              ) : null}
              {history?.versions.map((version) => (
                <Link
                  key={version.id}
                  href={knowledgeVersionHref(card.id, version.id)}
                  className="flex min-w-0 items-start justify-between gap-2 rounded-lg border p-3 hover:bg-muted/60"
                >
                  <VersionCaption version={version} />
                  {version.id === history.currentVersionId ? (
                    <Badge variant="secondary">Текущая</Badge>
                  ) : null}
                </Link>
              ))}
            </div>
          </details>
        </CardContent>
      </Card>
      <KnowledgeEvidencePanel
        card={card}
        versionId={
          getCardStatus(card) === "approved"
            ? (displayedVersionId ?? undefined)
            : undefined
        }
      />
    </>
  );
}

function validFacts(card: KnowledgeCard): VerifiedCardFact[] {
  const facts = [...(card.verifiedFacts ?? [])];
  if (card.type === "university") {
    for (const metric of card.structuredMetrics) {
      facts.push({
        ...metric,
        value: String(metric.value),
        scope: getUniversityFullName(card.universityId),
      });
    }
  }
  return facts.flatMap((fact) => {
    const parsed = verifiedCardFactSchema.safeParse(fact);
    return parsed.success ? [parsed.data] : [];
  });
}

export function KnowledgeEvidencePanel({
  card,
  versionId,
}: {
  card: KnowledgeCard;
  versionId?: string;
}) {
  const sources = (card.sources ?? []).flatMap((source) => {
    const parsed = knowledgeSourceSchema.safeParse(source);
    return parsed.success ? [parsed.data] : [];
  });
  const facts = versionId ? validFacts(card) : [];
  if (!sources.length && !facts.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Источники и проверенные цитаты</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {sources.length ? (
          <ul className="grid gap-2 text-sm">
            {sources.map((source, index) => (
              <li
                key={`${source.url}-${index}`}
                className="min-w-0 break-words"
              >
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium underline underline-offset-4"
                >
                  {source.title}
                </a>
                {source.scope ? ` · ${source.scope}` : ""}
                {source.publishedAt
                  ? ` · ${formatDate(source.publishedAt)}`
                  : ""}
              </li>
            ))}
          </ul>
        ) : null}
        {facts.length ? (
          <ul className="grid gap-3">
            {facts.map((fact, index) => {
              const citation = `${fact.label}: ${fact.value} ${fact.unit}. ${fact.year} год, ${fact.kind === "plan" ? "план" : "факт"}. Область применения: ${fact.scope}. Источник: ${fact.evidenceUrl}`;
              return (
                <li
                  key={`${fact.id}-${index}`}
                  className="grid gap-2 rounded-lg border p-3 text-sm"
                >
                  <p className="break-words">
                    {fact.label} · {fact.value} {fact.unit} · {fact.year} ·{" "}
                    {fact.kind === "plan" ? "План" : "Факт"} · {fact.scope}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href={fact.evidenceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-4"
                    >
                      Источник
                    </a>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          const versionLink = new URL(
                            knowledgeVersionHref(card.id, versionId!),
                            location.origin
                          );
                          await navigator.clipboard.writeText(
                            citation + "\nВерсия карточки: " + versionLink.href
                          );
                          toast.success(
                            "Цитата и ссылка на версию скопированы"
                          );
                        } catch {
                          toast.error("Не удалось скопировать цитату");
                        }
                      }}
                    >
                      Скопировать цитату
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

const comparisonFields: Partial<Record<string, string>> = {
  title: "Название",
  folderId: "Папка",
  owners: "Владельцы",
  referenceDescription: "Эталонное описание",
  stopFormula: "Стоп-формула",
  sources: "Источники",
  verifiedFacts: "Проверенные факты",
  sphere: "Сфера",
  initiatorUniversityId: "Инициатор",
  coExecutors: "Соисполнители",
  industrialPartner: "Промышленный партнёр",
  readinessStage: "Стадия",
  contour: "Контур",
  confirmedFigures: "Подтверждённые цифры",
  isJoint: "Совместный проект",
  participantUniversityIds: "Вузы-участники",
  affiliation: "Принадлежность",
  partner: "Партнёр",
  head: "Руководитель",
  placementStatus: "Статус размещения",
  placementDetails: "Размещение",
  workDirections: "Направления",
  equipment: "Оборудование",
  confirmedIndicators: "Подтверждённые показатели",
  campusMetrics: "Показатели кампуса",
  tariffs: "Тарифы",
  legalEntities: "Юридические лица",
  stopList: "Ограничения",
  customFields: "Поля типа",
  universityId: "Вуз",
  structuredMetrics: "Показатели паспорта",
};

export function HistoricalKnowledgeVersion({
  cardId,
  versionId,
  onOpenCurrent,
  children,
}: {
  cardId: string;
  versionId: string;
  onOpenCurrent: () => void;
  children: (card: KnowledgeCard) => React.ReactNode;
}) {
  const selected = useVersionResource<VersionDetail>(
    versionsApi(cardId, versionId)
  );
  const history = useVersionResource<VersionHistory>(versionsApi(cardId));
  const [compareId, setCompareId] = useState<string | null>(null);
  const against = useVersionResource<VersionDetail>(
    compareId ? versionsApi(cardId, compareId) : null
  );
  if (selected.status !== "loaded")
    return (
      <Card>
        <CardContent aria-live="polite">
          <p className="text-sm">
            {selected.status === "error"
              ? "Версия карточки недоступна."
              : "Загружаем зафиксированную версию…"}
          </p>
          <Link
            href={"/knowledge?" + new URLSearchParams({ card: cardId })}
            onClick={onOpenCurrent}
            className="text-sm underline"
          >
            Перейти к карточке
          </Link>
        </CardContent>
      </Card>
    );
  const version = selected.data;
  const alternatives =
    history.data?.versions.filter((item) => item.id !== versionId) ?? [];
  const compare = against.data?.snapshot;
  const current = version.snapshot as unknown as Record<string, unknown>;
  const other = compare as unknown as Record<string, unknown> | undefined;
  const differences = other
    ? Object.entries(comparisonFields).filter(
        ([field]) =>
          JSON.stringify(current[field]) !== JSON.stringify(other[field])
      )
    : [];
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 [overflow-wrap:anywhere]">
      <Card>
        <CardHeader>
          <CardTitle>Утверждённая версия</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <VersionCaption version={version} />
          {version.snapshot.reviewedAt ? (
            <p className="text-sm">
              Дата согласования: {formatDate(version.snapshot.reviewedAt)}
            </p>
          ) : null}
          <Link
            href={"/knowledge?" + new URLSearchParams({ card: cardId })}
            onClick={onOpenCurrent}
            className="text-sm underline"
          >
            Открыть текущую карточку
          </Link>
          {alternatives.length ? (
            <Select
              value={compareId ?? "none"}
              onValueChange={(value) =>
                setCompareId(value === "none" ? null : value)
              }
            >
              <SelectTrigger aria-label="Сравнить с другой версией">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Сравнить с другой версией</SelectItem>
                {alternatives.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.id === history.data?.currentVersionId
                      ? "Текущая · "
                      : ""}
                    {item.legacyBaseline
                      ? "Начальный снимок"
                      : formatDate(item.recordedAt)}{" "}
                    · {item.id.slice(3, 11)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {compareId && against.status === "error" ? (
            <p role="alert" className="text-sm">
              Версия для сравнения недоступна.
            </p>
          ) : null}
          {compareId && against.status === "loading" ? (
            <p role="status" className="text-sm">
              Загружаем версию для сравнения…
            </p>
          ) : null}
          {other && !differences.length ? (
            <p className="text-sm">Публичные поля совпадают.</p>
          ) : null}
          {other && differences.length ? (
            <dl className="grid gap-3">
              {differences.map(([field, label]) => (
                <div key={field} className="min-w-0 rounded-lg border p-3">
                  <dt className="text-sm font-medium">{label}</dt>
                  <dd className="grid gap-2 sm:grid-cols-2">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">
                        Открытая версия
                      </p>
                      <pre className="whitespace-pre-wrap break-words text-sm">
                        {printValue(current[field])}
                      </pre>
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">
                        Версия для сравнения
                      </p>
                      <pre className="whitespace-pre-wrap break-words text-sm">
                        {printValue(other[field])}
                      </pre>
                    </div>
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </CardContent>
      </Card>
      <KnowledgeEvidencePanel card={version.snapshot} versionId={version.id} />
      {children(version.snapshot)}
    </div>
  );
}

function printValue(value: unknown): string {
  if (value === undefined || value === null) return "Не указано";
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  return typeof value === "object"
    ? JSON.stringify(value, null, 2)
    : String(value);
}
