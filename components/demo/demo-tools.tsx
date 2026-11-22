"use client";

import { useState } from "react";
import { MessageCircle, Send } from "lucide-react";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { buildAnalyticsReport, type AnalyticsReport } from "@/lib/analytics";
import { getDemoError } from "@/lib/browser-demo";
import { buildCanonSources } from "@/lib/canon-context";
import {
  buildCanonicalRewrite,
  checkFactText,
  FACT_CHECK_EXAMPLE_TEXT,
  type FactCheckResult,
  levelLabels,
} from "@/lib/fact-check";
import type { KnowledgeCard } from "@/lib/knowledge";
import {
  getSearchFragment,
  searchKnowledgeCards,
} from "@/lib/knowledge-search";
import { analyticsQuerySchema } from "@/lib/validation/analytics";
import { factCheckInputSchema } from "@/lib/validation/fact-check";
import type { DemoSection } from "./browser-demo";

type ToolsProps = {
  cards: KnowledgeCard[];
  openCard: (id: string) => void;
};

function SourceButton({
  cardId,
  title,
  openCard,
}: {
  cardId: string;
  title: string;
  openCard: ToolsProps["openCard"];
}) {
  return (
    <Button
      type="button"
      variant="link"
      className="h-auto max-w-full p-0 text-left whitespace-normal break-words"
      onClick={() => openCard(cardId)}
    >
      {title}
    </Button>
  );
}

export function DemoFactCheck({ cards, openCard }: ToolsProps) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<FactCheckResult | null>(null);
  const [error, setError] = useState("");

  function evaluate(mode: "check" | "rewrite") {
    const validated = factCheckInputSchema.safeParse({ text, mode });
    if (!validated.success) {
      setError(validated.error.issues[0]?.message ?? "Проверьте текст.");
      return;
    }
    setError("");
    if (mode === "rewrite") {
      const rewrite = buildCanonicalRewrite(validated.data.text, cards);
      if (!rewrite) {
        setError(
          "Подтверждённых сведений для переписывания в учебных карточках нет."
        );
        return;
      }
      setText(rewrite.plainText);
      setResult(checkFactText(rewrite.plainText, cards));
    } else {
      setResult(checkFactText(validated.data.text, cards));
    }
  }

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-2xl">Проверка текста</CardTitle>
        <CardDescription>
          Проверка и переписывание по утверждённым учебным карточкам. Внешняя
          нейросеть не используется.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            evaluate("check");
          }}
        >
          <label className="block space-y-1 text-sm">
            <span>Текст для проверки</span>
            <Textarea
              value={text}
              maxLength={60_000}
              rows={7}
              onChange={(event) => {
                setText(event.target.value);
                setResult(null);
                setError("");
              }}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit">Проверить текст</Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => evaluate("rewrite")}
            >
              Переписать по карточкам
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setText(FACT_CHECK_EXAMPLE_TEXT);
                setResult(null);
                setError("");
              }}
            >
              Подставить пример
            </Button>
          </div>
        </form>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {result && (
          <section
            className="min-w-0 space-y-3 border-t pt-3"
            aria-label="Результат учебной проверки"
          >
            <p role="status" className="text-sm">
              Подтверждено · {result.summary.green}. Требуют проверки ·{" "}
              {result.summary.yellow}. Ошибки · {result.summary.red}.
            </p>
            {result.findings.length === 0 && (
              <p className="text-sm">
                Для этого текста подтверждений в учебных карточках не найдено.
              </p>
            )}
            <ul className="space-y-2">
              {result.findings.map((finding) => (
                <li
                  key={finding.id}
                  className="space-y-1 rounded-lg border p-3 text-sm break-words"
                >
                  <Badge
                    variant={
                      finding.level === "red" ? "destructive" : "outline"
                    }
                  >
                    {levelLabels[finding.level]}
                  </Badge>
                  <p className="font-medium">{finding.title}</p>
                  <p>{finding.explanation}</p>
                  {finding.sourceCardId && (
                    <SourceButton
                      cardId={finding.sourceCardId}
                      title={
                        finding.sourceCardTitle ?? "Открыть учебную карточку"
                      }
                      openCard={openCard}
                    />
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  );
}

export function DemoAnalytics({ cards, openCard }: ToolsProps) {
  const [query, setQuery] = useState("");
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [error, setError] = useState("");
  const examples = ["Лаборатории", "Совместные проекты"].filter((example) => {
    const sample = buildAnalyticsReport(example, cards, []);
    return (
      sample.summary.total > 0 &&
      sample.interpretation?.status !== "needs-clarification"
    );
  });

  function run(input: string) {
    const validated = analyticsQuerySchema.safeParse({ query: input });
    if (!validated.success) {
      setError(validated.error.issues[0]?.message ?? "Уточните запрос.");
      return;
    }
    setError("");
    setReport(buildAnalyticsReport(validated.data.query, cards, []));
  }

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-2xl">Аналитика</CardTitle>
        <CardDescription>
          Подборки и итоги рассчитываются по утверждённым учебным карточкам в
          этом браузере.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            run(query);
          }}
        >
          <label className="block space-y-1 text-sm">
            <span>Запрос к учебной базе</span>
            <Input
              value={query}
              maxLength={500}
              onChange={(event) => {
                setQuery(event.target.value);
                setReport(null);
                setError("");
              }}
            />
          </label>
          <Button type="submit">Построить подборку</Button>
        </form>
        {examples.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {examples.map((example) => (
              <Button
                key={example}
                variant="outline"
                type="button"
                onClick={() => {
                  setQuery(example);
                  run(example);
                }}
              >
                {example}
              </Button>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {report && (
          <section
            className="space-y-3 border-t pt-3"
            aria-label="Результат учебной аналитики"
          >
            <p role="status" className="text-sm">
              {report.interpretation?.status === "needs-clarification"
                ? report.interpretation.message
                : `Карточек · ${report.summary.total}. Проектов · ${report.summary.projects}. Лабораторий · ${report.summary.laboratories}.`}
            </p>
            {report.notice &&
              report.notice !== report.interpretation?.message && (
                <p className="text-sm">{report.notice}</p>
              )}
            <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
              {report.cards.map((item) => (
                <li
                  key={item.id}
                  className="min-w-0 space-y-1 rounded-lg border p-3 text-sm break-words"
                >
                  <SourceButton
                    cardId={item.id}
                    title={item.title}
                    openCard={openCard}
                  />
                  <p>
                    {[
                      item.cardTypeLabel,
                      item.universities.join(", "),
                      item.status,
                      item.contour,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {item.figures.length > 0 && (
                    <p className="text-muted-foreground">
                      {item.figures.join("; ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  );
}

const chatQuestionSchema = z.string().trim().min(2, "Введите вопрос.").max(500);

const demoGuides = [
  {
    pattern: /согласова|утверди|права|роль/u,
    section: "cards",
    label: "К карточкам",
    text: "Для совместного проекта переключитесь на владельцев обоих вузов и подтвердите участие. Затем смените роль на координатора и утвердите карточку.",
  },
  {
    pattern: /редактор|подготовить (?:статью|материал)|черновик/u,
    section: "editor",
    label: "В редактор",
    text: "Выберите карточку-источник, соберите черновик и сохраните его в браузере. Учебный координатор может согласовать сохранённый материал.",
  },
  {
    pattern: /как.+проверить|фактчек/u,
    section: "check",
    label: "К проверке",
    text: "Вставьте текст в проверку. Она выделит подтверждённые сведения, ошибки и тезисы, для которых в учебной базе нет опоры.",
  },
  {
    pattern: /как.+(?:аналитик|подборк|сводк)/u,
    section: "analytics",
    label: "К аналитике",
    text: "Укажите тип карточки и нужные ограничения, например вуз и оборудование. Подборка и итоги считаются по учебным карточкам.",
  },
] as const;

export function DemoChat({
  cards,
  openCard,
  navigate,
}: ToolsProps & { navigate: (section: DemoSection) => void }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{
    question: string;
    matches: KnowledgeCard[];
    guide?: (typeof demoGuides)[number];
  } | null>(null);
  const [error, setError] = useState("");

  function send() {
    try {
      const validated = chatQuestionSchema.safeParse(question);
      if (!validated.success)
        throw new Error(validated.error.issues[0]?.message);
      const value = validated.data;
      const guide = demoGuides.find((item) =>
        item.pattern.test(value.toLocaleLowerCase("ru"))
      );
      const search = value.replace(
        /^(?:что (?:известно|есть) (?:про|о|об)|расскажи(?:те)? (?:про|о|об)|найди(?:те)?|покажи(?:те)?(?: карточку)?|где есть)\s+/iu,
        ""
      );
      setAnswer({
        question: value,
        matches: guide ? [] : searchKnowledgeCards(cards, search).slice(0, 4),
        guide,
      });
      setError("");
    } catch (cause) {
      setError(getDemoError(cause));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            type="button"
            size="icon"
            className="fixed bottom-4 right-4 z-40 size-12 rounded-full shadow-lg sm:bottom-6 sm:right-6"
            aria-label="Открыть демо-помощник"
          />
        }
      >
        <MessageCircle aria-hidden="true" />
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader className="pr-8">
          <DialogTitle>Демо-помощник</DialogTitle>
          <DialogDescription>
            Локальный поиск и подсказки по учебным сценариям. Внешняя нейросеть
            не используется.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <label className="min-w-0 flex-1">
            <span className="sr-only">Вопрос демо-помощнику</span>
            <Input
              value={question}
              maxLength={500}
              placeholder="Название карточки или вопрос"
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          <Button type="submit" size="icon" aria-label="Отправить вопрос">
            <Send aria-hidden="true" />
          </Button>
        </form>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {answer && (
          <div aria-live="polite" className="space-y-2 break-words">
            <p className="font-medium">{answer.question}</p>
            {answer.guide && (
              <>
                <p>{answer.guide.text}</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (answer.guide) navigate(answer.guide.section);
                    setOpen(false);
                  }}
                >
                  {answer.guide.label}
                </Button>
              </>
            )}
            {!answer.guide && !answer.matches.length && (
              <p>В утверждённых учебных карточках совпадений нет.</p>
            )}
            {buildCanonSources(answer.matches, {}).map((source) => {
              const card = answer.matches.find(
                (item) => item.id === source.cardId
              );
              const text =
                card &&
                (getSearchFragment(card, answer.question) ||
                  card.referenceDescription);
              return (
                <div
                  key={source.id}
                  className="space-y-1 rounded-md border p-2"
                >
                  {text && <p>{text}</p>}
                  <SourceButton
                    cardId={source.cardId}
                    title={source.title}
                    openCard={(id) => {
                      openCard(id);
                      setOpen(false);
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
