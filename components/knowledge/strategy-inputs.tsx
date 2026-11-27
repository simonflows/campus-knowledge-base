"use client";

import {
  useEffect,
  useId,
  cloneElement,
  isValidElement,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { ChevronDown, FileSearch } from "lucide-react";
import { useWorkspaceRequest } from "@/components/demo/workspace-transport";
import { Skeleton } from "@/components/ui/skeleton";
import type { SourceVersionReference } from "@/lib/source-references";
import type {
  IndicatorSlot,
  StrategyDocumentOption,
  StrategyEvidence,
  StrategyOptions,
} from "@/lib/strategy";
import { cn } from "@/lib/utils";

export const emptyReference: SourceVersionReference = {
  cardId: "",
  versionId: "",
};
export const emptyEvidence: StrategyEvidence = {
  document: emptyReference,
  clauseId: "",
};

export function documentReference({
  cardId,
  versionId,
}: SourceVersionReference): SourceVersionReference {
  return { cardId, versionId };
}

export function useStrategyOptions(enabled: boolean, revision?: string) {
  const request = useWorkspaceRequest();
  const [result, setResult] = useState<{
    attempt: number;
    revision?: string;
    options?: StrategyOptions;
  }>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void request("/api/strategy/options", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Не удалось загрузить источники");
        const options = (await response.json()) as StrategyOptions;
        if (!controller.signal.aborted)
          setResult({ attempt, revision, options });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ attempt, revision });
      });
    return () => controller.abort();
  }, [enabled, revision, attempt, request]);

  if (!enabled) return { status: "disabled" as const };
  if (result?.attempt !== attempt || result.revision !== revision)
    return { status: "loading" as const };
  return result.options
    ? { status: "ready" as const, ...result.options }
    : {
        status: "error" as const,
        retry: () => setAttempt((current) => current + 1),
      };
}

export type StrategyOptionsState = ReturnType<typeof useStrategyOptions>;

export function StrategyDisclosure({
  title,
  count,
  children,
  open,
  onToggle,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
}) {
  return (
    <details
      open={open}
      onToggle={(event) => onToggle?.(event.currentTarget.open)}
      className="group/strategy rounded-xl border border-border"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px] [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">{title}</span>
        {count ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {count}
          </span>
        ) : null}
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground group-open/strategy:rotate-180"
        />
      </summary>
      <div className="space-y-4 border-t border-border px-3 py-4">
        {children}
      </div>
    </details>
  );
}

export function StrategyField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm font-medium">
      <label htmlFor={id}>{label}</label>
      {isValidElement<{ id?: string }>(children)
        ? cloneElement(children, { id })
        : children}
    </div>
  );
}

export function StrategySelect({
  className,
  ...props
}: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm font-normal focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60",
        className
      )}
      {...props}
    />
  );
}

export function StrategyOptionsNotice({
  options,
}: {
  options: StrategyOptionsState;
}) {
  if (options.status === "disabled") return null;
  if (options.status === "loading")
    return (
      <Skeleton
        className="h-11 w-full"
        role="status"
        aria-label="Загружаем источники"
      />
    );
  if (options.status === "error")
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-x-4 text-sm text-muted-foreground"
      >
        <span>Источники не загрузились.</span>
        <button
          type="button"
          className="min-h-11 text-primary underline underline-offset-2"
          onClick={options.retry}
        >
          Повторить
        </button>
      </div>
    );
  if (options.documents.length) return null;
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <FileSearch aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      Нет доступных утверждённых документов.
    </p>
  );
}

function referenceKey(reference: SourceVersionReference) {
  return reference.cardId
    ? JSON.stringify([reference.cardId, reference.versionId])
    : "";
}

export function DocumentSelect({
  label,
  reference,
  documents,
  onChange,
}: {
  label: string;
  reference: SourceVersionReference;
  documents: StrategyDocumentOption[];
  onChange: (reference: SourceVersionReference) => void;
}) {
  const value = referenceKey(reference);
  const hasReference = documents.some(
    (document) => referenceKey(document) === value
  );
  return (
    <StrategyField label={label}>
      <StrategySelect
        value={value}
        onChange={(event) => {
          const chosen = documents.find(
            (document) => referenceKey(document) === event.target.value
          );
          onChange(chosen ? documentReference(chosen) : emptyReference);
        }}
      >
        <option value="">Выберите документ</option>
        {value && !hasReference ? (
          <option value={value} disabled>
            Источник обновлён или недоступен
          </option>
        ) : null}
        {documents.map((document) => (
          <option key={document.cardId} value={referenceKey(document)}>
            {document.title} · {document.document.edition}
          </option>
        ))}
      </StrategySelect>
    </StrategyField>
  );
}

export function EvidenceFields({
  evidence,
  documents,
  kind,
  onChange,
}: {
  evidence: StrategyEvidence;
  documents: StrategyDocumentOption[];
  kind?: IndicatorSlot;
  onChange: (evidence: StrategyEvidence) => void;
}) {
  const available = documents.filter(({ document }) =>
    document.clauses.some((clause) => !kind || clause.kind === kind)
  );
  const current = available.find(
    (document) => referenceKey(document) === referenceKey(evidence.document)
  );
  const clauses =
    current?.document.clauses.filter(
      (clause) => !kind || clause.kind === kind
    ) ?? [];
  const selected = clauses.find((clause) => clause.id === evidence.clauseId);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <DocumentSelect
          label="Подтверждающий документ"
          reference={evidence.document}
          documents={available}
          onChange={(document) => onChange({ document, clauseId: "" })}
        />
        <StrategyField label="Подтверждающая выдержка">
          <StrategySelect
            value={selected?.id ?? ""}
            disabled={!current}
            onChange={(event) =>
              onChange({ ...evidence, clauseId: event.target.value })
            }
          >
            <option value="">Выберите выдержку</option>
            {clauses.map((clause) => (
              <option value={clause.id} key={clause.id}>
                {clause.locator}
              </option>
            ))}
          </StrategySelect>
        </StrategyField>
      </div>
      {selected ? (
        <p className="wrap-anywhere border-t border-border pt-2 text-sm text-muted-foreground">
          {selected.excerpt}
        </p>
      ) : null}
      {!available.length && documents.length ? (
        <p className="text-sm text-muted-foreground">
          {kind === "plan"
            ? "В утверждённых документах нет выдержек с планами."
            : kind === "actual"
              ? "В утверждённых документах нет выдержек о достигнутых результатах."
              : "В утверждённых документах пока нет проверенных выдержек."}
        </p>
      ) : null}
    </div>
  );
}
