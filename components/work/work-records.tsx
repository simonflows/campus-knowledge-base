"use client";

import { WorkspaceExternalLink } from "@/components/navigation/workspace-navigation";

import { useWorkspaceRequest } from "@/components/demo/workspace-transport";

import { AppLink as Link } from "@/components/navigation/workspace-navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { editorialStatusLabels } from "@/lib/editorial";
import type { WorkData } from "@/lib/work-data";
import type { WorkflowPresentation } from "@/lib/workflow-models";
import type { SourceDispute, WorkflowEvent } from "@/lib/workflow";
import { workflowMutationSchema } from "@/lib/validation/workflow";
import { EditMetadataForm, sourceKey, type MutationFields } from "./work-forms";
import { WorkEmpty, WorkError, WorkLoading, WorkSelect } from "./work-primitives";
import { formatWorkDay, keepNewestRecord, operationAttempt, requestWork, WorkRequestError, workHref, type OperationAttempt } from "./work-state";
import styles from "./workspace.module.css";

type RecordSection = "packages" | "disputes";
type DetailResponse = WorkflowPresentation & { events: WorkflowEvent[] };

const eventLabels: Record<string, string> = {
  created: "Создана запись", edit: "Изменены сведения", "add-source": "Добавлен источник",
  "remove-source": "Убран источник", "add-document": "Добавлен материал",
  "remove-document": "Убран материал", resolve: "Зафиксировано решение", reopen: "Разбор открыт повторно",
};
const factLabels = { actual: "Факт", plan: "План", unknown: "Не уточнено" };

function draftStatus(status: string) {
  return editorialStatusLabels[status as keyof typeof editorialStatusLabels] ?? "Состояние не указано";
}

function evidenceLink(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function WorkRecordList({ section, rows, selected, people }: {
  section: RecordSection; rows: WorkflowPresentation[]; selected?: string; people: WorkData["people"];
}) {
  const packages = section === "packages";
  return (
    <section className="desk-panel" aria-labelledby="work-record-list">
      <header className={styles.panelHeading}>
        <h2 id="work-record-list">{packages ? "Подборки для публикаций" : "Разборы источников"}</h2>
        <Button size="sm" nativeButton={false} render={<Link href={workHref(section, undefined, true)} />}>
          <Plus data-icon="inline-start" aria-hidden="true" />{packages ? "Создать подборку" : "Начать разбор"}
        </Button>
      </header>
      {rows.length === 0 ? (
        <WorkEmpty title={packages ? "Подборок пока нет" : "Разборов пока нет"}>
          {packages ? "Соберите в одной подборке источники, черновики и варианты текста по общей теме." : "Сопоставьте два источника и зафиксируйте решение."}
        </WorkEmpty>
      ) : (
        <ul className={styles.recordList}>
          {rows.map(({ record }) => (
            <li key={record.id}>
              <Link href={workHref(section, record.id)} aria-current={record.id === selected ? "page" : undefined}>
                <div>
                  <strong>{record.title}</strong>
                  <span>{people.find((person) => person.id === record.responsibleId)?.name ?? "Ответственный недоступен"}</span>
                </div>
                <div className={styles.listEnd}>
                  {record.kind === "dispute" && <span>{record.status === "resolved" ? "Решение принято" : "Открыт"}</span>}
                  {record.dueDate && <time dateTime={record.dueDate}>{formatWorkDay(record.dueDate)}</time>}
                  <ArrowRight size={16} aria-hidden="true" />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PackageDetails({ item, data, editable, busy, save }: {
  item: WorkflowPresentation; data: WorkData; editable: boolean; busy: boolean;
  save: (fields: MutationFields) => Promise<boolean>;
}) {
  const [pickedSource, setPickedSource] = useState("");
  const [pickedDoc, setPickedDoc] = useState("");
  const attachedSources = new Set(item.sourceDetails.map(sourceKey));
  const attachedDocs = new Set(item.materialDetails.map((material) => material.id));
  const sources = data.sources.filter((source) => !attachedSources.has(sourceKey(source)));
  const documents = data.documents.filter((document) => !attachedDocs.has(document.id));
  return (
    <>
      <section aria-labelledby="package-sources" className={styles.recordSection}>
        <h3 id="package-sources">Утверждённые источники</h3>
        {item.sourceDetails.length > 0 ? (
          <ul className={styles.lineList}>
            {item.sourceDetails.map(({ cardId, versionId, title }) => (
              <li key={sourceKey({ cardId, versionId })} className={styles.lineAction}>
                <Link className={styles.textLink} href={`/knowledge?card=${encodeURIComponent(cardId)}&version=${encodeURIComponent(versionId)}`}>
                  {title} <ArrowUpRight size={15} aria-hidden="true" />
                </Link>
                {editable && <Button size="sm" variant="ghost" disabled={busy}
                  aria-label={`Убрать источник «${title}»`}
                  onClick={() => void save({ action: "remove-source", source: { cardId, versionId } })}>Убрать</Button>}
              </li>
            ))}
          </ul>
        ) : <p className={styles.muted}>{editable && sources.length > 0 ? "Добавьте карточку с фактами для публикации." : "Доступных источников пока нет."}</p>}
        {editable && sources.length > 0 && (
          <div className={styles.addRow}>
            <WorkSelect label="Карточка для добавления" value={pickedSource} onChange={setPickedSource} disabled={busy}
              options={sources.map((source) => ({ value: sourceKey(source), label: source.title }))} />
            <Button variant="outline" disabled={busy || !sources.some((entry) => sourceKey(entry) === pickedSource)} onClick={() => {
              const chosen = sources.find((entry) => sourceKey(entry) === pickedSource);
              if (chosen) void save({ action: "add-source", source: { cardId: chosen.cardId, versionId: chosen.versionId } })
                .then((saved) => { if (saved) setPickedSource(""); });
            }}>Добавить источник</Button>
          </div>
        )}
      </section>
      <section aria-labelledby="package-materials" className={styles.recordSection}>
        <h3 id="package-materials">Материалы и варианты</h3>
        {item.materialDetails.length > 0 ? (
          <ul className={styles.lineList}>
            {item.materialDetails.map(({ id, title, channel, status }) => (
              <li key={id} className={styles.lineAction}>
                <div>
                  <Link className={styles.textLink} href={`/editor?draft=${encodeURIComponent(id)}`}>
                    {title} <ArrowUpRight size={15} aria-hidden="true" />
                  </Link>
                  <p>{channel} · {draftStatus(status)}</p>
                </div>
                {editable && <Button size="sm" variant="ghost" disabled={busy}
                  aria-label={`Убрать материал «${title}»`}
                  onClick={() => void save({ action: "remove-document", documentId: id })}>Убрать</Button>}
              </li>
            ))}
          </ul>
        ) : <p className={styles.muted}>{editable && documents.length > 0 ? "Добавьте черновик или вариант текста из редактора." : "Доступных материалов пока нет."}</p>}
        {editable && documents.length > 0 && (
          <div className={styles.addRow}>
            <WorkSelect label="Материал для добавления" value={pickedDoc} onChange={setPickedDoc} disabled={busy}
              options={documents.map(({ id: value, title, channel }) => ({ value, label: `${title} · ${channel}` }))} />
            <Button variant="outline" disabled={busy || !documents.some((entry) => entry.id === pickedDoc)} onClick={() => {
              void save({ action: "add-document", documentId: pickedDoc }).then((saved) => { if (saved) setPickedDoc(""); });
            }}>Добавить материал</Button>
          </div>
        )}
      </section>
    </>
  );
}

function DisputeDetails({ record, linkedTitle, canDecide, busy, save }: {
  record: SourceDispute; linkedTitle?: string; canDecide: boolean; busy: boolean;
  save: (fields: MutationFields) => Promise<boolean>;
}) {
  const [comment, setComment] = useState("");
  const commentId = useId();
  const open = record.status === "open";
  return (
    <>
      {record.cardId && linkedTitle && (
        <Link className={styles.textLink} href={`/knowledge?card=${encodeURIComponent(record.cardId)}`}>{linkedTitle}</Link>
      )}
      <section className={styles.recordSection} aria-labelledby="dispute-evidence">
        <h3 id="dispute-evidence">Что говорят источники</h3>
        <div className={styles.evidenceGrid}>
          {record.evidence.map((part, index) => {
            const url = evidenceLink(part.url);
            return (
              <div className={styles.evidence} key={index}>
                <h4>{index === 0 ? "Первый источник" : "Второй источник"}</h4>
                <p className={styles.prewrap}>{part.statement}</p>
                <dl className={styles.evidenceMeta}>
                  <dt>Объект</dt><dd>{part.object}</dd>
                  <dt>Год</dt><dd>{part.year ?? "Не указан"}</dd>
                  <dt>Единица</dt><dd>{part.unit || "Не указана"}</dd>
                  <dt>План или факт</dt><dd>{factLabels[part.state]}</dd>
                </dl>
                {url && <WorkspaceExternalLink className={styles.textLink} href={url} target="_blank" rel="noopener noreferrer">
                  Открыть источник <ArrowUpRight size={15} aria-hidden="true" />
                </WorkspaceExternalLink>}
              </div>
            );
          })}
        </div>
      </section>
      <section className={styles.recordSection} aria-labelledby="dispute-decision">
        <h3 id="dispute-decision">Решение</h3>
        {record.decision ? <p className={styles.prewrap}>{record.decision}</p> : <p className={styles.muted}>Решение пока не зафиксировано.</p>}
        {canDecide && (
          <form className={styles.form} onSubmit={(event) => {
            event.preventDefault();
            const value = comment.trim();
            if (value.length < 10) return;
            void save(open ? { action: "resolve", decision: value } : { action: "reopen", reason: value })
              .then((saved) => { if (saved) setComment(""); });
          }}>
            <Field>
              <FieldLabel htmlFor={commentId}>{open ? "Решение и основание" : "Причина повторного разбора"}</FieldLabel>
              <Textarea id={commentId} required minLength={10} maxLength={4000} value={comment} disabled={busy}
                onChange={(event) => setComment(event.target.value)} rows={3} />
            </Field>
            {open && <p className={styles.muted}>Чтобы утвердить сведения в справочнике, откройте карточку и пройдите согласование.</p>}
            <Button type="submit" disabled={busy || comment.trim().length < 10}>{open ? "Зафиксировать решение" : "Открыть разбор повторно"}</Button>
          </form>
        )}
      </section>
    </>
  );
}

export function WorkRecordDetail({ section, id, initial, data, onChanged }: {
  section: RecordSection; id: string; initial?: WorkflowPresentation;
  data: WorkData; onChanged: (item: WorkflowPresentation) => void;
}) {
  const workspaceRequest = useWorkspaceRequest();
  const [item, setItem] = useState(initial);
  const [events, setEvents] = useState<WorkflowEvent[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; conflict?: boolean } | null>(null);
  const seen = useRef(initial);
  const read = useRef<AbortController | null>(null);
  const attempt = useRef<OperationAttempt | undefined>(undefined);
  const writing = useRef(false);
  const active = useRef(true);
  const endpoint = `/api/workflows/${encodeURIComponent(id)}`;

  const refresh = useCallback(async () => {
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    try {
      const { events, ...received } = await requestWork<DetailResponse>(workspaceRequest, endpoint, { signal: controller.signal });
      if (!controller.signal.aborted && keepNewestRecord(seen.current, received) === received) {
        seen.current = received;
        setItem(received);
        setEvents(events.filter((event) => event.version <= received.record.version));
        setError(null);
      }
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof WorkRequestError && [401, 403, 404].includes(failure.status)) {
        seen.current = undefined;
        setItem(undefined);
        setEvents(null);
      }
      setError({ message: (failure as Error).message });
    }
  }, [endpoint, workspaceRequest]);

  useEffect(() => {
    active.current = true;
    let mounted = true;
    queueMicrotask(() => { if (mounted) void refresh(); });
    return () => {
      mounted = false;
      active.current = false;
      read.current?.abort();
    };
  }, [refresh]);

  async function save(fields: MutationFields) {
    const record = seen.current?.record;
    if (!record || writing.current || error?.conflict) return false;
    const nextAttempt = operationAttempt(attempt.current, fields, record.version);
    const parsed = workflowMutationSchema.safeParse({
      ...fields, version: nextAttempt.version, operationId: nextAttempt.operationId,
    });
    if (!parsed.success) {
      setError({ message: "Проверьте заполнение полей." });
      return false;
    }
    attempt.current = nextAttempt;
    writing.current = true;
    read.current?.abort();
    setBusy(true);
    setError(null);
    try {
      const next = await requestWork<WorkflowPresentation>(workspaceRequest, endpoint, {
        method: "PATCH", body: JSON.stringify(parsed.data),
      });
      read.current?.abort();
      attempt.current = undefined;
      onChanged(next);
      if (active.current) {
        seen.current = next;
        setItem(next);
        void refresh();
        toast.success("Изменения сохранены");
      }
      return true;
    } catch (failure) {
      const conflict = failure instanceof WorkRequestError && failure.status === 409;
      if (conflict) attempt.current = undefined;
      if (active.current) setError({ message: conflict
        ? "Запись изменилась. Загрузите актуальную версию и проверьте свой ввод перед отправкой."
        : (failure as Error).message, conflict });
      return false;
    } finally {
      writing.current = false;
      if (active.current) setBusy(false);
    }
  }

  const backHref = workHref(section);
  const errorContent = error && <WorkError title={error.conflict ? "Запись изменилась" : "Возникла ошибка"} action={
    <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={busy}>Загрузить актуальные данные</Button>
  }>{error.message}</WorkError>;
  const record = item?.record;
  if (!item || !record) {
    return <div className={`desk-panel ${styles.formPanel}`}>
        <Link className={styles.textLink} href={backHref}><ArrowLeft size={16} aria-hidden="true" />К списку</Link>
      {errorContent || <WorkLoading label="Загружаем запись" />}
    </div>;
  }
  const editable = data.user.role === "admin" || record.creatorId === data.user.id || record.responsibleId === data.user.id;
  const canDecide = data.user.role === "admin" || record.responsibleId === data.user.id;
  const participantNames = record.participantIds.flatMap((personId) => {
    const person = data.people.find(({ id }) => id === personId);
    return person ? [person.name] : [];
  });
  const actionsDisabled = busy || Boolean(error?.conflict);
  return (
    <article className={`desk-panel ${styles.formPanel}`} aria-labelledby="work-detail-title">
      <Link className={styles.textLink} href={backHref}><ArrowLeft size={16} aria-hidden="true" />К списку</Link>
      <div className={styles.detailHeading}>
        <div>
          {record.kind === "dispute" && <Badge variant="outline">{record.status === "resolved" ? "Решение принято" : "Открыт"}</Badge>}
          <h2 id="work-detail-title">{record.title}</h2>
        </div>
        {editable && !editing && <Button variant="outline" disabled={busy} onClick={() => setEditing(true)}>Изменить сведения</Button>}
      </div>
      <dl className={styles.recordMeta}>
        <div><dt>Ответственный</dt><dd>{data.people.find((person) => person.id === record.responsibleId)?.name ?? "Сотрудник недоступен"}</dd></div>
        <div><dt>Срок</dt><dd>{record.dueDate ? <time dateTime={record.dueDate}>{formatWorkDay(record.dueDate)}</time> : "Без срока"}</dd></div>
        {participantNames.length > 0 && <div><dt>Участники</dt><dd>{participantNames.join(", ")}</dd></div>}
      </dl>
      {record.description && <p className={styles.prewrap}>{record.description}</p>}
      {errorContent}
      {editing && editable && <EditMetadataForm record={record} people={data.people} busy={actionsDisabled}
        onSave={save} onCancel={() => setEditing(false)} />}
      {record.kind === "package"
        ? <PackageDetails item={item} data={data} editable={editable} busy={actionsDisabled} save={save} />
        : <DisputeDetails record={record} linkedTitle={data.sources.find((source) => source.cardId === record.cardId)?.title}
          canDecide={canDecide} busy={actionsDisabled} save={save} />}
      <details className={styles.history}>
        <summary>История</summary>
        {events ? (
          events.length === 0 ? <p className={styles.muted}>История пока пуста.</p> : (
            <ol className={styles.lineList}>
              {[...events].reverse().map((event) => (
                <li key={event.id}>
                  <strong>{eventLabels[event.action] ?? "Запись обновлена"}</strong>
                  <p>{event.actorName} · <time dateTime={event.at}>{formatWorkDay(event.at)}</time></p>
                  {(event.action === "resolve" || event.action === "reopen") && <p className={styles.prewrap}>{event.message}</p>}
                </li>
              ))}
            </ol>
          )
        ) : error ? <p className={styles.muted}>Историю можно загрузить повторно.</p> : <WorkLoading label="Загружаем историю" />}
      </details>
    </article>
  );
}
