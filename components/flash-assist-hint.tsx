"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { FlashAnalyticsAssist, FlashFactAssist } from "@/lib/flash-assist";

type Props =
  | { kind: "fact"; text: string }
  | { kind: "analytics"; query: string; onApply: (query: string) => void };

type State =
  | { status: "idle" | "loading" | "access" }
  | FlashFactAssist
  | FlashAnalyticsAssist;

export function isCurrentFlashRequest(request: AbortController, current: AbortController | null) {
  return current === request && !request.signal.aborted;
}

export function FlashAssistOption({ kind, checked, disabled, onChange }: {
  kind: "analytics" | "fact";
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label className="flex min-h-10 items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={id}
          onChange={(event) => onChange(event.target.checked)}
          className="size-4 shrink-0 accent-[var(--primary)]"
        />
        {kind === "analytics" ? "Помочь уточнить запрос с Flash" : "Найти фрагменты для сверки с Flash"}
      </label>
      <p id={id} className="text-xs leading-relaxed text-muted-foreground">
        {kind === "analytics"
          ? "При сборе аналитики текст запроса отправится в Yandex AI Studio. Используйте публичные сведения."
          : "При проверке в Yandex AI Studio отправятся предложения из текста до 6 000 знаков. Используйте публичный текст."}
      </p>
    </div>
  );
}

function statusMessage(state: State) {
  switch (state.status) {
    case "idle":
      return "";
    case "loading":
      return "Получаем подсказки Flash…";
    case "access":
      return "Для подсказок Flash нужен доступ сотрудника.";
    case "busy":
      return "Flash занят. Основной результат готов, подсказку можно запросить чуть позже.";
    case "too-long":
      return "Текст слишком длинный для Flash. Для подсказок используйте более короткий публичный фрагмент.";
    case "unavailable":
      return "Основной результат готов. Flash сейчас недоступен.";
    case "failed":
      return "Основной результат готов. Подсказка Flash недоступна.";
    case "ready":
      if ("fragments" in state) {
        return state.fragments.length > 0
          ? "Flash предложил фрагменты для ручной сверки."
          : "Flash не предложил фрагменты для ручной сверки.";
      }
      return state.suggestion
        ? "Flash предложил уточнение запроса."
        : "Flash не предложил уточнение запроса.";
  }
}

export function FlashAssistResult({ state, onApply }: { state: State; onApply?: (query: string) => void }) {
  const fragments = state.status === "ready" && "fragments" in state ? state.fragments : [];
  const suggestion = state.status === "ready" && "suggestion" in state ? state.suggestion : null;
  return (
    <div className="flex w-full min-w-0 flex-col items-start gap-2">
      <p role="status" className="text-xs leading-relaxed text-muted-foreground">{statusMessage(state)}</p>
      {fragments.length > 0 && (
        <ul className="flex w-full list-disc flex-col gap-1 pl-5 text-sm [overflow-wrap:anywhere]">
          {fragments.map((fragment) => <li key={fragment}>«{fragment}»</li>)}
        </ul>
      )}
      {suggestion && onApply && (
        <>
          <p className="text-sm [overflow-wrap:anywhere]">«{suggestion.query}»</p>
          <ul className="flex max-w-full flex-wrap gap-2" aria-label="Предложенные критерии">
            {suggestion.filters.map((filter) => (
              <li key={`${filter.key}-${filter.value}`} className="min-w-0 max-w-full">
                <Badge variant="secondary" className="h-auto max-w-full whitespace-normal [overflow-wrap:anywhere]">
                  {filter.label}: {filter.value}
                </Badge>
              </li>
            ))}
          </ul>
          <Button type="button" size="sm" variant="secondary" className="min-h-11 sm:min-h-9"
            onClick={() => onApply(suggestion.query)}>
            Применить уточнение
          </Button>
        </>
      )}
    </div>
  );
}

export function FlashAssistHint(props: Props) {
  const id = useId();
  const [state, setState] = useState<State>({ status: "idle" });
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function requestAssist() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setState({ status: "loading" });

    const fact = props.kind === "fact";
    const body = fact
      ? { text: props.text, mode: "check", flashAssist: true }
      : { query: props.query, flashAssist: true };

    try {
      const response = await fetch(
        fact ? "/api/fact-check" : "/api/analytics",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify(body),
        }
      );
      const data = response.ok
        ? ((await response.json()) as {
            flashAssist?: FlashFactAssist | FlashAnalyticsAssist;
          })
        : null;
      if (!isCurrentFlashRequest(controller, pending.current)) return;
      if (response.status === 401 || response.status === 403) {
        setState({ status: "access" });
      } else if (!response.ok) {
        setState({ status: "failed" });
      } else {
        setState(data?.flashAssist ?? { status: "unavailable" });
      }
    } catch {
      if (isCurrentFlashRequest(controller, pending.current)) setState({ status: "failed" });
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-col items-start gap-2.5 rounded-xl border bg-card p-3"
    >
      <h3 id={`${id}-title`} className="text-sm font-semibold">
        Подсказки Flash
      </h3>
      <p
        id={`${id}-description`}
        className="text-xs leading-relaxed text-muted-foreground"
      >
        {props.kind === "fact"
          ? "По кнопке фрагменты текста отправляются в Yandex AI Studio. Используйте только публичный текст."
          : "По кнопке текст запроса отправляется в Yandex AI Studio. Используйте только публичные сведения."}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="min-h-11 max-w-full whitespace-normal sm:min-h-9"
        aria-describedby={`${id}-description`}
        aria-disabled={state.status === "loading"}
        onClick={requestAssist}
      >
        Получить подсказки Flash
      </Button>
      {state.status !== "idle" && (
        <FlashAssistResult state={state} onApply={props.kind === "analytics" ? props.onApply : undefined} />
      )}
    </section>
  );
}
