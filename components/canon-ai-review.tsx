"use client";

import { useWorkspaceMode } from "@/components/demo/workspace-transport";

import { useId } from "react";
import { AppLink as Link } from "@/components/navigation/workspace-navigation";

import { safeAssistantHref } from "@/components/assistant/assistant-answer";
import type { CanonAnalyticsAiReview } from "@/lib/canon-analytics-ai";
import type { AiFactReview, CanonChatAnswer } from "@/lib/canon-ai";
import type { CanonCitation } from "@/lib/canon-context";

export type FactAiReview = AiFactReview & { reason?: "sources-changed" };

const unavailable = {
  unavailable:
    "ИИ сейчас недоступен. Показан результат проверки по правилам и данным Канона.",
  busy: "ИИ занят. Показан основной результат, повторите запрос позже.",
  failed: "Ответ ИИ не прошёл проверку. Показан основной результат.",
  "too-long": "Запрос слишком объёмный для ИИ. Показан основной результат.",
  local: "Выполнен обычный запрос к данным Канона.",
};

export function CanonAiOption({
  kind,
  checked,
  disabled,
  onChange,
}: {
  kind: "fact" | "analytics";
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const demo = useWorkspaceMode() === "demo";
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="flex min-h-10 items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={id}
          onChange={(event) => onChange(event.target.checked)}
          className="size-4 shrink-0 accent-[var(--primary)]"
        />
        {kind === "fact" ? "Проверить текст с ИИ" : "Сверить отчёт с ИИ"}
      </label>
      <p id={id} className="text-xs leading-relaxed text-muted-foreground">
        {demo
          ? "Учебная проверка выполняется в браузере. Текст и карточки не отправляются на сервер или во внешнюю нейросеть."
          : kind === "fact"
            ? "ИИ сверяет текст с утверждёнными карточками. Текст проверки и данные источников передаются в Yandex AI Studio. Используйте публичный текст."
            : "ИИ сверяет отчёт с утверждёнными карточками. Текст запроса и данные источников передаются в Yandex AI Studio. Используйте публичные сведения."}
      </p>
    </div>
  );
}

export function CanonAiReview({
  review,
}: {
  review: FactAiReview | CanonChatAnswer | CanonAnalyticsAiReview;
}) {
  const demo = useWorkspaceMode() === "demo";
  const analytics = "originalQuery" in review ? review : null;
  const citations =
    review.status === "ready" && "claims" in review
      ? review.claims.flatMap((claim) => claim.evidence)
      : "citations" in review
        ? review.citations
        : [];
  const unique = new Map<string, CanonCitation>();
  for (const citation of citations) {
    unique.set(
      JSON.stringify([citation.cardId, citation.versionId, citation.quote]),
      citation
    );
  }
  const message = demo
    ? "Учебная проверка в браузере. Внешняя нейросеть не вызывалась."
    : "reason" in review && review.reason === "sources-changed"
      ? "message" in review
        ? review.message
        : "Карточки обновились во время проверки. Показан актуальный основной результат. Повторите запрос для сверки с ИИ."
      : analytics?.clarification
        ? analytics.message
        : review.status === "ready"
          ? "message" in review
            ? review.message
            : review.mode === "semantic" && review.totalSpans !== undefined
              ? "ИИ разобрал весь текст. Фрагментов: " + review.totalSpans + "."
              : review.mode === "mixed" && review.totalSpans !== undefined
                ? "Полностью разобрано фрагментов: " + (review.reviewedSpans ?? 0) + " из " + review.totalSpans + "."
                : "ИИ разобрал фрагменты по карточкам. Фрагментов: " + review.claims.length + "."
          : unavailable[review.status];
  const details =
    review.status !== "ready" &&
    review.status !== "local" &&
    "message" in review &&
    review.message !== message
      ? review.message
      : null;

  return (
    <section
      aria-label="Сверка с ИИ"
      className="min-w-0 space-y-2 rounded-xl border bg-card p-3 text-sm [overflow-wrap:anywhere]"
    >
      <p role="status" className="text-muted-foreground">
        {message}
      </p>
      {details && <p>{details}</p>}
      {review.status === "ready" && "verification" in review &&
        review.mode === "mixed" && review.verification && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Размечено фрагментов: {review.classifiedSpans ?? 0} из {review.totalSpans}.
            Сверено утверждений: {review.verification.completed} из {review.verification.total}.
          </p>
        )}
      {review.status === "ready" && "batches" in review && review.mode === "mixed" &&
        review.batches && (review.batches.failed > 0 || review.batches.deadlineReached) && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {review.batches.deadlineReached
              ? "Достигнут предел времени смысловой проверки."
              : "Ответ модели по части текста не прошёл проверку."}{" "}
            Для оставшихся фрагментов показан результат проверки по правилам.
          </p>
        )}
      {review.status === "ready" &&
        "rejectedClaims" in review &&
        Number(review.rejectedClaims) > 0 && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Часть ответа модели отклонена: {Number(review.rejectedClaims)}. Для
            этих фрагментов сохранён результат проверки по правилам.
          </p>
        )}
      {review.status === "ready" && "ignoredAnnotations" in review &&
        Number(review.ignoredAnnotations) > 0 && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Лишние метки модели отброшены: {Number(review.ignoredAnnotations)}.
          </p>
        )}
      {analytics?.clarification && <p>{analytics.clarification}</p>}
      {analytics?.appliedQuery && (
        <dl className="space-y-2">
          <div>
            <dt className="font-medium">Исходный запрос</dt>
            <dd>{analytics.originalQuery}</dd>
          </div>
          <div>
            <dt className="font-medium">Запрос для расчёта</dt>
            <dd>{analytics.appliedQuery}</dd>
          </div>
        </dl>
      )}
      {unique.size > 0 && (
        <details>
          <summary className="cursor-pointer font-medium">
            Цитаты и версии источников · {unique.size}
          </summary>
          <ul className="mt-2 space-y-2">
            {Array.from(unique).map(([key, citation]) => {
              const href = safeAssistantHref(citation.href);
              return (
                <li key={key} className="rounded-md border p-2">
                  <p>«{citation.quote}»</p>
                  {href && (
                    <Link
                      href={href}
                      prefetch={false}
                      className="text-primary underline underline-offset-2"
                    >
                      {citation.title} · версия источника
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </section>
  );
}
