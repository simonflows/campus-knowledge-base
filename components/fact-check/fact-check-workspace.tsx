"use client";
import {
  MastheadCount,
  WorkspaceMasthead,
} from "@/components/workspace-masthead";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  BookOpenCheck,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Layers3,
  ScanText,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
  TriangleAlert,
  Upload,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";

import {
  useWorkspaceMode,
  useWorkspaceRequest,
} from "@/components/demo/workspace-transport";
import {
  AppLink,
  WorkspaceExternalLink,
} from "@/components/navigation/workspace-navigation";
import { isCurrentFlashRequest } from "@/components/flash-assist-hint";
import { FactCoverage } from "@/components/fact-check/fact-coverage";
import {
  CanonAiOption,
  CanonAiReview,
  type FactAiReview,
} from "@/components/canon-ai-review";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AiActivity } from "@/components/ui/ai-activity";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  FACT_CHECK_PRESETS,
  type FactCheckPreset,
} from "@/lib/audit-canon-registry";
import {
  FACT_CHECK_CHECKPOINTS,
  type CanonicalRewrite,
  type CanonicalRewriteSection,
  type FactCheckCheckpointSummary,
  type FactCheckFinding,
  type FactCheckLevel,
  type FactCheckResult,
} from "@/lib/fact-check";
import { replaceCheckedFragment } from "@/lib/fact-check-edit";
import { previewFindings, type RewriteCheck } from "@/lib/fact-report";
import { RewriteCheckSummary } from "./rewrite-check-summary";
import type { RewriteAiReview } from "@/lib/canon-rewrite-ai";
import { factCheckInputSchema } from "@/lib/validation/fact-check";
import { factCheckResultSchema } from "@/lib/validation/fact-check-result";
import { cn } from "@/lib/utils";
import type { FactCheckProgress } from "@/lib/fact-check-progress";
import {
  FactCheckResponseError,
  readFactCheckResponse,
} from "@/lib/read-fact-check-response";

type FactCheckResponse = FactCheckResult & {
  ai?: FactAiReview;
  rewrite?: CanonicalRewrite | null;
  rewriteCheck?: RewriteCheck | null;
  rewriteAi?: RewriteAiReview;
  rewriteError?: string;
  error?: string;
};

type LevelFilter = "all" | FactCheckLevel;

type FactCheckWorkspaceProps = {
  cardsCount: number;
  flashAssistAvailable: boolean;
  approvedExample?: FactCheckPreset | null;
};

const trainingLabels: Record<string, string> = {
  "preset-tz-vr": "Медицинский VR-тренажёр",
  "preset-midis-kuka": "Робот KUKA и проекты МИДиС",
  "preset-passport-typos": "Цифры и названия из паспорта кампуса",
};
const trainingPresets = FACT_CHECK_PRESETS.map((preset) => ({
  ...preset,
  label: trainingLabels[preset.id] ?? preset.label,
  badge: "С неточностями",
}));

const levelStyles: Record<
  FactCheckLevel,
  {
    badge: string;
    card: string;
    icon: typeof CircleAlert;
    iconWrap: string;
  }
> = {
  red: {
    badge: "bg-red-100 text-red-700 hover:bg-red-100",
    card: "border-red-200 bg-red-50/60",
    icon: ShieldAlert,
    iconWrap: "bg-red-100 text-red-700",
  },
  yellow: {
    badge: "bg-amber-100 text-amber-800 hover:bg-amber-100",
    card: "border-amber-200 bg-amber-50/60",
    icon: ShieldQuestion,
    iconWrap: "bg-amber-100 text-amber-800",
  },
  green: {
    badge: "bg-emerald-100 text-emerald-700 hover:bg-emerald-100",
    card: "border-emerald-200 bg-emerald-50/60",
    icon: ShieldCheck,
    iconWrap: "bg-emerald-100 text-emerald-700",
  },
};

const levelLabels: Record<FactCheckLevel, string> = {
  red: "Красный",
  yellow: "Жёлтый",
  green: "Зелёный",
};

const filters: Array<{ value: LevelFilter; label: string }> = [
  { value: "all", label: "Все результаты" },
  { value: "red", label: "Красные" },
  { value: "yellow", label: "Жёлтые" },
  { value: "green", label: "Зелёные" },
];

const checkpoints = Object.entries(FACT_CHECK_CHECKPOINTS) as Array<
  [keyof typeof FACT_CHECK_CHECKPOINTS, string]
>;

function SectionHeading({
  level,
  children,
}: {
  level: 2 | 3;
  children: React.ReactNode;
}) {
  if (level === 3) {
    return (
      <h3 className="font-heading text-base font-semibold leading-snug">
        {children}
      </h3>
    );
  }

  return (
    <h2 className="font-heading text-lg font-semibold leading-snug">
      {children}
    </h2>
  );
}

function CheckpointChips({
  summaries,
}: {
  summaries: FactCheckCheckpointSummary[];
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {summaries.map((checkpoint) => {
        const total = checkpoint.red + checkpoint.yellow + checkpoint.green;

        return (
          <div
            key={checkpoint.key}
            className="flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1.5 text-[11px]"
          >
            <span className="font-medium">{checkpoint.label}</span>
            {total === 0 ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              <span className="flex items-center gap-1">
                {checkpoint.red > 0 ? (
                  <span className="rounded-full bg-red-100 px-1.5 text-red-700">
                    {checkpoint.red}
                  </span>
                ) : null}
                {checkpoint.yellow > 0 ? (
                  <span className="rounded-full bg-amber-100 px-1.5 text-amber-800">
                    {checkpoint.yellow}
                  </span>
                ) : null}
                {checkpoint.green > 0 ? (
                  <span className="rounded-full bg-emerald-100 px-1.5 text-emerald-700">
                    {checkpoint.green}
                  </span>
                ) : null}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FindingCard({
  finding,
  onReplace,
  busy,
  index = 0,
}: {
  finding: FactCheckFinding;
  onReplace?: (finding: FactCheckFinding, replacement: string) => void;
  busy: boolean;
  index?: number;
}) {
  const [replacement, setReplacement] = useState("");
  const style = levelStyles[finding.level];
  const Icon = style.icon;

  return (
    <div
      className={cn("atlas-stagger-item rounded-2xl border p-4", style.card)}
      style={{ "--stagger-i": index } as CSSProperties}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-xl",
              style.iconWrap
            )}
          >
            <Icon className="size-4" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={style.badge}>
                {levelLabels[finding.level]}
              </Badge>
              <Badge variant="outline" className="text-[11px]">
                {finding.checkpointLabel}
              </Badge>
            </div>
            <p className="mt-2 text-sm font-semibold">{finding.title}</p>
          </div>
        </div>
      </div>
      {finding.quote ? (
        <blockquote className="mt-3 text-sm leading-relaxed text-foreground/80">
          «{finding.quote}»
        </blockquote>
      ) : null}
      <details className="mt-2">
        <summary className="cursor-pointer py-2 text-xs font-medium text-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
          {finding.level === "green"
            ? "Источник подтверждения"
            : "Источники и исправление"}
        </summary>
        <div className="flex flex-wrap gap-2">
          {finding.sourceUrl && (
            <WorkspaceExternalLink
              href={finding.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <ExternalLink data-icon="inline-start" />
              Первоисточник
            </WorkspaceExternalLink>
          )}
          {!finding.sourceCardId && (
            <AppLink
              href={`/requests?${new URLSearchParams({ q: `Прошу уточнить факт: ${finding.title}. Фрагмент: ${finding.quote ?? ""}` }).toString()}`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Запросить подтверждение у вуза
            </AppLink>
          )}
          {finding.sourceCardId && (
            <AppLink
              href={`/knowledge?card=${encodeURIComponent(finding.sourceCardId)}&version=${encodeURIComponent(finding.sourceVersionId ?? "approved")}`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Официальная карточка
            </AppLink>
          )}
          {finding.sourceCardId && (
            <AppLink
              href={`/knowledge?${new URLSearchParams({ card: finding.sourceCardId, action: "request", finding: finding.title, quote: finding.quote ?? "" }).toString()}#edit-request`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Оспорить и приложить источник
            </AppLink>
          )}
        </div>

        <p className="mt-3 text-sm leading-relaxed text-foreground/80">
          {finding.explanation}
        </p>

        {finding.level !== "green" && (
          <div className="mt-3 rounded-xl bg-background/70 p-3">
            <p className="text-xs font-semibold text-muted-foreground">
              Как исправить
            </p>
            <p className="mt-1 text-sm leading-relaxed">{finding.suggestion}</p>
          </div>
        )}

        {finding.sourceCardId ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {finding.sourceCardTitle} · {finding.sourceFolder}
          </p>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            Официальный источник не найден. Уточните сведения перед публикацией.
          </p>
        )}
        {onReplace && finding.level !== "green" && finding.quote && (
          <form
            className="mt-4 flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              onReplace(finding, replacement);
            }}
          >
            <label
              htmlFor={`replacement-${finding.id}`}
              className="text-sm font-medium"
            >
              Исправить только этот фрагмент
            </label>
            <Textarea
              id={`replacement-${finding.id}`}
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              placeholder="Введите проверенную формулировку…"
              maxLength={20000}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={busy || !replacement.trim()}
            >
              Заменить фрагмент и проверить снова
            </Button>
          </form>
        )}
      </details>
    </div>
  );
}

export function FactCheckWorkspace({
  cardsCount,
  flashAssistAvailable,
  approvedExample,
}: FactCheckWorkspaceProps) {
  const request = useWorkspaceRequest();
  const workspaceMode = useWorkspaceMode();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<FactCheckResponse | null>(null);
  const [rewrite, setRewrite] = useState<CanonicalRewrite | null>(null);
  const [rewriteRevision, setRewriteRevision] = useState<number | null>(null);
  const [rewriteCheck, setRewriteCheck] = useState<RewriteCheck | null>(null);
  const [rewriteError, setRewriteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [progress, setProgress] = useState<FactCheckProgress | null>(null);
  const [isRewriting, setIsRewriting] = useState(false);
  const [rewritingWithAi, setRewritingWithAi] = useState(false);
  const [filter, setFilter] = useState<LevelFilter>("all");
  const [showAllFindings, setShowAllFindings] = useState(false);
  const [showAllRewriteFindings, setShowAllRewriteFindings] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(true);
  const requestRevision = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const rewriteHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const heading = rewriteHeading.current;
    if (!heading || rewriteRevision !== requestRevision.current) return;

    const reduceMotion =
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      document.documentElement.dataset.motion === "off";
    const headerBottom =
      document.querySelector("header.atlas-header")?.getBoundingClientRect()
        .bottom ?? 0;
    const scrollPadding =
      Number.parseFloat(
        getComputedStyle(document.documentElement).scrollPaddingTop
      ) || 0;
    heading.style.scrollMarginTop = `${Math.max(16, headerBottom + 16 - scrollPadding)}px`;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({
      behavior: reduceMotion ? "instant" : "smooth",
      block: "start",
    });
  }, [rewriteRevision]);

  const FindingsContainer = rewrite ? "details" : "section";

  const visibleFindings = useMemo(() => {
    if (!result) return [];
    if (filter === "all") {
      const order = { red: 0, yellow: 1, green: 2 };
      return [...result.findings].sort(
        (a, b) => order[a.level] - order[b.level]
      );
    }

    return result.findings.filter((finding) => finding.level === filter);
  }, [result, filter]);

  const hasRed = (result?.summary.red ?? 0) > 0;
  const hasYellow = (result?.summary.yellow ?? 0) > 0;
  const displayedFindings = showAllFindings
    ? visibleFindings
    : previewFindings(visibleFindings);
  const omittedFindings = useMemo(() => {
    if (!result || !rewrite) return [];
    const byQuote = new Map<string, FactCheckFinding>();
    for (const finding of result.findings) {
      if (
        finding.level !== "green" &&
        finding.quote &&
        !rewrite.plainText.includes(finding.quote) &&
        !byQuote.has(finding.quote)
      ) {
        byQuote.set(finding.quote, finding);
      }
    }
    return [...byQuote.values()];
  }, [result, rewrite]);
  const retainedFindings = useMemo(() => {
    if (!result || !rewrite) return [];
    return result.findings.filter(
      (finding) =>
        finding.level !== "green" &&
        finding.quote &&
        rewrite.plainText.includes(finding.quote)
    );
  }, [result, rewrite]);

  const resetOutput = () => {
    requestRevision.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setIsChecking(false);
    setProgress(null);
    setIsRewriting(false);
    setResult(null);
    setRewrite(null);
    setRewriteRevision(null);
    setRewriteCheck(null);
    setRewriteError(null);
    setError(null);
    setFilter("all");
    setShowAllFindings(false);
    setShowAllRewriteFindings(false);
  };

  const handleTextChange = (value: string) => {
    setText(value);
    setFileName(null);

    resetOutput();
  };

  const handlePreset = (preset: FactCheckPreset) => {
    setText(preset.text);
    setFileName(null);
    resetOutput();
    toast(`Загружен пример: ${preset.label}`, {
      description: preset.description,
    });
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;

    if (!/\.(txt|md|markdown)$/i.test(file.name)) {
      toast.error("Поддерживаются текстовые файлы .txt и .md");
      return;
    }

    if (file.size > 250_000) {
      toast.error("Файл слишком большой", {
        description: "Загрузите текстовый файл до 250 КБ.",
      });
      return;
    }

    resetOutput();
    const revision = requestRevision.current;
    const content = await file.text();
    if (revision !== requestRevision.current) return;

    if (!content.trim()) {
      toast.error("Файл пустой");
      return;
    }

    setText(content);
    setFileName(file.name);
    resetOutput();
    toast.success("Файл загружен", { description: file.name });
  };

  const requestFactCheck = async (
    mode: "check" | "rewrite",
    draft = text,
    rewriteWithAi = false
  ) => {
    if (abortRef.current) return;
    const parsed = factCheckInputSchema.safeParse({
      text: draft,
      mode,
      ...(flashAssistAvailable &&
        (mode === "rewrite" ? rewriteWithAi : aiEnabled) && { useAi: true }),
    });
    if (!parsed.success) {
      toast.error(
        parsed.error.issues[0]?.message ?? "Проверьте длину черновика"
      );
      return;
    }

    const revision = ++requestRevision.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress(null);
    setResult(null);
    setRewrite(null);
    setRewriteRevision(null);
    setRewriteCheck(null);
    setRewriteError(null);
    setError(null);
    if (mode === "check") {
      setIsChecking(true);
    } else {
      setIsRewriting(true);
      setRewritingWithAi(Boolean(parsed.data.useAi && workspaceMode !== "demo"));
    }

    const deadline = window.setTimeout(() => {
      if (
        revision === requestRevision.current &&
        abortRef.current === controller
      ) {
        controller.abort();
        const message =
          "Время ожидания истекло. Проверка не завершена; повторите запрос или разделите текст.";
        setError(message);
        toast.error(message);
      }
    }, 210_000);
    try {
      const responseSignal = controller.signal;
      const response = await request("/api/fact-check", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(mode === "check" &&
            parsed.data.useAi &&
            workspaceMode !== "demo" && { Accept: "application/x-ndjson" }),
        },
        body: JSON.stringify(parsed.data),
        signal: responseSignal,
      });
      const data = (await readFactCheckResponse(
        response,
        (next) => {
          if (
            revision === requestRevision.current &&
            isCurrentFlashRequest(controller, abortRef.current)
          )
            setProgress(next);
        },
        responseSignal
      )) as FactCheckResponse | null;

      if (
        revision !== requestRevision.current ||
        !isCurrentFlashRequest(controller, abortRef.current)
      )
        return;
      if (!response.ok || !data) {
        const message =
          (typeof data?.error === "string" ? data.error : null) ??
          "Не удалось проверить текст. Попробуйте ещё раз или сократите черновик.";
        setError(message);
        toast.error(message);
        return;
      }

      if (data.error) {
        const message =
          typeof data.error === "string"
            ? data.error
            : "Сервис вернул некорректный ответ. Повторите проверку.";
        setError(message);
        toast.error(message);
        return;
      }
      if (!factCheckResultSchema.safeParse(data).success) {
        throw new FactCheckResponseError(
          "Сервис вернул неполный результат. Повторите проверку."
        );
      }

      const leadingSpace = draft.length - draft.trimStart().length;
      if (leadingSpace > 0)
        data.findings = data.findings.map((finding) => ({
          ...finding,
          quoteStart:
            finding.quoteStart == null
              ? undefined
              : finding.quoteStart + leadingSpace,
          quoteEnd:
            finding.quoteEnd == null
              ? undefined
              : finding.quoteEnd + leadingSpace,
        }));
      setResult(data);
      setFilter("all");
      setShowAllFindings(false);
      setShowAllRewriteFindings(false);

      if (mode === "rewrite") {
        const nextRewrite = data.rewrite?.plainText.trim()
          ? data.rewrite
          : null;
        setRewrite(nextRewrite);
        setRewriteRevision(nextRewrite && !data.rewriteError ? revision : null);
        setRewriteCheck(data.rewriteCheck ?? null);
        setRewriteError(data.rewriteError ?? null);

        if (!nextRewrite) {
          toast.error("Не удалось переписать текст по официальным данным");
        } else if (data.rewriteCheck?.isClean) {
          toast.success("Текст переписан по официальным данным", {
            description:
              "В предложенном тексте нет красных и жёлтых замечаний.",
          });
        }
      } else {
        setRewrite(null);
        setRewriteCheck(null);
        setRewriteError(null);
        toast.success("Проверка завершена", {
          description: `Красных: ${data.summary.red}, жёлтых: ${data.summary.yellow}, зелёных: ${data.summary.green}.`,
        });
      }
    } catch (failure) {
      if (
        !isCurrentFlashRequest(controller, abortRef.current) ||
        revision !== requestRevision.current
      )
        return;
      const message =
        failure instanceof FactCheckResponseError
          ? failure.message
          : "Сервис проверки недоступен. Проверьте соединение и попробуйте ещё раз.";
      setError(message);
      toast.error(message);
    } finally {
      window.clearTimeout(deadline);
      if (
        revision === requestRevision.current &&
        abortRef.current === controller
      ) {
        abortRef.current = null;
        setIsChecking(false);
        setProgress(null);
        setIsRewriting(false);
      }
    }
  };

  const handleCopyRewrite = async () => {
    if (!rewrite) return;

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(rewrite.plainText);
      toast.success("Чистовик скопирован в буфер обмена");
    } catch {
      toast.error("Не удалось скопировать текст");
    }
  };

  const handleDownloadRewrite = () => {
    if (!rewrite) return;

    const markdown =
      rewrite.preservedText ??
      [
        `# ${rewrite.title}`,
        "",
        rewrite.lead,
        "",
        ...rewrite.sections.flatMap((section) => [
          `${"#".repeat(section.level)} ${section.heading}`,
          "",
          ...section.chunks.flatMap((chunk) => [chunk.content, ""]),
        ]),
        "---",
        `Официальные источники: ${rewrite.sourceCardTitles.join("; ")}`,
      ].join("\n");

    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "campus-canonical-rewrite.md";
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("Файл чистовика сохранён (.md)");
  };

  return (
    <div className="atlas-wrap data-workspace data-fact">
      <WorkspaceMasthead
        id="fact-check-title"
        icon={ShieldCheck}
        title="Проверка фактов"
        description="Сверьте черновик с официальными карточками и получите замечания со ссылками на источники."
      >
        <MastheadCount count={cardsCount} label="карточек в базе" />
      </WorkspaceMasthead>

      <div className="data-fact-grid">
        <Card className="data-draft-card">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="data-panel-title">
                  <FileText aria-hidden="true" />
                  Черновик текста
                </h2>
                <CardDescription>
                  Вставьте материал целиком или загрузите файл .txt / .md.
                </CardDescription>
              </div>
              <Badge variant="outline" className="data-char-count">
                <Layers3 className="size-3" />
                {text.trim().length} символов
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <Label htmlFor="fact-check-draft" className="sr-only">
              Черновик текста
            </Label>
            <Textarea
              id="fact-check-draft"
              value={text}
              onChange={(event) => handleTextChange(event.target.value)}
              placeholder="Вставьте готовый текст или черновик статьи. Проверка найдёт искажения авторства, статуса, контуров, названий, площадей и неподтверждённые цифры."
              className="data-editor-field"
            />

            {fileName ? (
              <div className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2 text-xs">
                <FileText className="size-3.5 text-muted-foreground" />
                <span className="font-medium">{fileName}</span>
                <span className="text-muted-foreground">загружен</span>
              </div>
            ) : null}

            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              className="hidden"
              onChange={(event) => {
                void handleFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />

            {flashAssistAvailable && (
              <CanonAiOption
                kind="fact"
                checked={aiEnabled}
                disabled={isChecking || isRewriting}
                onChange={setAiEnabled}
              />
            )}

            <div className="data-action-row">
              <Button
                type="button"
                onClick={() => requestFactCheck("check")}
                disabled={isChecking || isRewriting}
              >
                <ScanText data-icon="inline-start" aria-hidden="true" />
                {isChecking ? "Проверяем…" : "Проверить текст"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={isChecking || isRewriting}
              >
                <Upload className="size-4" />
                Загрузить файл
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => handlePreset(trainingPresets[0])}
                disabled={isChecking || isRewriting}
              >
                <ClipboardCheck className="size-4" />
                Пример текста
              </Button>
            </div>

            <section className="data-check-examples" aria-labelledby="fact-training-title">
              <h3 id="fact-training-title" className="text-sm font-semibold">Учебные тексты</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {[...trainingPresets, ...(approvedExample ? [approvedExample] : [])].map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={isChecking || isRewriting}
                    onClick={() => handlePreset(preset)}
                    className="data-check-example"
                    aria-pressed={text === preset.text}
                  >
                    <span className="text-xs font-semibold leading-snug">
                      {preset.label}
                    </span>
                    <Badge variant="secondary" className="text-[10px]">
                      {preset.badge}
                    </Badge>
                  </button>
                ))}
              </div>
            </section>

            <div className="data-rewrite-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => requestFactCheck("rewrite")}
                disabled={isChecking || isRewriting}
              >
                <Wand2 data-icon="inline-start" aria-hidden="true" />
                {isRewriting
                  ? "Переписываем…"
                  : "Переписать по официальным данным"}
              </Button>
              {flashAssistAvailable && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => requestFactCheck("rewrite", text, true)}
                    disabled={isChecking || isRewriting}
                    aria-describedby="fact-rewrite-ai-hint"
                  >
                    <Sparkles className="size-4" />
                    Переписать с ИИ
                  </Button>
                  <span
                    id="fact-rewrite-ai-hint"
                    className="text-xs text-muted-foreground"
                  >
                    {workspaceMode === "demo"
                      ? "В демо правка выполняется на этом устройстве."
                      : "Исходный текст и выбранные данные карточек передаются в Yandex AI Studio. Используйте публичный текст."}
                  </span>
                </>
              )}
            </div>

            {(isChecking || isRewriting) && (
              <div className="flex flex-wrap items-center gap-2">
                <AiActivity
                  className="flex-1"
                  label={isRewriting
                    ? rewritingWithAi ? "Готовим правки с ИИ" : "Переписываем по утверждённым карточкам"
                    : progress?.stage === "verify" ? "Этап 2 из 2. Сверяем факты с источниками"
                    : progress?.stage === "extract" ? "Этап 1 из 2. Разбираем текст"
                    : "Проверяем факты в тексте"}
                  detail={progress ? `Обработано ${progress.completed} из ${progress.total} групп.`
                    : isChecking && aiEnabled && flashAssistAvailable && workspaceMode !== "demo"
                      ? "Проверяем текст целиком. Длинная статья может занять до трёх минут."
                      : undefined}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    resetOutput();
                    toast(isChecking ? "Проверка остановлена" : "Переписывание остановлено");
                  }}
                >
                  Остановить
                </Button>
              </div>
            )}
            {error ? (
              <Alert variant="destructive">
                <TriangleAlert className="size-4" />
                <AlertTitle>Проверка не выполнена</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        </Card>

        <aside className="data-fact-output">
          <Card className="data-fact-summary">
            <CardHeader>
              <h2 className="data-panel-title">
                <ScanText aria-hidden="true" />
                {rewrite ? "Итог проверки исходного текста" : "Итог проверки"}
              </h2>
              <CardDescription>
                Красный уровень блокирует публикацию до правки.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3" aria-live="polite" aria-busy={isChecking || isRewriting}>
              {result ? (
                <div className="workspace-result space-y-3">
                  <div className="data-level-counts">
                    {(["red", "yellow", "green"] as FactCheckLevel[]).map(
                      (level) => {
                        const styles = levelStyles[level];
                        return (
                          <div
                            key={level}
                            className={cn("data-level-count", styles.card)}
                          >
                            <div className="text-2xl font-bold">
                              {result.summary[level]}
                            </div>
                            <div className="text-[11px] capitalize">
                              {levelLabels[level].toLowerCase()}
                            </div>
                          </div>
                        );
                      }
                    )}
                  </div>

                  <div
                    className={cn(
                      "rounded-xl p-3 text-sm",
                      hasRed
                        ? "bg-red-100 text-red-800"
                        : hasYellow
                          ? "bg-amber-100 text-amber-900"
                          : result.summary.green > 0
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-muted text-muted-foreground"
                    )}
                  >
                    <div className="flex items-center gap-2 font-semibold">
                      {hasRed ? (
                        <ShieldAlert className="size-4" />
                      ) : hasYellow ? (
                        <ShieldQuestion className="size-4" />
                      ) : (
                        <ShieldCheck className="size-4" />
                      )}
                      {hasRed
                        ? "Публикация запрещена до правки"
                        : hasYellow
                          ? "Нужно уточнить спорные факты"
                          : result.summary.green > 0
                            ? "Найденные факты подтверждены"
                            : "Проверяемые факты не найдены"}
                    </div>
                    <p className="mt-1 text-xs leading-relaxed">
                      {hasRed
                        ? `Исправьте ${result.summary.red} красное замечание, затем проверьте текст повторно.`
                        : hasYellow
                          ? `Проверьте неподтверждённые сведения и приложите официальный источник.`
                          : "Проверка охватывает только распознанные факты. Остальные сведения нужно сверить отдельно."}
                    </p>
                  </div>

                  <Separator />
                  <p className="text-xs text-muted-foreground">
                    Обработано {result.checkedChars.toLocaleString("ru-RU")}{" "}
                    символов.
                  </p>
                  <FactCoverage result={result} />
                </div>
              ) : (
                <Empty className="data-fact-empty">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <ScanText className="size-4" />
                    </EmptyMedia>
                    <EmptyTitle>{isChecking || isRewriting ? "Ожидаем результат" : "Проверка ещё не запускалась"}</EmptyTitle>
                    <EmptyDescription>
                      {isChecking || isRewriting
                        ? "Здесь появятся замечания и ссылки на источники."
                        : "Вставьте текст и нажмите «Проверить текст». Здесь появятся замечания и ссылки на источники."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </CardContent>
          </Card>
          {!isChecking && !isRewriting && result?.ai && (
            <CanonAiReview review={result.ai} />
          )}
          <details className="data-fact-checkpoints">
            <summary>
              Контрольные точки <span>{checkpoints.length}</span>
            </summary>
            <ul>
              {checkpoints.map(([key, label]) => (
                <li key={key}>
                  <CheckCircle2 aria-hidden="true" />
                  {label}
                </li>
              ))}
            </ul>
          </details>
          <details className="data-fact-checkpoints">
            <summary>Уровни замечаний</summary>
            <dl className="data-fact-legend">
              <div data-level="red">
                <dt>Красный</dt>
                <dd>
                  Противоречие официальным данным. Публикация запрещена до
                  правки.
                </dd>
              </div>
              <div data-level="yellow">
                <dt>Жёлтый</dt>
                <dd>Нет подтверждения в базе. Уточните факт и источник.</dd>
              </div>
              <div data-level="green">
                <dt>Зелёный</dt>
                <dd>Факт подтверждён официальной карточкой.</dd>
              </div>
            </dl>
          </details>
        </aside>
      </div>

      {result && (rewrite || rewriteError) ? (
        <section className="workspace-result space-y-4">
          <Separator />
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2
                ref={rewriteHeading}
                tabIndex={rewrite ? -1 : undefined}
                className="scroll-mt-4 font-heading text-xl font-semibold"
              >
                Текст, переписанный по официальным данным
              </h2>
              <p className="text-xs text-muted-foreground">
                {result.rewriteAi?.status === "ready"
                  ? "ИИ предложил редакцию абзаца. Формулировки сверены с утверждёнными карточками."
                  : result.rewriteAi?.status === "unchanged"
                    ? "После сверки с ИИ показана формулировка из утверждённой карточки."
                    : result.rewriteAi && result.rewriteAi.status !== "local"
                      ? "Правка с ИИ недоступна. Показан вариант по утверждённым карточкам."
                      : rewrite?.preservedText
                        ? "Точечная правка по карточкам. Сохранены структура и авторские формулировки; генерация ИИ не выполнялась."
                        : "Вариант составлен по утверждённым карточкам."}
              </p>
            </div>
            {rewrite ? (
              <div className="flex flex-wrap items-center gap-2">
                {rewriteCheck ? (
                  <Badge
                    className={cn(
                      "h-auto max-w-full justify-start whitespace-normal",
                      rewriteCheck.isClean && rewriteCheck.summary.green > 0
                        ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-100"
                        : "bg-amber-100 text-amber-800 hover:bg-amber-100"
                    )}
                  >
                    {rewriteCheck.isClean && rewriteCheck.summary.green > 0 ? (
                      <ShieldCheck className="size-3" />
                    ) : (
                      <ShieldQuestion className="size-3" />
                    )}
                    <RewriteCheckSummary check={rewriteCheck} />
                  </Badge>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCopyRewrite}
                >
                  <Copy className="size-3.5" />
                  Скопировать текст
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleDownloadRewrite}
                >
                  <Download className="size-3.5" />
                  Скачать .md
                </Button>
              </div>
            ) : null}
          </div>

          {rewriteError ? (
            <Alert>
              <CircleAlert className="size-4" />
              <AlertTitle>Переписать не удалось</AlertTitle>
              <AlertDescription>{rewriteError}</AlertDescription>
            </Alert>
          ) : null}

          {rewrite ? (
            <article className="wrap-anywhere rounded-3xl border bg-card p-5 shadow-sm sm:p-6">
              {rewriteCheck && !rewriteCheck.isClean && (
                <Alert className="mb-5">
                  <ShieldQuestion />
                  <AlertTitle>Текст требует ручной сверки</AlertTitle>
                  <AlertDescription>
                    В предложенной редакции остались непроверенные или
                    противоречивые факты. Прямые цитаты сохранены как в
                    оригинале; уточните их у автора перед публикацией.
                  </AlertDescription>
                </Alert>
              )}
              {rewrite.preservedText ? (
                <div className="max-w-prose whitespace-pre-wrap text-sm leading-7">
                  {rewrite.preservedText}
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <Badge variant="outline" className="text-[11px]">
                      H1 · {rewrite.title.length} символов
                    </Badge>
                    <h1 className="font-heading text-2xl font-bold leading-tight tracking-tight sm:text-3xl">
                      {rewrite.title}
                    </h1>
                  </div>

                  <div className="mt-4 rounded-2xl border bg-muted/30 p-4">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                        Первые 1000 знаков
                      </Badge>
                      <span className="text-[11px] text-muted-foreground">
                        {rewrite.lead.length} символов
                      </span>
                    </div>
                    <p className="text-sm leading-relaxed">{rewrite.lead}</p>
                  </div>

                  <div className="mt-5 space-y-5">
                    {rewrite.sections.map(
                      (section: CanonicalRewriteSection) => (
                        <section key={section.id} className="space-y-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="secondary" className="text-[11px]">
                              {section.level === 3 ? "H3" : "H2"}
                            </Badge>
                            <SectionHeading level={section.level}>
                              {section.heading}
                            </SectionHeading>
                          </div>
                          <div className="space-y-2">
                            {section.chunks.map((chunk) => (
                              <div
                                key={chunk.id}
                                className="rounded-xl bg-muted/20 p-3 text-sm leading-relaxed ring-1 ring-foreground/10"
                              >
                                {chunk.content}
                              </div>
                            ))}
                          </div>
                        </section>
                      )
                    )}
                  </div>
                </>
              )}

              {rewriteCheck?.findings && (
                <details className="mt-5 border-t pt-3 text-sm" open>
                  <summary className="cursor-pointer py-2 font-medium">
                    Результаты проверки новой редакции ·{" "}
                    {rewriteCheck.findings.length}
                  </summary>
                  <div className="mt-3 space-y-3">
                    {(showAllRewriteFindings
                      ? rewriteCheck.findings
                      : previewFindings(rewriteCheck.findings)
                    ).map((finding, index) => (
                      <FindingCard
                        key={finding.id}
                        finding={finding}
                        index={index}
                        busy={false}
                      />
                    ))}
                    {!showAllRewriteFindings &&
                      rewriteCheck.findings.length > 6 && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setShowAllRewriteFindings(true)}
                        >
                          Показать остальные результаты новой редакции ·{" "}
                          {rewriteCheck.findings.length - 6}
                        </Button>
                      )}
                    {rewriteCheck.findings.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        Распознанных фактов для сверки нет. Это не подтверждает
                        весь текст.
                      </p>
                    )}
                  </div>
                </details>
              )}

              {rewrite.changes && rewrite.changes.length > 0 && (
                <details className="mt-5 border-t pt-3 text-sm">
                  <summary className="cursor-pointer py-2 font-medium">
                    Что изменилось · {rewrite.changes.length}
                  </summary>
                  <ul className="mt-3 flex flex-col gap-4">
                    {rewrite.changes.map((change, index) => (
                      <li key={index} className="flex flex-col gap-1">
                        <p className="text-xs text-muted-foreground">Было</p>
                        <p>{change.before}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Стало
                        </p>
                        <p>{change.after}</p>
                        <AppLink
                          href={`/knowledge?card=${encodeURIComponent(change.sourceCardId)}&version=${encodeURIComponent(rewrite.sourceVersions?.[change.sourceCardId] ?? "approved")}`}
                          className="text-xs text-primary underline underline-offset-4"
                        >
                          Источник изменения
                        </AppLink>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {retainedFindings.length > 0 && (
                <details className="mt-5 border-t pt-3 text-sm">
                  <summary className="cursor-pointer py-2 font-medium">
                    Остались в тексте для ручной сверки ·{" "}
                    {retainedFindings.length}
                  </summary>
                  <ul className="mt-3 flex flex-col gap-3">
                    {retainedFindings.map((finding) => (
                      <li key={finding.id} className="flex flex-col gap-1">
                        <p className="font-medium">{finding.title}</p>
                        <q>{finding.quote}</q>
                        <p className="text-xs text-muted-foreground">
                          {finding.explanation}
                        </p>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="mt-5 rounded-2xl border bg-muted/20 p-4">
                <div className="flex items-center gap-2">
                  <BookOpenCheck className="size-4 text-primary" />
                  <p className="text-sm font-semibold">Карточки-источники</p>
                </div>
                <ul className="mt-2 flex flex-col gap-2">
                  {rewrite.sourceCardIds.map((cardId, index) => {
                    const citation =
                      result.rewriteAi?.status === "ready"
                        ? result.rewriteAi.citations.find(
                            (item) => item.cardId === cardId
                          )
                        : undefined;
                    return (
                      <li
                        key={cardId}
                        className="flex items-center gap-2 text-xs"
                      >
                        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                        <AppLink
                          href={
                            citation?.href ??
                            `/knowledge?card=${encodeURIComponent(cardId)}&version=${encodeURIComponent(rewrite.sourceVersions?.[cardId] ?? "approved")}`
                          }
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {rewrite.sourceCardTitles[index] ?? cardId}
                        </AppLink>
                      </li>
                    );
                  })}
                </ul>
              </div>
              {omittedFindings.length > 0 && (
                <div className="mt-5 rounded-2xl border bg-muted/20 p-4">
                  <h3 className="text-sm font-semibold">
                    Что требует сверки в исходном тексте
                  </h3>
                  <ul className="mt-2 space-y-2 text-xs">
                    {omittedFindings.map((finding) => (
                      <li key={finding.id}>
                        <span className="font-medium">
                          {finding.level === "red"
                            ? "Требует исправления"
                            : "Требует подтверждения"}
                        </span>{" "}
                        «{finding.quote}»
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          ) : null}
        </section>
      ) : null}

      {result ? (
        <FindingsContainer
          key={rewriteRevision ?? "check"}
          className={cn(
            "atlas-stagger-in",
            rewrite && "rounded-2xl border bg-card"
          )}
        >
          {rewrite ? (
            <summary className="cursor-pointer list-inside rounded-2xl p-4 text-muted-foreground sm:px-5">
              <h2 className="inline font-heading text-xl font-semibold text-foreground">
                Разбор исходного текста по уровням
              </h2>
            </summary>
          ) : null}
          <div
            className={cn("space-y-4", rewrite && "px-4 pb-4 sm:px-5 sm:pb-5")}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                {!rewrite ? (
                  <h2 className="font-heading text-xl font-semibold">
                    Разбор по уровням
                  </h2>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Каждое замечание содержит источник и конкретное предложение по
                  исправлению.
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {filters.map((item) => {
                  const count =
                    item.value === "all"
                      ? result.summary.total
                      : result.summary[item.value];
                  return (
                    <Button
                      key={item.value}
                      type="button"
                      size="sm"
                      variant={filter === item.value ? "default" : "outline"}
                      aria-pressed={filter === item.value}
                      onClick={() => {
                        setFilter(item.value);
                        setShowAllFindings(false);
                      }}
                      className="text-xs"
                    >
                      {item.label}
                      <Badge variant="secondary" className="ml-1 h-4 px-1.5">
                        {count}
                      </Badge>
                    </Button>
                  );
                })}
              </div>
            </div>

            <CheckpointChips summaries={result.checkpoints} />

            {visibleFindings.length > 0 ? (
              <div className="space-y-3">
                {displayedFindings.map((finding, index) => (
                  <FindingCard
                    key={finding.id}
                    finding={finding}
                    index={index}
                    busy={isChecking || isRewriting}
                    onReplace={(target, replacement) => {
                      const quote = target.quote;
                      if (!quote || !replacement.trim()) return;
                      const next = replaceCheckedFragment(
                        text,
                        quote,
                        replacement,
                        target.quoteStart,
                        target.quoteEnd
                      );
                      if (next === null) {
                        toast.error(
                          "Фрагмент неоднозначен или изменён. Исправьте его в черновике и повторите проверку."
                        );
                        return;
                      }
                      setText(next);
                      setFileName(null);
                      resetOutput();
                      void requestFactCheck("check", next);
                    }}
                  />
                ))}
                {!showAllFindings &&
                  visibleFindings.length > displayedFindings.length && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowAllFindings(true)}
                    >
                      Показать остальные результаты ·{" "}
                      {visibleFindings.length - displayedFindings.length}
                    </Button>
                  )}
              </div>
            ) : (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Sparkles className="size-4" />
                  </EmptyMedia>
                  <EmptyTitle>В этом уровне замечаний нет</EmptyTitle>
                  <EmptyDescription>
                    Переключите фильтр, чтобы увидеть остальные уровни разбора.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </FindingsContainer>
      ) : null}
    </div>
  );
}
