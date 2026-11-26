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
import { ArrowUpRight, Globe2, MessageCircle, Send, ShieldAlert } from "lucide-react";

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
import { AiActivity } from "@/components/ui/ai-activity";
import type { CanonChatAnswer } from "@/lib/canon-ai";

import { parseAssistantAnswer } from "./assistant-answer";
import styles from "./assistant-widget.module.css";

type Turn = {
  id: string;
  message: string;
  answer?: CanonChatAnswer;
  issue?: string;
  mode: "canon" | "web";
};

const MAX_MESSAGE_LENGTH = 2000;
const MAX_TURNS = 12;
const WEB_CONSENT_KEY = "canon:assistant-web-consent:v1";
const exampleSets = [
  [
    "Чем отличаются первая и вторая очереди гостиниц кампуса?",
    "Где находится робот KUKA?",
    "Какие вузы участвуют в совместных проектах?",
  ],
  [
    "Сколько мест в первой очереди гостиниц кампуса?",
    "Сколько мест во второй очереди гостиниц кампуса?",
    "Где размещены лаборатории?",
  ],
  [
    "Что известно о виртуальном тренажёре «Травмпункт»?",
    "Какие проекты связаны с экологией?",
    "Как проверить текст по справочнику?",
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
  const [webSearch, setWebSearch] = useState(false);
  const [webConsent, setWebConsent] = useState(false);
  const [warningOpen, setWarningOpen] = useState(false);
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
    try { setWebConsent(localStorage.getItem(WEB_CONSENT_KEY) === "accepted"); }
    catch { /* The warning remains available when preferences cannot be stored. */ }
  }, []);
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

  function changeSearchMode(enabled: boolean) {
    if (!enabled) { setWebSearch(false); return; }
    if (demo || !staff || sending) return;
    if (webConsent) setWebSearch(true);
    else setWarningOpen(true);
  }

  function acceptWebSearch() {
    setWebConsent(true);
    setWebSearch(true);
    try { localStorage.setItem(WEB_CONSENT_KEY, "accepted"); } catch { /* Session acknowledgment is sufficient. */ }
    setWarningOpen(false);
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
    const mode = retryIndex >= 0 ? turns[retryIndex].mode : webSearch ? "web" : "canon";
    const history = (retryIndex >= 0 ? turns.slice(0, retryIndex) : turns)
      .filter((turn) => turn.answer && turn.mode === "canon")
      .map((turn) => turn.message)
      .slice(-4);
    const turn: Turn = { id, message: normalized, mode };
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
        body: JSON.stringify({ message: normalized, history: mode === "web" ? [] : history, ...(mode === "web" && { mode }) }),
        signal: controller.signal,
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error.slice(0, 280) : "Ответ не получен. Повторите запрос.");
      const answer = parseAssistantAnswer(payload);
      if (
        controller.signal.aborted ||
        active.current?.controller !== controller
      )
        return;
      if (!answer || (mode === "web" && answer.mode !== "web")) throw new Error("Не удалось прочитать ответ. Повторите запрос.");
      setTurns((previous) =>
        previous.map((item) => (item.id === id ? { ...item, answer } : item))
      );
    } catch (error) {
      if (
        controller.signal.aborted ||
        active.current?.controller !== controller
      )
        return;
      setTurns((previous) =>
        previous.map((item) =>
          item.id === id
            ? { ...item, issue: error instanceof Error ? error.message : "Ответ не получен. Повторите запрос." }
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
        <div className={styles.searchMode}>
          <label className={styles.modeControl}>
            <Globe2 size={16} aria-hidden="true" />
            <span>Поиск в интернете</span>
            <Button type="button" variant="ghost" role="switch" aria-checked={webSearch} className={styles.switch} onClick={() => changeSearchMode(!webSearch)} disabled={!staff || demo || sending} aria-label="Поиск в интернете">
              <span className={styles.switchTrack} aria-hidden="true"><span /></span>
            </Button>
          </label>
          <p>{demo ? "В учебном демо поиск работает по карточкам." : !staff ? "Войдите, чтобы искать в интернете с ИИ." : webSearch ? "Внешние сведения · перепроверьте по базе Канона" : "Ответы по утверждённым карточкам Канона"}</p>
        </div>
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
            {(webSearch ? ["Что нового в строительстве кампуса «Южный Урал»?", "Какие исследования представили вузы кампуса в этом году?"] : exampleSets[exampleSet]).map((question) => (
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
            <article key={turn.id} className={`${styles.turn} space-y-2 break-words`}>
              <p className="ml-6 rounded-lg bg-muted px-3 py-2 font-medium whitespace-pre-wrap">
                {turn.message}
              </p>
              <div className="space-y-2" aria-live="polite">
                {!turn.answer && !turn.issue && (
                  <AiActivity label={turn.mode === "web" ? "Ищу в интернете" : "Сверяю утверждённые карточки"} detail={turn.mode === "web" ? "Собираю ответ и ссылки на внешние источники" : "Подбираю факты и версии источников"} />
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
              className={styles.send}
              data-sending={sending || undefined}
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
        <Dialog open={warningOpen} onOpenChange={setWarningOpen}>
          <DialogContent className={styles.warningPanel} finalFocus={composer}>
            <DialogHeader>
              <DialogTitle>Поиск за пределами Канона</DialogTitle>
              <DialogDescription>
                Вопрос будет отправлен в Яндекс Поиск. Ответ ИИ может содержать ошибки, а сведения в интернете — устареть. Перед использованием перепроверьте факты по утверждённым карточкам и ссылкам на источники.
              </DialogDescription>
            </DialogHeader>
            <div className={styles.warningActions}>
              <Button type="button" variant="outline" onClick={() => setWarningOpen(false)}>Остаться в базе</Button>
              <Button type="button" onClick={acceptWebSearch}>Понятно, включить</Button>
            </div>
          </DialogContent>
        </Dialog>
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
  if (answer.mode === "web") {
    return (
      <div className={styles.webAnswer}>
        <p className={styles.webLabel}><ShieldAlert size={15} aria-hidden="true" /> Сведения из интернета</p>
        <p className="whitespace-pre-wrap">{answer.message}</p>
        {!!answer.externalSources?.length && <ol className={styles.externalSources} aria-label="Источники из интернета">
          {answer.externalSources.map(source => <li key={`${source.id}:${source.url}`}>
            <a href={source.url} target="_blank" rel="noopener noreferrer" className={styles.externalLink}>
              <span>{source.title}<small>{new URL(source.url).hostname}</small></span><ArrowUpRight size={16} aria-hidden="true" />
            </a>
          </li>)}
        </ol>}
        <Link href="/knowledge" prefetch={false} onNavigate={onNavigate} className="text-xs text-primary underline underline-offset-2">Перепроверить по базе Канона</Link>
      </div>
    );
  }
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
