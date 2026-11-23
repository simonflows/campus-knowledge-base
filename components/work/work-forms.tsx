"use client";

import { useWorkspaceRequest } from "@/components/demo/workspace-transport";

import { useId, useRef, useState } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { WorkData } from "@/lib/work-data";
import type { WorkflowPresentation } from "@/lib/workflow-models";
import type { WorkflowRecord } from "@/lib/workflow";
import { createWorkflowSchema, type CreateWorkflowInput, type WorkflowMutation } from "@/lib/validation/workflow";
import { WorkChecklist, WorkError, WorkSelect } from "./work-primitives";
import { operationAttempt, requestWork, type OperationAttempt } from "./work-state";
import styles from "./workspace.module.css";

type Metadata = { title: string; description: string; responsibleId: string; participantIds: string[]; dueDate: string | null };
type Evidence = Extract<CreateWorkflowInput, { kind: "dispute" }>["evidence"][number];
type EvidenceInput = Omit<Evidence, "year"> & { year: string };
export type MutationFields = WorkflowMutation extends infer Mutation
  ? Mutation extends WorkflowMutation ? Omit<Mutation, "operationId" | "version"> : never : never;

const emptyEvidence: EvidenceInput = { statement: "", object: "", year: "", unit: "", state: "unknown", url: "" };

function MetadataFields({ value, onChange, people, disabled }: {
  value: Metadata; onChange: (value: Metadata) => void; people: WorkData["people"]; disabled: boolean;
}) {
  const id = useId();
  const options = people.map((person) => ({
    value: person.id,
    label: person.name,
    detail: person.organization,
  }));
  return (
    <FieldSet disabled={disabled} className={styles.fieldset}>
      <FieldLegend className="sr-only">Сведения о записи</FieldLegend>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={id + "-title"}>Название</FieldLabel>
          <Input id={id + "-title"} required minLength={3} maxLength={180} value={value.title}
            onChange={(event) => onChange({ ...value, title: event.target.value })} />
        </Field>
        <Field>
          <FieldLabel htmlFor={id + "-description"}>Описание</FieldLabel>
          <Textarea id={id + "-description"} rows={3} maxLength={4000} value={value.description}
            onChange={(event) => onChange({ ...value, description: event.target.value })} />
        </Field>
        <div className={styles.pairedFields}>
          <WorkSelect label="Ответственный" value={value.responsibleId} disabled={disabled}
            onChange={(responsibleId) => onChange({ ...value, responsibleId })}
            options={options} />
          <Field>
            <FieldLabel htmlFor={id + "-due"}>Срок</FieldLabel>
            <Input id={id + "-due"} type="date" value={value.dueDate ?? ""}
              onChange={(event) => onChange({ ...value, dueDate: event.target.value || null })} />
          </Field>
        </div>
        <WorkChecklist label="Участники" options={options} disabled={disabled}
          selected={value.participantIds} onChange={(participantIds) => onChange({ ...value, participantIds })} />
      </FieldGroup>
    </FieldSet>
  );
}

function EvidenceFields({ origin, value, onChange, disabled }: {
  origin: string; value: EvidenceInput; onChange: (value: EvidenceInput) => void; disabled: boolean;
}) {
  const id = useId();
  return (
    <FieldSet className={styles.evidenceFields} disabled={disabled}>
      <FieldLegend variant="label">{origin}</FieldLegend>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={id + "-statement"}>Что утверждает источник</FieldLabel>
          <Textarea id={id + "-statement"} required minLength={3} maxLength={4000} rows={3} value={value.statement}
            onChange={(event) => onChange({ ...value, statement: event.target.value })} />
        </Field>
        <Field>
          <FieldLabel htmlFor={id + "-object"}>Объект или показатель</FieldLabel>
          <Input id={id + "-object"} required maxLength={500} value={value.object}
            onChange={(event) => onChange({ ...value, object: event.target.value })} />
        </Field>
        <div className={styles.pairedFields}>
          <Field>
            <FieldLabel htmlFor={id + "-year"}>Год</FieldLabel>
            <Input id={id + "-year"} type="number" min={1900} max={2200} value={value.year}
              onChange={(event) => onChange({ ...value, year: event.target.value })} />
          </Field>
          <Field>
            <FieldLabel htmlFor={id + "-unit"}>Единица измерения</FieldLabel>
            <Input id={id + "-unit"} maxLength={100} value={value.unit}
              onChange={(event) => onChange({ ...value, unit: event.target.value })} />
          </Field>
        </div>
        <WorkSelect label="План или факт" value={value.state} disabled={disabled}
          options={[{ value: "unknown", label: "Не уточнено" }, { value: "actual", label: "Факт" }, { value: "plan", label: "План" }]}
          onChange={(state) => { if (state === "actual" || state === "plan" || state === "unknown") onChange({ ...value, state }); }} />
        <Field>
          <FieldLabel htmlFor={id + "-url"}>Ссылка на источник</FieldLabel>
          <Input id={id + "-url"} type="url" required maxLength={2000} placeholder="https://"
            value={value.url} onChange={(event) => onChange({ ...value, url: event.target.value })} />
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}

export function sourceKey(source: { cardId: string; versionId: string }) {
  return JSON.stringify([source.cardId, source.versionId]);
}

export function CreateWorkflowForm({ kind, data, onCreated, onCancel }: {
  kind: WorkflowRecord["kind"]; data: WorkData; onCreated: (record: WorkflowPresentation) => void; onCancel: () => void;
}) {
  const workspaceRequest = useWorkspaceRequest();
  const [meta, setMeta] = useState<Metadata>({
    title: "", description: "", responsibleId: data.user.id, participantIds: [], dueDate: null,
  });
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  const [cardId, setCardId] = useState("none");
  const [left, setLeft] = useState(emptyEvidence);
  const [right, setRight] = useState(emptyEvidence);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<OperationAttempt | undefined>(undefined);
  const inFlight = useRef(false);

  async function submit() {
    if (inFlight.current) return;
    const payload = kind === "package"
      ? {
        ...meta, kind,
        sources: data.sources.filter((source) => selectedSources.includes(sourceKey(source)))
          .map(({ cardId, versionId }) => ({ cardId, versionId })),
        documentIds: selectedDocs,
      }
      : {
        ...meta, kind, cardId: cardId === "none" ? null : cardId,
        evidence: [left, right].map((evidence) => ({ ...evidence, year: evidence.year === "" ? null : Number(evidence.year) })),
      };
    const proposed = operationAttempt(attempt.current, payload, undefined);
    const parsed = createWorkflowSchema.safeParse({ ...payload, operationId: proposed.operationId });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(issue?.path.includes("url")
        ? "Укажите ссылку на источник, которая начинается с https://."
        : issue?.path.includes("responsibleId") ? "Выберите ответственного."
          : "Проверьте заполнение названия, сроков и полей источников.");
      return;
    }
    if (kind === "package" && payload.kind === "package" && payload.sources.length !== selectedSources.length) {
      setError("Доступные версии источников обновились. Снимите предыдущий выбор и выберите карточки снова.");
      return;
    }
    attempt.current = proposed;
    setBusy(true);
    setError("");
    inFlight.current = true;
    try {
      const record = await requestWork<WorkflowPresentation>(workspaceRequest, "/api/workflows", {
        method: "POST", body: JSON.stringify(parsed.data),
      });
      toast.success(kind === "package" ? "Подборка создана" : "Разбор открыт");
      onCreated(record);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section className={`desk-panel ${styles.formPanel}`} aria-labelledby="work-create-title">
      <h2 id="work-create-title">{kind === "package" ? "Новая подборка для публикаций" : "Новый разбор источников"}</h2>
      {kind === "package" && <p className={styles.muted}>Дайте подборке название и назначьте ответственного. Источники и черновики можно добавить сейчас или позже.</p>}
      <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <MetadataFields value={meta} onChange={setMeta} people={data.people} disabled={busy} />
        {kind === "package" ? (
          <>
            <WorkChecklist label="Утверждённые источники" disabled={busy} selected={selectedSources} onChange={setSelectedSources}
              options={data.sources.map((source) => ({ value: sourceKey(source), label: source.title }))} />
            <WorkChecklist label="Материалы редактора" disabled={busy} selected={selectedDocs} onChange={setSelectedDocs}
              options={data.documents.map((doc) => ({ value: doc.id, label: doc.title, detail: doc.channel }))} />
          </>
        ) : (
          <>
            <WorkSelect label="Связанная карточка" value={cardId} onChange={setCardId} disabled={busy}
              options={[{ value: "none", label: "Без карточки" }, ...data.sources.map(({ cardId: value, title: label }) => ({ value, label }))]} />
            <div className={styles.evidenceGrid}>
              <EvidenceFields origin="Первый источник" value={left} onChange={setLeft} disabled={busy} />
              <EvidenceFields origin="Второй источник" value={right} onChange={setRight} disabled={busy} />
            </div>
          </>
        )}
        {error && <WorkError>{error}</WorkError>}
        <div className={styles.actions}>
          <Button type="submit" disabled={busy}><Save data-icon="inline-start" aria-hidden="true" />{busy ? "Сохраняем…" : "Создать"}</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Закрыть форму</Button>
        </div>
      </form>
    </section>
  );
}

export function EditMetadataForm({ record, people, busy, onSave, onCancel }: {
  record: WorkflowRecord; people: WorkData["people"]; busy: boolean;
  onSave: (fields: MutationFields) => Promise<boolean>; onCancel: () => void;
}) {
  const [initial] = useState<Metadata>({
    title: record.title, description: record.description, responsibleId: record.responsibleId,
    participantIds: record.participantIds, dueDate: record.dueDate,
  });
  const [value, setValue] = useState(initial);
  const title = value.title.trim();
  const description = value.description.trim();
  const sameParticipants = JSON.stringify(value.participantIds) === JSON.stringify(initial.participantIds);
  const changes = {
    ...(title !== initial.title && { title }),
    ...(description !== initial.description && { description }),
    ...(value.responsibleId !== initial.responsibleId && { responsibleId: value.responsibleId }),
    ...(!sameParticipants && { participantIds: value.participantIds }),
    ...(value.dueDate !== initial.dueDate && { dueDate: value.dueDate }),
  };
  const dirty = Object.keys(changes).length > 0;
  const overlap = (Object.keys(changes) as (keyof Metadata)[]).some((field) =>
    JSON.stringify(record[field]) !== JSON.stringify(initial[field]) &&
    JSON.stringify(record[field]) !== JSON.stringify(value[field]),
  );
  return (
    <form className={styles.form} onSubmit={(event) => {
      event.preventDefault();
      if (dirty) void onSave({ action: "edit", ...changes }).then((saved) => { if (saved) onCancel(); });
    }}>
      <MetadataFields value={value} onChange={setValue} disabled={busy} people={people} />
      {overlap && <p className={styles.muted}>В записи изменились поля, которые вы редактируете. Сравните их с актуальными сведениями выше перед сохранением.</p>}
      <div className={styles.actions}>
        <Button type="submit" disabled={busy || !dirty}>{busy ? "Сохраняем…" : "Сохранить изменения"}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Закрыть форму</Button>
      </div>
    </form>
  );
}
