"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, FileSearch, Route, TriangleAlert } from "lucide-react";

import { useWorkspaceRequest } from "@/components/demo/workspace-transport";
import { AppLink as Link } from "@/components/navigation/workspace-navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { universities } from "@/lib/data";
import type { SourceVersionReference } from "@/lib/source-references";
import type { IndicatorScope, StrategyOptions } from "@/lib/strategy";
import type {
  StrategyAnalyticsMeasurement,
  StrategyAnalyticsReport,
} from "@/lib/strategy-analytics";
import { strategyAnalyticsQuerySchema } from "@/lib/validation/analytics";

type OptionsState =
  | { status: "idle" | "loading" }
  | { status: "ready"; documents: StrategyOptions["documents"] }
  | { status: "error"; message: string };

const allTargets = "all";
const sourceClass =
  "min-w-0 wrap-anywhere text-primary underline underline-offset-3 hover:text-foreground";

function versionHref({ cardId, versionId }: SourceVersionReference) {
  return `/knowledge?${new URLSearchParams({ card: cardId, version: versionId })}`;
}

function scopeLabel(scope: IndicatorScope) {
  if (scope.kind === "campus") return "Кампус";
  if (scope.kind === "other") return scope.label;
  return (
    universities.find(({ id }) => id === scope.universityId)?.shortName ??
    scope.universityId
  );
}

function Measurement({
  label,
  dateLabel,
  measurement,
  unit,
}: {
  label: string;
  dateLabel: string;
  measurement: StrategyAnalyticsMeasurement;
  unit: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="text-sm wrap-anywhere text-muted-foreground">
        {measurement.status === "confirmed" ? (
          <div className="flex flex-col gap-1">
            <p className="font-semibold tabular-nums text-foreground">
              {String(measurement.value).replace(".", ",")} {unit}
            </p>
            <p>
              {dateLabel} —{" "}
              <time dateTime={measurement.date}>
                {measurement.date.split("-").reverse().join(".")}
              </time>
            </p>
            <Link
              href={versionHref(measurement.source.card)}
              className={sourceClass}
            >
              {measurement.source.card.title}, пункт{" "}
              {measurement.source.clauseLocator}
            </Link>
          </div>
        ) : (
          <>
            <p>Нет подтверждённых данных</p>
            {measurement.status === "stale" && (
              <p className="mt-1">Вышла новая версия источника.</p>
            )}
          </>
        )}
      </dd>
    </div>
  );
}

function Report({ report }: { report: StrategyAnalyticsReport }) {
  const projectCount = report.projects.filter(
    ({ status }) => status === "current"
  ).length;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <Link href={versionHref(report.document)} className={sourceClass}>
          {report.document.title}
        </Link>
        {report.target && (
          <span className="wrap-anywhere text-muted-foreground">
            {report.target.kind === "clause" ? "Пункт" : "Направление"} —{" "}
            {report.target.label}
          </span>
        )}
      </p>

      <section
        className="flex min-w-0 flex-col gap-2"
        aria-labelledby="strategy-projects"
      >
        <h3 id="strategy-projects" className="text-sm font-semibold">
          Связанные проекты
        </h3>
        {report.projects.length > 0 ? (
          <>
            <p className="text-sm text-muted-foreground">
              Карточек с действующей связью — {projectCount}
            </p>
            <ul className="divide-y divide-border border-y border-border">
              {report.projects.map(({ card, status }) => (
                <li
                  key={card.cardId}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2 text-sm"
                >
                  <Link href={versionHref(card)} className={sourceClass}>
                    {card.title}
                  </Link>
                  {status === "stale" && (
                    <span className="text-muted-foreground">
                      Связь устарела
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Связанных проектов нет
          </p>
        )}
      </section>

      <section
        className="flex min-w-0 flex-col gap-2"
        aria-labelledby="strategy-indicators"
      >
        <h3 id="strategy-indicators" className="text-sm font-semibold">
          Показатели
        </h3>
        {report.indicators.length > 0 ? (
          <div className="divide-y divide-border border-y border-border">
            {report.indicators.map(
              ({ card, definition, scope, unit, plan, actual }) => (
                <article
                  key={card.cardId}
                  className="flex min-w-0 flex-col gap-2.5 py-3.5"
                >
                  <h4 className="text-sm font-semibold">
                    <Link href={versionHref(card)} className={sourceClass}>
                      {card.title}
                    </Link>
                  </h4>
                  <p className="max-w-[70ch] text-sm wrap-anywhere text-muted-foreground">
                    {definition}
                  </p>
                  <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm wrap-anywhere">
                    <div className="flex min-w-0 flex-wrap gap-x-1.5">
                      <dt className="text-muted-foreground">Контур</dt>
                      <dd>{scopeLabel(scope)}</dd>
                    </div>
                    <div className="flex min-w-0 flex-wrap gap-x-1.5">
                      <dt className="text-muted-foreground">Единица</dt>
                      <dd>{unit}</dd>
                    </div>
                  </dl>
                  <dl className="grid grid-cols-1 divide-y divide-border rounded-lg bg-muted/50 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                    <Measurement
                      label="План"
                      dateLabel="Срок"
                      measurement={plan}
                      unit={unit}
                    />
                    <Measurement
                      label="Факт"
                      dateLabel="На дату"
                      measurement={actual}
                      unit={unit}
                    />
                  </dl>
                </article>
              )
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Нет подтверждённых данных
          </p>
        )}
      </section>
    </div>
  );
}

function Loading({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="flex flex-col gap-2 text-sm text-muted-foreground"
    >
      {message}
      <Skeleton
        aria-hidden="true"
        className="h-8 w-full max-w-lg motion-reduce:animate-none"
      />
    </div>
  );
}

export function StrategyAnalytics() {
  const workspaceRequest = useWorkspaceRequest();
  const [options, setOptions] = useState<OptionsState>({ status: "idle" });
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [targetKey, setTargetKey] = useState(allTargets);
  const [report, setReport] = useState<StrategyAnalyticsReport | null>(null);
  const [reportError, setReportError] = useState<{
    message: string;
    reloadOptions?: boolean;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const optionsRequest = useRef<AbortController | null>(null);
  const reportRequest = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      optionsRequest.current?.abort();
      reportRequest.current?.abort();
    },
    []
  );

  const documents = options.status === "ready" ? options.documents : [];
  const selected = documents.find(({ cardId }) => cardId === documentId);
  const clauses = selected?.document.clauses ?? [];
  const directions = selected?.document.directions ?? [];
  const targets = [
    ...clauses.map(({ id, locator }) => ({
      kind: "clause" as const,
      id,
      label: `Пункт ${locator}`,
      key: `clause:${id}`,
    })),
    ...directions.map(({ id, title }) => ({
      kind: "direction" as const,
      id,
      label: title,
      key: `direction:${id}`,
    })),
  ];

  function clearReport() {
    reportRequest.current?.abort();
    reportRequest.current = null;
    setSubmitting(false);
    setReport(null);
    setReportError(null);
  }

  async function loadOptions() {
    if (optionsRequest.current) return;
    const controller = new AbortController();
    optionsRequest.current = controller;
    clearReport();
    setOptions({ status: "loading" });
    setDocumentId(null);
    setTargetKey(allTargets);
    const fallback = "Не удалось загрузить документы.";
    try {
      const response = await workspaceRequest("/api/strategy/options", {
        signal: controller.signal,
      });
      const data = (await response.json()) as StrategyOptions & {
        error?: string;
      };
      if (controller.signal.aborted) return;
      setOptions(
        response.ok
          ? { status: "ready", documents: data.documents }
          : { status: "error", message: data.error ?? fallback }
      );
    } catch {
      if (!controller.signal.aborted)
        setOptions({ status: "error", message: fallback });
    } finally {
      if (optionsRequest.current === controller) optionsRequest.current = null;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || reportRequest.current) return;
    const target = targets.find(({ key }) => key === targetKey);
    const parsed = strategyAnalyticsQuerySchema.safeParse({
      mode: "strategy",
      documentId: selected.cardId,
      documentVersionId: selected.versionId,
      ...(target && { target: { kind: target.kind, id: target.id } }),
    });
    if (!parsed.success) {
      setReportError({
        message: "Не удалось применить фильтр. Обновите список документов.",
        reloadOptions: true,
      });
      return;
    }

    const controller = new AbortController();
    reportRequest.current = controller;
    setSubmitting(true);
    setReportError(null);
    setReport(null);
    const fallback = "Не удалось собрать справку. Попробуйте ещё раз.";
    try {
      const response = await workspaceRequest("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
        signal: controller.signal,
      });
      const data = (await response.json()) as StrategyAnalyticsReport & {
        error?: string;
      };
      if (controller.signal.aborted) return;
      if (response.ok) setReport(data);
      else
        setReportError({
          message: data.error ?? fallback,
          reloadOptions: response.status === 404,
        });
    } catch {
      if (!controller.signal.aborted) setReportError({ message: fallback });
    } finally {
      if (reportRequest.current === controller) {
        reportRequest.current = null;
        setSubmitting(false);
      }
    }
  }

  return (
    <details
      className="group/strategy min-w-0 rounded-xl border border-border bg-card/75"
      onToggle={(event) => {
        if (event.currentTarget.open && options.status === "idle")
          void loadOptions();
      }}
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2.5 rounded-xl px-3 py-2.5 hover:bg-muted/40 sm:px-4 [&::-webkit-details-marker]:hidden">
        <Route
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <h2 className="flex-1 text-sm font-semibold">Стратегия и показатели</h2>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open/strategy:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <div className="flex min-w-0 flex-col gap-4 border-t border-border px-3 py-4 sm:px-4">
        {(options.status === "idle" || options.status === "loading") && (
          <Loading message="Загружаем документы…" />
        )}
        {options.status === "error" && (
          <Alert>
            <TriangleAlert aria-hidden="true" />
            <AlertDescription className="flex flex-wrap items-center gap-2">
              <span>{options.message}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadOptions()}
              >
                Повторить загрузку
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {options.status === "ready" &&
          (documents.length === 0 ? (
            <Empty className="p-3 sm:p-4">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileSearch aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>Утверждённых документов пока нет</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <form onSubmit={submit} aria-label="Фильтры по стратегии">
              <FieldGroup className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <Field className="min-w-0 gap-1.5">
                  <FieldLabel htmlFor="strategy-document">Документ</FieldLabel>
                  <Select
                    value={documentId}
                    onValueChange={(value) => {
                      setDocumentId(value);
                      setTargetKey(allTargets);
                      clearReport();
                    }}
                  >
                    <SelectTrigger
                      id="strategy-document"
                      className="h-10 min-w-0 w-full"
                    >
                      <SelectValue placeholder="Выберите документ" />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {documents.map(({ cardId, title }) => (
                          <SelectItem key={cardId} value={cardId}>
                            <span className="whitespace-normal wrap-anywhere">
                              {title}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field className="min-w-0 gap-1.5" data-disabled={!selected}>
                  <FieldLabel htmlFor="strategy-target">
                    Пункт или направление
                  </FieldLabel>
                  <Select
                    disabled={!selected}
                    value={targetKey}
                    onValueChange={(value) => {
                      setTargetKey(value ?? allTargets);
                      clearReport();
                    }}
                  >
                    <SelectTrigger
                      id="strategy-target"
                      className="h-10 min-w-0 w-full"
                    >
                      <SelectValue>
                        {" "}
                        {targetKey === allTargets
                          ? "Весь документ"
                          : targets.find(({ key }) => key === targetKey)?.label}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        <SelectItem value={allTargets}>
                          Весь документ
                        </SelectItem>
                      </SelectGroup>
                      {(["clause", "direction"] as const).map(
                        (kind) =>
                          targets.some((target) => target.kind === kind) && (
                            <SelectGroup key={kind}>
                              <SelectLabel>
                                {kind === "clause" ? "Пункты" : "Направления"}
                              </SelectLabel>
                              {targets
                                .filter((item) => item.kind === kind)
                                .map(({ key, label }) => (
                                  <SelectItem key={key} value={key}>
                                    <span className="whitespace-normal wrap-anywhere">
                                      {label}
                                    </span>
                                  </SelectItem>
                                ))}
                            </SelectGroup>
                          )
                      )}
                    </SelectContent>
                  </Select>
                </Field>
                <Button
                  type="submit"
                  disabled={!selected || submitting}
                  className="h-10 justify-self-start"
                >
                  Собрать справку
                </Button>
              </FieldGroup>
            </form>
          ))}
        {reportError && (
          <Alert>
            <TriangleAlert aria-hidden="true" />
            <AlertDescription className="flex flex-wrap items-center gap-2">
              <span>{reportError.message}</span>
              {reportError.reloadOptions && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadOptions()}
                >
                  Обновить список документов
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
        {submitting && <Loading message="Собираем справку…" />}
        {report && (
          <>
            <p role="status" className="sr-only">
              Справка собрана.
            </p>
            <Report report={report} />
          </>
        )}
      </div>
    </details>
  );
}
