"use client";
import { WorkspaceMasthead } from "@/components/workspace-masthead";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Inbox,
  Mail,
  Plus,
  Send,
  RefreshCw,
  LockKeyhole,
  SquarePen,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import "@/app/campus-workspaces.css";
import { Badge } from "@/components/ui/badge";
import { universities } from "@/lib/data";
import type { SessionUser } from "@/lib/auth";
import {
  createInformationRequestSchema,
  updateInformationRequestSchema,
  canAnswerInformationRequest,
  requestStatusLabels,
  type InformationRequest,
} from "@/lib/information-requests";

const dateLabel = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Yekaterinburg",
});

type MailFilter = "all" | "incoming" | "sent";

const mailFilters = [
  { id: "all", label: "Все" },
  { id: "incoming", label: "Входящие" },
  { id: "sent", label: "Отправленные" },
] as const;

type Props = {
  initialItems: InformationRequest[];
  user: SessionUser | null;
  available: boolean;
  initialQuestion: string;
  initialCardId: string | null;
};
function RequestItem({
  item,
  user,
  onUpdated,
  available,
}: {
  item: InformationRequest;
  user: SessionUser;
  onUpdated: (item: InformationRequest) => void;
  available: boolean;
}) {
  const [answer, setAnswer] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const operation = useRef<string | null>(null);
  const mutate = async (action: "answer" | "submit") => {
    if (busy) return;
    const operationId = operation.current ?? crypto.randomUUID();
    operation.current = operationId;
    const parsed = updateInformationRequestSchema.safeParse({
      action,
      revision: item.revision,
      operationId,
      answer,
      evidenceUrl,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Проверьте поля ответа");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/requests/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Не удалось сохранить");
      onUpdated(data);
      operation.current = null;
      toast.success(
        action === "answer"
          ? "Ответ отправлен автору"
          : "Ответ передан координатору"
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Не удалось сохранить"
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="desk-message-header">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            className="desk-mail-status"
            data-status={item.status}
            variant="secondary"
          >
            {requestStatusLabels[item.status]}
          </Badge>
          <span className="text-sm text-muted-foreground">
            {
              universities.find((v) => v.id === item.recipientUniversityId)
                ?.shortName
            }
          </span>
        </div>
        <h2 className="desk-message-title">{item.subject}</h2>
        <p className="desk-footnote">
          {item.authorName} · {item.authorOrganization} ·{" "}
          <time dateTime={item.createdAt}>
            {dateLabel.format(new Date(item.createdAt))}
          </time>
        </p>
      </div>
      <div className="desk-message-body">
        <p className="whitespace-pre-wrap break-words">{item.question}</p>
        {item.linkedCardId && (
          <Link
            href={`/knowledge?card=${encodeURIComponent(item.linkedCardId)}`}
            className="desk-text-link"
          >
            Открыть связанную карточку <ArrowUpRight size={16} />
          </Link>
        )}
        {item.answer && (
          <div className="desk-mail-answer">
            <h3 className="font-semibold">Ответ вуза</h3>
            <p className="whitespace-pre-wrap break-words">{item.answer}</p>
            {item.evidenceUrl && (
              <a
                href={item.evidenceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="desk-text-link"
              >
                Источник ответа <ArrowUpRight size={16} />
              </a>
            )}
            <p className="text-sm text-muted-foreground">
              {item.status === "approved"
                ? "Координатор утвердил карточку. Используйте её актуальную официальную версию."
                : item.status === "rejected"
                  ? "Координатор отклонил карточку. Ответ не вошёл в канон."
                  : item.status === "unavailable"
                    ? "Связанная с ответом карточка больше недоступна."
                    : "Ответ требует подтверждения. До утверждения карточки его сведения не используются как официальные факты."}
            </p>
          </div>
        )}
        {item.status === "open" && canAnswerInformationRequest(user, item) && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void mutate("answer");
            }}
            className="flex flex-col gap-3"
          >
            <label htmlFor={`answer-${item.id}`}>Ответ автору</label>
            <Textarea
              id={`answer-${item.id}`}
              value={answer}
              onChange={(e) => {
                setAnswer(e.target.value);
                operation.current = null;
              }}
              maxLength={10000}
            />
            <label htmlFor={`source-${item.id}`}>
              Официальный источник ответа (HTTPS)
            </label>
            <Input
              id={`source-${item.id}`}
              type="url"
              value={evidenceUrl}
              onChange={(e) => {
                setEvidenceUrl(e.target.value);
                operation.current = null;
              }}
              maxLength={2000}
              placeholder="https://…"
            />
            <Button type="submit" disabled={busy || !available}>
              Отправить ответ
            </Button>
          </form>
        )}
        {item.status === "answered" && (
          <Button
            onClick={() => void mutate("submit")}
            disabled={busy || !available}
          >
            Передать ответ координатору на подтверждение
          </Button>
        )}
        {item.candidateCardId && (
          <Link
            href={`/knowledge?card=${encodeURIComponent(item.candidateCardId)}`}
            className="desk-text-link"
          >
            Открыть карточку ответа <ArrowUpRight size={16} />
          </Link>
        )}
      </div>
    </>
  );
}
export function RequestsWorkspace({
  initialItems,
  user,
  available,
  initialQuestion,
  initialCardId,
}: Props) {
  const [items, setItems] = useState(initialItems);
  const [subject, setSubject] = useState("");
  const [question, setQuestion] = useState(initialQuestion);
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<MailFilter>("all");
  const [selectedId, setSelectedId] = useState(() => initialItems[0]?.id ?? "");
  const [composing, setComposing] = useState(
    Boolean(initialQuestion || initialCardId || !initialItems.length)
  );
  const [mobileOpen, setMobileOpen] = useState(
    Boolean(initialQuestion || initialCardId)
  );
  const [refreshing, setRefreshing] = useState(false);
  const detailPane = useRef<HTMLElement>(null);
  const listPane = useRef<HTMLElement>(null);
  const operation = useRef<string | null>(null);
  const refreshRequest = useRef<AbortController | null>(null);
  useEffect(() => () => refreshRequest.current?.abort(), []);

  const upsert = (item: InformationRequest) => {
    if (refreshRequest.current) {
      refreshRequest.current.abort();
      refreshRequest.current = null;
      setRefreshing(false);
    }
    setItems((current) => [
      item,
      ...current.filter((row) => row.id !== item.id),
    ]);
  };
  const refresh = async () => {
    if (refreshRequest.current) return;
    const controller = new AbortController();
    refreshRequest.current = controller;
    setRefreshing(true);
    try {
      const response = await fetch("/api/requests", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(data.error);
      setItems(data.items);
    } catch {
      if (!controller.signal.aborted)
        toast.error("Не удалось обновить входящие");
    } finally {
      if (!controller.signal.aborted) {
        refreshRequest.current = null;
        setRefreshing(false);
      }
    }
  };
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const operationId = operation.current ?? crypto.randomUUID();
    operation.current = operationId;
    const parsed = createInformationRequestSchema.safeParse({
      operationId,
      subject,
      question,
      recipientUniversityId: recipient,
      linkedCardId: initialCardId,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Заполните поля");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      upsert(data);
      setSelectedId(data.id);
      setComposing(false);
      setFilter("sent");
      operation.current = null;
      setSubject("");
      setQuestion("");
      toast.success("Запрос отправлен во входящие вуза");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Не удалось отправить"
      );
    } finally {
      setBusy(false);
    }
  };
  const edit = () => {
    operation.current = null;
  };
  const allowed = user && user.role !== "guest";
  const visibleItems = items.filter((item) => {
    if (filter === "sent") return item.authorId === user?.id;
    if (filter === "incoming")
      return (
        item.recipientUniversityId === user?.universityId &&
        item.authorId !== user?.id
      );
    return true;
  });
  const selected =
    visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0];
  const focusDetails = () =>
    requestAnimationFrame(() => detailPane.current?.focus());

  const openComposer = () => {
    setComposing(true);
    setMobileOpen(true);
    focusDetails();
  };

  return (
    <div className="atlas-wrap campus-workspace desk-requests">
      <WorkspaceMasthead
        id="requests-title"
        icon={Inbox}
        title="Входящие запросы"
        description="Запрашивайте данные у вузов. Переписку видят автор, вуз-получатель и координатор."
      >
        {allowed ? (
          <Button onClick={openComposer}>
            <Plus data-icon="inline-start" /> Новый запрос
          </Button>
        ) : (
          <Link href="/login" className="desk-text-link">
            Войти для доступа <ArrowRight size={16} aria-hidden="true" />
          </Link>
        )}
      </WorkspaceMasthead>
      {!allowed ? (
        <section className="desk-panel desk-locked">
          <span className="desk-icon" aria-hidden="true">
            <LockKeyhole />
          </span>
          <div>
            <h2>Переписка вузов</h2>
            <p className="desk-footnote">
              Войдите под рабочим аккаунтом, чтобы отправлять запросы и читать
              ответы.
            </p>
          </div>
        </section>
      ) : (
        <div className="desk-inbox" data-mobile-open={mobileOpen}>
          <section
            className="desk-panel desk-mail-list"
            aria-label="Переписка"
            ref={listPane}
            tabIndex={-1}
          >
            <div className="desk-panel-head">
              <div className="flex items-center gap-2">
                <Inbox size={19} aria-hidden="true" />
                <h2>Переписка</h2>
                <Badge variant="secondary">{items.length}</Badge>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Обновить"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                <RefreshCw
                  className={refreshing ? "animate-spin" : undefined}
                />
              </Button>
            </div>
            <div
              className="desk-nav desk-mail-filter"
              role="group"
              aria-label="Фильтр переписки"
            >
              {mailFilters.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={filter === id}
                  onClick={() => {
                    setFilter(id);
                    setComposing(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div aria-live="polite" className="desk-threads">
              {visibleItems.length ? (
                <ul>
                  {visibleItems.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="desk-thread"
                        aria-pressed={!composing && item.id === selected?.id}
                        onClick={() => {
                          setSelectedId(item.id);
                          setComposing(false);
                          setMobileOpen(true);
                          focusDetails();
                        }}
                      >
                        <span className="desk-thread-meta">
                          {item.authorId === user.id
                            ? `Кому: ${universities.find((v) => v.id === item.recipientUniversityId)?.shortName ?? "Вуз"}`
                            : item.authorOrganization}
                        </span>
                        <strong>{item.subject}</strong>
                        <span className="desk-thread-meta">
                          {requestStatusLabels[item.status]}
                        </span>
                        <ArrowRight
                          className="desk-thread-arrow"
                          size={16}
                          aria-hidden="true"
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="desk-workspace-empty">
                  <span className="desk-icon" aria-hidden="true">
                    <Inbox />
                  </span>
                  <p>Запросов пока нет</p>
                </div>
              )}
            </div>
          </section>
          <section
            className="desk-panel desk-mail-detail"
            ref={detailPane}
            aria-label={composing ? "Новый запрос" : "Запрос"}
            tabIndex={-1}
          >
            <div className="desk-mail-back">
              <Button
                variant="ghost"
                onClick={() => {
                  setMobileOpen(false);
                  requestAnimationFrame(() => listPane.current?.focus());
                }}
              >
                <ArrowLeft data-icon="inline-start" /> К переписке
              </Button>
            </div>
            {composing ? (
              <div className="desk-panel-in">
                <div className="desk-message-header">
                  <span className="desk-icon" aria-hidden="true">
                    <SquarePen />
                  </span>
                  <h2 className="desk-message-title">Новый запрос</h2>
                  <p className="desk-footnote">
                    Ответ придёт в переписку. Для использования как официального
                    факта требуется подтверждение.
                  </p>
                </div>
                <form onSubmit={send} className="desk-message-body">
                  <Field>
                    <FieldLabel htmlFor="request-recipient">
                      Вуз-получатель
                    </FieldLabel>
                    <select
                      id="request-recipient"
                      value={recipient}
                      onChange={(event) => {
                        setRecipient(event.target.value);
                        edit();
                      }}
                      className="rounded-lg border px-2.5 py-2"
                      disabled={busy}
                      required
                    >
                      <option value="">Выберите вуз</option>
                      {universities
                        .filter((v) => v.id !== user.universityId)
                        .map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.shortName}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="request-subject">
                      Тема запроса
                    </FieldLabel>
                    <Input
                      id="request-subject"
                      value={subject}
                      onChange={(event) => {
                        setSubject(event.target.value);
                        edit();
                      }}
                      maxLength={180}
                      disabled={busy}
                      required
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="request-question">
                      Какие данные нужны?
                    </FieldLabel>
                    <Textarea
                      id="request-question"
                      rows={6}
                      value={question}
                      onChange={(event) => {
                        setQuestion(event.target.value);
                        edit();
                      }}
                      maxLength={4000}
                      disabled={busy}
                      required
                    />
                    {initialCardId ? (
                      <FieldDescription>
                        Запрос связан с{" "}
                        <Link
                          href={`/knowledge?card=${encodeURIComponent(initialCardId)}`}
                        >
                          карточкой базы знаний
                        </Link>
                        .
                      </FieldDescription>
                    ) : null}
                  </Field>
                  <Button
                    className="w-fit"
                    type="submit"
                    disabled={busy || !available}
                  >
                    <Send data-icon="inline-start" />
                    {busy ? "Отправляем…" : "Отправить запрос"}
                  </Button>
                  {!available ? (
                    <p role="status" className="desk-footnote">
                      База данных недоступна. Отправка временно отключена.
                    </p>
                  ) : null}
                </form>
              </div>
            ) : selected ? (
              <div key={selected.id} className="desk-panel-in">
                <RequestItem
                  item={selected}
                  user={user}
                  onUpdated={upsert}
                  available={available}
                />
              </div>
            ) : (
              <div className="desk-workspace-empty desk-mail-placeholder">
                <span className="desk-icon" aria-hidden="true">
                  <Mail />
                </span>
                <p>
                  {filter === "all"
                    ? "Здесь появятся ответы вузов"
                    : "В этой папке пока нет переписки"}
                </p>
                {filter === "all" ? (
                  <Button variant="outline" onClick={openComposer}>
                    Написать запрос
                  </Button>
                ) : null}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
