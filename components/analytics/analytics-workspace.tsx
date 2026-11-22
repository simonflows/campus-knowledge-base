"use client";
import {
  MastheadCount,
  WorkspaceMasthead,
} from "@/components/workspace-masthead";
import { AnimatedNumber } from "@/components/motion/animated-number";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  BarChart3,
  Building2,
  ClipboardList,
  Copy,
  ExternalLink,
  FileText,
  FlaskConical,
  FolderTree,
  Layers3,
  List,
  Loader2,
  Network,
  Search,
  Table2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { isCurrentFlashRequest } from "@/components/flash-assist-hint";
import { CanonAiOption, CanonAiReview } from "@/components/canon-ai-review";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AnalyticsCardRow, AnalyticsReport } from "@/lib/analytics";
import type { CanonAnalyticsAiReview } from "@/lib/canon-analytics-ai";
import { cn } from "@/lib/utils";
import { analyticsQuerySchema } from "@/lib/validation/analytics";

type AnalyticsWorkspaceProps = {
  cardsCount: number;
  dbAvailable: boolean;
  flashAssistAvailable?: boolean;
  dynamicExamples?: string[];
};

type ViewMode = "table" | "list";

type AnalyticsResponse = AnalyticsReport & { error?: string; ai?: CanonAnalyticsAiReview };

const summaryLabels = [
  { key: "total", label: "Найдено карточек" },
  { key: "projects", label: "Проекты" },
  { key: "laboratories", label: "Лаборатории" },
  { key: "jointProjects", label: "Совместные" },
] as const;

function SourceLink({
  href,
  label,
  compact = false,
}: {
  href: string;
  label: string;
  compact?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        buttonVariants({ variant: "outline", size: "sm" }),
        "gap-1.5",
        compact && "h-7 px-2 text-[11px]"
      )}
    >
      <ExternalLink className="size-3.5" />
      {label}
    </Link>
  );
}

function FilterChips({ report, centered = false }: { report: AnalyticsReport; centered?: boolean }) {
  if (report.filters.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Критерии не сужены: показаны все проекты и лаборатории базы.
      </p>
    );
  }

  return (
    <div className={cn("flex flex-wrap gap-2", centered && "justify-center")}>
      {report.filters.map((filter, index) => (
        <Badge
          key={`${filter.key}-${filter.value}-${index}`}
          variant="secondary"
          className="h-auto max-w-full gap-1 whitespace-normal py-1 text-left text-[11px] leading-snug"
        >
          <span className={cn("font-semibold", centered && "shrink-0 whitespace-nowrap")}>{filter.label}:</span>
          <span className={centered ? "min-w-0 break-words" : undefined}>{filter.value}</span>
        </Badge>
      ))}
    </div>
  );
}

function SummaryCard({ report }: { report: AnalyticsReport }) {
  const { summary, cards } = report;

  return (
    <Card className="data-report-summary atlas-stagger-in">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <ClipboardList className="size-4 text-primary" />
              Аналитическая справка
            </CardTitle>
            <CardDescription>
              Выборка по точным полям карточек: отрасль, вузы, партнёры, статус,
              контур. Каждое сведение ведёт к карточке-источнику.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Критерии запроса
          </p>
          <div className="mt-2">
            <FilterChips report={report} />
          </div>
        </div>

        <dl className="data-report-metrics">
          {summaryLabels.map((item) => (
            <div key={item.key}>
              <dt>{item.label}</dt>
              <dd>
                <AnimatedNumber value={summary[item.key]} />
                <span className="data-report-track" aria-hidden="true">
                  <i
                    className="atlas-bar-grow"
                    style={{
                      inlineSize: `${summary.total > 0 ? (summary[item.key] / summary.total) * 100 : 0}%`,
                    }}
                  />
                </span>
              </dd>
            </div>
          ))}
        </dl>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Building2 className="size-3.5" />
              Вузы в выборке
            </p>
            <div className="flex flex-wrap gap-1.5">
              {summary.universities.length > 0 ? (
                summary.universities.map((university) => (
                  <Badge key={university} variant="secondary">
                    {university}
                  </Badge>
                ))
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Network className="size-3.5" />
              Партнёры в выборке
            </p>
            <div className="flex flex-wrap gap-1.5">
              {summary.partners.length > 0 ? (
                summary.partners.map((partner) => (
                  <Badge
                    key={partner}
                    variant="outline"
                    className="h-auto py-1"
                  >
                    {partner}
                  </Badge>
                ))
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <BarChart3 className="size-3.5" />
              Статусы
            </p>
            <div className="flex flex-wrap gap-1.5">
              {summary.stages.length > 0 ? (
                summary.stages.map((stage) => (
                  <Badge key={stage.label} variant="outline">
                    {stage.label}: {stage.count}
                  </Badge>
                ))
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Layers3 className="size-3.5" />
              Контуры
            </p>
            <div className="flex flex-wrap gap-1.5">
              {summary.contours.length > 0 ? (
                summary.contours.map((contour) => (
                  <Badge key={contour.label} variant="outline">
                    {contour.label}: {contour.count}
                  </Badge>
                ))
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-2xl bg-muted/40 p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <FileText className="size-3.5" />
            Карточки-источники справки
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {cards.map((card) => (
              <Link
                key={card.id}
                href={card.sourceHref}
                className="inline-flex max-w-full items-center gap-1 rounded-full border bg-background px-2.5 py-1 text-[11px] font-medium transition-colors hover:border-primary/40 hover:text-primary"
              >
                <ExternalLink className="size-3 shrink-0" />
                <span className="truncate">{card.title}</span>
              </Link>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TableView({ cards }: { cards: AnalyticsCardRow[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border">
      <table className="w-full min-w-[980px] border-collapse text-sm">
        <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-semibold">Карточка</th>
            <th className="px-3 py-2 font-semibold">Отрасль</th>
            <th className="px-3 py-2 font-semibold">Вузы</th>
            <th className="px-3 py-2 font-semibold">Партнёр</th>
            <th className="px-3 py-2 font-semibold">Статус</th>
            <th className="px-3 py-2 font-semibold">Контур</th>
            <th className="px-3 py-2 font-semibold">Цифры и факты</th>
            <th className="px-3 py-2 font-semibold">Источник</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => (
            <tr key={card.id} className="border-t align-top">
              <td className="max-w-[220px] px-3 py-3">
                <Link
                  href={card.sourceHref}
                  className="font-semibold leading-snug hover:text-primary"
                >
                  {card.title}
                </Link>
                <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                  <Badge
                    variant="secondary"
                    className="h-auto py-0.5 text-[10px]"
                  >
                    {card.cardTypeLabel}
                  </Badge>
                </div>
                <div className="mt-1 flex items-start gap-1 text-[11px] text-muted-foreground">
                  <FolderTree className="mt-0.5 size-3 shrink-0" />
                  <span>{card.folder}</span>
                </div>
              </td>
              <td className="min-w-[150px] px-3 py-3 text-xs leading-relaxed">
                {card.industry}
              </td>
              <td className="min-w-[130px] px-3 py-3 text-xs leading-relaxed">
                {card.universities.length > 0
                  ? card.universities.join(", ")
                  : "—"}
              </td>
              <td className="min-w-[160px] px-3 py-3 text-xs leading-relaxed">
                {card.partner}
              </td>
              <td className="min-w-[130px] px-3 py-3 text-xs leading-relaxed">
                {card.status}
              </td>
              <td className="min-w-[110px] px-3 py-3 text-xs leading-relaxed">
                {card.contour}
              </td>
              <td className="min-w-[220px] px-3 py-3">
                {card.figures.length > 0 ? (
                  <ul className="space-y-1.5">
                    {card.figures.map((figure) => (
                      <li key={figure}>
                        <Link
                          href={card.sourceHref}
                          className="group inline-flex items-start gap-1 text-xs leading-relaxed text-foreground/80 hover:text-primary"
                        >
                          <ExternalLink className="mt-0.5 size-3 shrink-0 opacity-60 group-hover:opacity-100" />
                          <span>{figure}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-3 py-3">
                <SourceLink href={card.sourceHref} label="Карточка" compact />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListView({ cards }: { cards: AnalyticsCardRow[] }) {
  return (
    <div className="space-y-3">
      {cards.map((card) => (
        <div
          key={card.id}
          className="rounded-2xl border bg-card p-4 shadow-sm transition-colors hover:border-primary/30"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="text-[10px]">
                  {card.cardTypeLabel}
                </Badge>
                {card.isJoint ? (
                  <Badge variant="outline" className="text-[10px]">
                    Совместный
                  </Badge>
                ) : null}
              </div>
              <Link
                href={card.sourceHref}
                className="mt-2 block font-heading text-base font-semibold leading-snug hover:text-primary"
              >
                {card.title}
              </Link>
              <div className="mt-1 flex items-start gap-1 text-[11px] text-muted-foreground">
                <FolderTree className="mt-0.5 size-3 shrink-0" />
                <span>{card.folder}</span>
              </div>
            </div>
            <SourceLink href={card.sourceHref} label="Карточка-источник" />
          </div>

          <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Отрасль
              </dt>
              <dd className="mt-0.5 leading-relaxed">{card.industry}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Вузы
              </dt>
              <dd className="mt-0.5 leading-relaxed">
                {card.universities.length > 0
                  ? card.universities.join(", ")
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Партнёр
              </dt>
              <dd className="mt-0.5 leading-relaxed">{card.partner}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Статус и контур
              </dt>
              <dd className="mt-0.5 leading-relaxed">
                {card.status} · {card.contour}
              </dd>
            </div>
          </dl>

          <div className="mt-4 rounded-xl bg-muted/40 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Цифры и факты
            </p>
            {card.figures.length > 0 ? (
              <ul className="mt-1.5 space-y-1.5">
                {card.figures.map((figure) => (
                  <li key={figure}>
                    <Link
                      href={card.sourceHref}
                      className="group inline-flex items-start gap-1.5 text-sm leading-relaxed hover:text-primary"
                    >
                      <ExternalLink className="mt-1 size-3.5 shrink-0 text-muted-foreground group-hover:text-primary" />
                      <span>{figure}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-sm text-muted-foreground">
                Подтверждённых цифр в карточке нет.
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function buildReportText(report: AnalyticsResponse, origin: string): string {
  const lines: string[] = [
    "Аналитическая справка по базе",
    ...(report.ai?.appliedQuery
      ? [
          `Исходный запрос — ${report.ai.originalQuery}`,
          `Запрос для расчёта — ${report.ai.appliedQuery}`,
        ]
      : [`Запрос: ${report.query}`]),
  ];

  if (report.filters.length > 0) {
    lines.push(
      `Критерии: ${report.filters
        .map((filter) => `${filter.label} — ${filter.value}`)
        .join("; ")}`
    );
  }

  if (report.notice) {
    lines.push("", report.notice);
    return lines.join("\n");
  }

  lines.push(
    "",
    `Найдено карточек: ${report.summary.total}. Проектов: ${report.summary.projects}. Лабораторий: ${report.summary.laboratories}. Совместных: ${report.summary.jointProjects}.`,
    "",
    "Сводная таблица"
  );

  report.cards.forEach((card) => {
    lines.push(
      "",
      `${card.title} (${card.cardTypeLabel})`,
      `Отрасль: ${card.industry}`,
      `Вузы: ${card.universities.length > 0 ? card.universities.join(", ") : "—"}`,
      `Партнёр: ${card.partner}`,
      `Статус: ${card.status}`,
      `Контур: ${card.contour}`
    );

    if (card.figures.length > 0) {
      lines.push(`Цифры и факты: ${card.figures.join("; ")}`);
    } else {
      lines.push("Цифры и факты: подтверждённых данных нет");
    }

    lines.push(`Источник: ${origin}${card.sourceHref}`);
  });

  lines.push(
    "",
    "Все сведения взяты из перечисленных карточек базы. Данные не дополнялись и не додумывались."
  );

  return lines.join("\n");
}

export function AnalyticsWorkspace({
  cardsCount,
  dbAvailable,
  flashAssistAvailable = false,
  dynamicExamples = [],
}: AnalyticsWorkspaceProps) {
  const [query, setQuery] = useState("");
  const [report, setReport] = useState<AnalyticsResponse | null>(null);
  const [view, setView] = useState<ViewMode>("table");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiEnabled, setAiEnabled] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleQueryChange = (value: string) => {
    abortRef.current?.abort();
    abortRef.current = null;
    setQuery(value);
    setIsLoading(false);
    setReport(null);
    setError(null);
  };

  const requestAnalytics = async () => {
    if (abortRef.current) return;
    const parsed = analyticsQuerySchema.safeParse({
      query,
      ...(flashAssistAvailable && aiEnabled && { useAi: true }),
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Проверьте текст запроса");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
        signal: controller.signal,
      });
      const data = (await response.json().catch(() => null)) as
        | AnalyticsResponse
        | null;

      if (!isCurrentFlashRequest(controller, abortRef.current)) return;
      if (!response.ok || !data) {
        const message =
          data?.error ??
          "Не удалось собрать аналитику. Проверьте соединение и попробуйте ещё раз.";
        setError(message);
        toast.error(message);
        return;
      }

      if (data.error) {
        setError(data.error);
        toast.error(data.error);
        return;
      }

      setReport(data);
      setView("table");

      if (data.cards.length === 0) {
        toast(data.interpretation?.status === "needs-clarification" ? "Уточните запрос" : "Подходящих карточек нет", {
          description: data.notice ?? undefined,
        });
      } else {
        toast.success("Аналитика собрана", {
          description: `Найдено карточек: ${data.summary.total}.`,
        });
      }
    } catch {
      if (!isCurrentFlashRequest(controller, abortRef.current)) return;
      const message =
        "Сервис аналитики недоступен. Проверьте соединение и попробуйте ещё раз.";
      setError(message);
      toast.error(message);
    } finally {
      if (isCurrentFlashRequest(controller, abortRef.current)) {
        abortRef.current = null;
        setIsLoading(false);
      }
    }
  };

  const handleCopy = async () => {
    if (!report) return;

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("clipboard unavailable");
      }
      const origin = window.location.origin;
      await navigator.clipboard.writeText(buildReportText(report, origin));
      toast.success("Отчёт скопирован", {
        description:
          "В буфер обмена попали справка, таблица и ссылки на карточки-источники.",
      });
    } catch {
      toast.error("Не удалось скопировать отчёт");
    }
  };

  return (
    <div className="atlas-wrap data-workspace data-analytics">
      <WorkspaceMasthead
        id="analytics-title"
        icon={BarChart3}
        title="Сводная аналитика"
        description="Собирайте отчёты по отраслям, вузам и партнёрам. Из каждой строки можно открыть утверждённую карточку-источник."
        note={
          !dbAvailable && (
            <Badge variant="outline" className="bg-amber-100 text-amber-900">
              Статический режим: данные из стартового набора
            </Badge>
          )
        }
      >
        <MastheadCount count={cardsCount} label="карточек в базе" />
      </WorkspaceMasthead>

      <div className="data-report-grid">
        <Card className="data-query-card">
          <CardHeader>
            <h2 className="data-panel-title">
              <Search aria-hidden="true" />
              Запрос к базе
            </h2>
          </CardHeader>
          <CardContent className="space-y-3">
            <Label htmlFor="analytics-query" className="sr-only">
              Запрос к базе
            </Label>
            <Textarea
              id="analytics-query"
              value={query}
              onChange={(event) => handleQueryChange(event.target.value)}
              placeholder="Опишите, какие проекты, лаборатории или связи нужно собрать: отрасль, вуз, партнёр, статус, контур."
              className="data-editor-field data-query-field"
            />

            {flashAssistAvailable && (
              <CanonAiOption kind="analytics" checked={aiEnabled} disabled={isLoading} onChange={setAiEnabled} />
            )}

            <div className="data-action-row">
              <Button
                type="button"
                onClick={() => void requestAnalytics()}
                disabled={isLoading}
              >
                {isLoading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Search className="size-4" />
                )}
                {isLoading ? "Собираем..." : "Собрать аналитику"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Карточки и числа в отчёте берутся из утверждённых данных.
              </span>
            </div>

            {!isLoading && report?.ai && <CanonAiReview review={report.ai} />}

            {error ? (
              <Alert variant="destructive">
                <TriangleAlert className="size-4" />
                <AlertTitle>Аналитика не собрана</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        </Card>
        <aside
          className="data-report-examples"
          aria-labelledby="analytics-examples-title"
        >
          <h2 id="analytics-examples-title">Примеры запросов</h2>
          <ul>
            {dynamicExamples.map((example) => (
              <li key={example}>
                <Button
                  type="button"
                  variant="ghost"
                  aria-pressed={query === example}
                  onClick={() => handleQueryChange(example)}
                  disabled={isLoading}
                >
                  <span>{example}</span>
                  <ArrowUpRight aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
          {dynamicExamples.length === 0 && (
            <p className="text-sm text-muted-foreground">Для текущего набора карточек пока нет примеров.</p>
          )}
        </aside>
      </div>

      {report ? (
        report.cards.length === 0 ? (
          <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-foreground/10">
            <CardContent className="py-4">
              <Empty className="border border-dashed py-10">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Search className="size-5" />
                  </EmptyMedia>
                  <EmptyTitle>{report.interpretation?.status === "needs-clarification" ? "Уточните запрос" : "Подходящих карточек нет"}</EmptyTitle>
                  <EmptyDescription>{report.interpretation?.message ?? report.notice}</EmptyDescription>
                </EmptyHeader>
                <div className="w-full max-w-2xl">
                  <FilterChips report={report} centered />
                </div>
              </Empty>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            <SummaryCard report={report} />

            <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-foreground/10">
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-lg">Результат выборки</CardTitle>
                    <CardDescription>
                      {report.summary.total} карточек. Переключайте таблицу и
                      список или скопируйте готовый отчёт.
                    </CardDescription>
                  </div>
                  <div className="hidden flex-wrap items-center gap-2 md:flex">
                    <div className="flex rounded-xl border bg-muted/40 p-1">
                      <Button
                        type="button"
                        variant={view === "table" ? "secondary" : "ghost"}
                        size="sm"
                        className="gap-1.5"
                        aria-pressed={view === "table"}
                        onClick={() => setView("table")}
                      >
                        <Table2 className="size-4" />
                        Таблица
                      </Button>
                      <Button
                        type="button"
                        variant={view === "list" ? "secondary" : "ghost"}
                        size="sm"
                        className="gap-1.5"
                        aria-pressed={view === "list"}
                        onClick={() => setView("list")}
                      >
                        <List className="size-4" />
                        Список
                      </Button>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={handleCopy}
                    >
                      <Copy className="size-4" />
                      Скопировать отчёт
                    </Button>
                  </div>
                  <div className="flex md:hidden">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-10 gap-1.5"
                      onClick={handleCopy}
                    >
                      <Copy className="size-4" />
                      Скопировать отчёт
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="min-w-0">
                {view === "table" ? (
                  <>
                    <div className="hidden md:block">
                      <TableView cards={report.cards} />
                    </div>
                    <div className="md:hidden">
                      <ListView cards={report.cards} />
                    </div>
                  </>
                ) : (
                  <ListView cards={report.cards} />
                )}
                <p className="mt-4 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  <FlaskConical className="mt-0.5 size-3.5 shrink-0" />
                  Все строки отобраны по точным полям карточек. Ссылки ведут на
                  карточку-источник в базе знаний; неподтверждённые сведения не
                  добавляются.
                </p>
              </CardContent>
            </Card>
          </div>
        )
      ) : null}
    </div>
  );
}
