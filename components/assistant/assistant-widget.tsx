"use client";

import { useWorkspaceRequest } from "@/components/demo/workspace-transport";

import { useEffect, useRef, useState } from "react";
import { AppLink as Link, useWorkspacePathname } from "@/components/navigation/workspace-navigation";
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

type Turn = {
  id: string;
  message: string;
  answer?: CanonChatAnswer;
  issue?: string;
};

const MAX_MESSAGE_LENGTH = 2000;
const MAX_TURNS = 12;
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
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [validation, setValidation] = useState("");
  const active = useRef<{ id: string; controller: AbortController } | null>(
    null
  );
  const composer = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const sending = turns.some((turn) => !turn.answer && !turn.issue);

  useEffect(() => () => active.current?.controller.abort(), []);
  useEffect(() => {
    const view = transcript.current;
    if (view && open) view.scrollTop = view.scrollHeight;
  }, [turns, open]);

  function changeOpen(nextOpen: boolean) {
    setOpen(nextOpen);
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
            size="icon"
            type="button"
            className="fixed right-4 bottom-4 z-40 size-12 rounded-full border border-primary-foreground/20 shadow-lg sm:right-6 sm:bottom-6"
            aria-label="Открыть помощник Канона"
          />
        }
      >
        <MessageCircle aria-hidden="true" />
      </DialogTrigger>
      <DialogContent
        initialFocus={composer}
        finalFocus={trigger}
        className="top-auto right-4 bottom-20 left-auto flex max-h-[calc(100dvh-6rem)] w-[380px] max-w-[calc(100%-2rem)] translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden p-0 shadow-xl sm:right-6 sm:bottom-24 sm:max-w-[380px] data-open:animate-none data-closed:animate-none"
      >
        <DialogHeader className="flex-none border-b px-4 py-3 pr-11">
          <DialogTitle>Помощник Канона</DialogTitle>
          <DialogDescription>
            Сведения из утверждённых карточек и помощь с разделами справочника.
          </DialogDescription>
        </DialogHeader>
        <div
          ref={transcript}
          tabIndex={0}
          aria-label="Переписка с помощником"
          className="min-h-24 flex-1 space-y-4 overflow-y-auto px-4 py-3 outline-ring"
        >
          {turns.length === 0 && (
            <p className="text-muted-foreground">
              {staff
                ? "Укажите объект, вуз или показатель."
                : "Доступен поиск по карточкам. Для ответов с ИИ войдите."}
            </p>
          )}
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
          className="flex-none border-t p-3"
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
                className="min-h-14 resize-none"
                value={input}
                placeholder="Введите вопрос"
                onChange={(event) => {
                  setInput(event.target.value);
                  setValidation("");
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    if (!sending) void ask(input);
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
  return (
    <>
      {label && <p className="text-xs text-muted-foreground">{label}</p>}
      <p className="whitespace-pre-wrap">{answer.message}</p>
      {answer.citations.map((citation, index) => (
        <blockquote
          key={`${citation.sourceId}:${citation.factId}:${index}`}
          className="rounded-md border bg-card px-3 py-2"
        >
          <p className="whitespace-pre-wrap">«{citation.quote}»</p>
          <Link
            href={citation.href}
            prefetch={false}
            onNavigate={onNavigate}
            className="mt-1 inline-block text-xs font-medium text-primary underline underline-offset-2"
          >
            {citation.title} · версия источника
          </Link>
        </blockquote>
      ))}
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
