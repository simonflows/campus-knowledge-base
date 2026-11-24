"use client";

import {
  useWorkspaceMode,
  useWorkspaceRequest,
} from "@/components/demo/workspace-transport";

import { useEffect, useId, useRef, useState } from "react";
import {
  AppLink as Link,
  useWorkspacePathname,
} from "@/components/navigation/workspace-navigation";
import { MessageCircle, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { CanonChatAnswer } from "@/lib/canon-ai";

import { parseAssistantAnswer } from "./assistant-answer";
import styles from "./assistant-widget.module.css";

type Turn = {
  id: string;
  message: string;
  answer?: CanonChatAnswer;
  issue?: string;
};

const MAX_MESSAGE_LENGTH = 2000;
const MAX_TURNS = 12;
const exampleSets = [
  [
    "Какова общая площадь кампуса?",
    "Какие вузы входят в кампус?",
    "Как проверить текст по справочнику?",
  ],
  [
    "Сколько мест для проживания в кампусе?",
    "Где открыть паспорт кампуса?",
    "Как найти карточку университета?",
  ],
  [
    "Какие лаборатории проектируют в учебно-научном корпусе?",
    "Какие этапы строительства указаны в паспорте?",
    "Где подготовить черновик публикации?",
  ],
];
const statusLabels = {
  ready: "",
  local: "Поиск по карточкам без нейросети.",
  unavailable: "Нейросеть сейчас недоступна. Показан поиск по карточкам.",
  busy: "Нейросеть занята. Показан поиск по карточкам.",
  failed: "Не удалось получить ответ нейросети. Показан поиск по карточкам.",
  "too-long":
    "Запрос слишком объёмный для нейросети. Показан поиск по карточкам.",
} satisfies Record<CanonChatAnswer["status"], string>;

export function AssistantWidget({ staff }: { staff: boolean }) {
  const pathname = useWorkspacePathname();
  if (pathname === "/demo" || pathname?.startsWith("/demo/")) return null;
  return <AssistantSession key={`${pathname}:${staff}`} staff={staff} />;
}

function AssistantSession({ staff }: { staff: boolean }) {
  const workspaceRequest = useWorkspaceRequest();
  const demo = useWorkspaceMode() === "demo";
  const exampleHeadingId = useId();
  const [open, setOpen] = useState(false);
  const [exampleSet, setExampleSet] = useState(exampleSets.length - 1);
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [validation, setValidation] = useState("");
  const [exampleHelp, setExampleHelp] = useState("");
  const selectedExample = useRef<string | null>(null);
  const active = useRef<{ id: string; controller: AbortController } | null>(
    null
  );
  const composer = useRef<HTMLTextAreaElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const sending = turns.some((turn) => !turn.answer && !turn.issue);

  useEffect(() => () => active.current?.controller.abort(), []);
  useEffect(() => {
    const view = transcript.current;
    if (view && turns.length) view.scrollTop = view.scrollHeight;
  }, [turns]);

  function changeOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen && !open) {
      setExampleSet((current) => (current + 1) % exampleSets.length);
      if (transcript.current) transcript.current.scrollTop = 0;
    }
    if (!nextOpen && active.current) {
      const { id, controller } = active.current;
      active.current = null;
      controller.abort();
      setTurns((previous) =>
        previous.map((turn) =>
          turn.id === id ? { ...turn, issue: "Запрос отменён." } : turn
        )
      );
    }
  }

  function chooseExample(question: string) {
    if (input.trim() && input !== selectedExample.current) {
      setExampleHelp(
        "Отправьте свой вопрос или очистите поле, чтобы выбрать пример."
      );
    } else {
      selectedExample.current = question;
      setInput(question);
      setValidation("");
      setExampleHelp("");
    }
    composer.current?.focus({ preventScroll: true });
  }

  async function ask(message: string, retryId?: string) {
    if (active.current) return;
    const normalized = message.trim();
    if (!normalized || normalized.length > MAX_MESSAGE_LENGTH) {
      setValidation(
        normalized ? "Сократите вопрос до 2000 знаков." : "Введите вопрос."
      );
      return;
    }
    setValidation("");
    setExampleHelp("");
    const id = retryId ?? crypto.randomUUID();
    const retryIndex = turns.findIndex((turn) => turn.id === retryId);
    const history = (retryIndex >= 0 ? turns.slice(0, retryIndex) : turns)
      .filter((turn) => turn.answer)
      .map((turn) => turn.message)
      .slice(-4);
    const turn = { id, message: normalized };
    const controller = new AbortController();
    active.current = { id, controller };
    setTurns((previous) =>
      retryId
        ? previous.map((item) => (item.id === retryId ? turn : item))
        : [...previous, turn].slice(-MAX_TURNS)
    );
    if (!retryId) setInput("");
    try {
      const response = await workspaceRequest("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: normalized, history }),
        signal: controller.signal,
        cache: "no-store",
      });
      const answer = parseAssistantAnswer(
        await response.json().catch(() => null)
      );
      if (
        controller.signal.aborted ||
        active.current?.controller !== controller
      )
        return;
      if (!answer) throw new Error("Assistant response is missing");
      setTurns((previous) =>
        previous.map((item) => (item.id === id ? { ...item, answer } : item))
      );
    } catch {
      if (
        controller.signal.aborted ||
        active.current?.controller !== controller
      )
        return;
      setTurns((previous) =>
        previous.map((item) =>
          item.id === id
            ? { ...item, issue: "Ответ не получен. Повторите запрос." }
            : item
        )
      );
    } finally {
      if (active.current?.controller === controller) active.current = null;
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        render={
          <Button
            ref={trigger}
            type="button"
            className={styles.launcher}
            aria-label="Открыть помощник Канона"
          />
        }
      >
        <MessageCircle data-icon="inline-start" aria-hidden="true" />
        <span className={styles.launcherLabel}>Помощник</span>
      </DialogTrigger>
      <DialogContent
        initialFocus={title}
        finalFocus={trigger}
        className={`${styles.panel} data-open:animate-none data-closed:animate-none`}
      >
        <DialogHeader className={styles.header}>
          <DialogTitle ref={title} tabIndex={-1}>
            Помощник Канона
          </DialogTitle>
          <DialogDescription>
            {demo
              ? "Учебный поиск по карточкам и разделам."
              : staff
                ? "Сведения из утверждённых карточек и разделов."
                : "Поиск по карточкам. Для ответов с ИИ войдите."}
          </DialogDescription>
        </DialogHeader>
        <div
          ref={transcript}
          tabIndex={turns.length ? 0 : undefined}
          aria-label="Переписка с помощником"
          className={styles.transcript}
        >
          <section
            aria-labelledby={exampleHeadingId}
            className={styles.examples}
          >
            <h3 id={exampleHeadingId}>Примеры вопросов</h3>
            {exampleSets[exampleSet].map((question) => (
              <Button
                key={question}
                type="button"
                variant="ghost"
                className={styles.example}
                onClick={() => chooseExample(question)}
              >
                {question}
              </Button>
            ))}
          </section>
          {turns.map((turn) => (
            <article key={turn.id} className="space-y-2 break-words">
              <p className="ml-6 rounded-lg bg-muted px-3 py-2 font-medium whitespace-pre-wrap">
                {turn.message}
              </p>
              <div className="space-y-2" aria-live="polite">
                {!turn.answer && !turn.issue && (
                  <p className="text-muted-foreground">Ищем сведения…</p>
                )}
                {turn.issue && (
                  <p className="text-muted-foreground">{turn.issue}</p>
                )}
                {turn.answer && (
                  <AssistantReply
                    answer={turn.answer}
                    onNavigate={() => changeOpen(false)}
                    staff={staff}
                  />
                )}
              </div>
              {(turn.issue ||
                turn.answer?.status === "busy" ||
                turn.answer?.status === "failed") && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={sending}
                  onClick={() => void ask(turn.message, turn.id)}
                >
                  Повторить запрос
                </Button>
              )}
            </article>
          ))}
        </div>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void ask(input);
          }}
        >
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1">
              <span className="sr-only">Вопрос помощнику Канона</span>
              <Textarea
                ref={composer}
                rows={2}
                maxLength={MAX_MESSAGE_LENGTH}
                className={styles.input}
                value={input}
                placeholder="Введите вопрос"
                onChange={(event) => {
                  selectedExample.current = null;
                  setInput(event.target.value);
                  setValidation("");
                  setExampleHelp("");
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    if (!sending) event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
            </label>
            <Button
              type="submit"
              size="icon"
              aria-label="Отправить вопрос"
              disabled={sending || !input.trim()}
            >
              <Send aria-hidden="true" />
            </Button>
          </div>
          {validation && (
            <p role="alert" className="mt-2 text-destructive">
              {validation}
            </p>
          )}
          {exampleHelp && (
            <p role="status" className="mt-2 text-sm text-muted-foreground">
              {exampleHelp}
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AssistantReply({
  answer,
  onNavigate,
  staff,
}: {
  answer: CanonChatAnswer;
  onNavigate: () => void;
  staff: boolean;
}) {
  const label =
    answer.status === "local" && !staff
      ? "Поиск без нейросети. Для ИИ войдите."
      : statusLabels[answer.status];
  const compact =
    answer.presentation === "summary" && answer.citations.length > 0;
  const quotes = answer.citations.map((citation, index) => (
    <blockquote
      key={`${citation.sourceId}:${citation.factId}:${index}`}
      className="rounded-md border bg-card px-3 py-2"
    >
      <p className="whitespace-pre-wrap">«{citation.quote}»</p>
      {!compact && (
        <Link
          href={citation.href}
          prefetch={false}
          onNavigate={onNavigate}
          className="mt-1 inline-block text-xs font-medium text-primary underline underline-offset-2"
        >
          {citation.title} · версия источника
        </Link>
      )}
    </blockquote>
  ));
  const sources = [
    ...new Map(
      answer.citations.map((citation) => [citation.href, citation])
    ).values(),
  ];
  return (
    <>
      {label && <p className="text-xs text-muted-foreground">{label}</p>}
      <p className="whitespace-pre-wrap">{answer.message}</p>
      {compact ? (
        <>
          <ul className="space-y-1 text-xs font-medium text-primary">
            {sources.map(({ href, title }) => (
              <li key={href}>
                <Link
                  href={href}
                  prefetch={false}
                  onNavigate={onNavigate}
                  className="underline underline-offset-2"
                >
                  {title} · версия источника
                </Link>
              </li>
            ))}
          </ul>
          <details className="text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer font-medium">
              Цитаты из карточек
            </summary>
            <div className="mt-2 space-y-2">{quotes}</div>
          </details>
        </>
      ) : (
        quotes
      )}
      {answer.actions.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {answer.actions.map((action) => (
            <li key={`${action.href}:${action.label}`}>
              <Link
                href={action.href}
                prefetch={false}
                onNavigate={onNavigate}
                className="block rounded-md border px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-muted"
              >
                {action.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
