"use client";

import { useId, useState, type ReactNode } from "react";
import { CircleAlert, ClipboardList } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AiActivity } from "@/components/ui/ai-activity";
import styles from "./workspace.module.css";

export type Choice = { value: string; label: string; detail?: string };

export function WorkSelect({ label, value, options, onChange, disabled, placeholder }: {
  label: string; value: string; options: Choice[]; onChange: (value: string) => void;
  disabled?: boolean; placeholder?: string;
}) {
  const id = useId();
  return (
    <Field className={styles.selectField} data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value || null} onValueChange={(next) => onChange(next ?? "")} disabled={disabled}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue>{options.find((option) => option.value === value)?.label ?? placeholder ?? "Выберите"}</SelectValue>
        </SelectTrigger>
        <SelectContent align="start" alignItemWithTrigger={false}>
          <SelectGroup>
            {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

export function WorkChecklist({ label, options, selected, onChange, disabled }: {
  label: string; options: Choice[]; selected: string[]; onChange: (values: string[]) => void; disabled?: boolean;
}) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase("ru");
  const filtered = options.filter(({ label, detail }) => `${label} ${detail ?? ""}`.toLocaleLowerCase("ru").includes(normalized));
  const available = new Set(options.map(({ value }) => value));
  const hasUnavailable = selected.some((value) => !available.has(value));
  return (
    <details className={styles.checklist}>
      <summary>{label}{selected.length > 0 ? ` · ${selected.length}` : ""}</summary>
      <FieldSet disabled={disabled} className={styles.checklistBody}>
        <FieldLegend className="sr-only">{label}</FieldLegend>
        {options.length > 8 && (
          <Field>
            <FieldLabel htmlFor={searchId} className="sr-only">Поиск — {label.toLocaleLowerCase("ru")}</FieldLabel>
            <Input id={searchId} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти в списке" />
          </Field>
        )}
        {filtered.length ? (
          <FieldGroup className={styles.choices}>
            {filtered.map(({ value, label: name, detail }) => (
              <label className={styles.choice} key={value}>
                <input type="checkbox" checked={selected.includes(value)} onChange={(event) =>
                  onChange(event.target.checked ? [...selected, value] : selected.filter((entry) => entry !== value))
                } />
                <span>{name}{detail && <small>{detail}</small>}</span>
              </label>
            ))}
          </FieldGroup>
        ) : <p className={styles.muted}>{query ? "Ничего не найдено." : "Пока нет доступных записей."}</p>}
        {hasUnavailable && (
          <Button type="button" size="sm" variant="outline" onClick={() => onChange(selected.filter((value) => available.has(value)))}>
            Убрать недоступные из выбора
          </Button>
        )}
      </FieldSet>
    </details>
  );
}

export function WorkEmpty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <Empty className={styles.empty}>
      <EmptyHeader>
        <EmptyMedia variant="icon"><ClipboardList aria-hidden="true" /></EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {children && <EmptyDescription>{children}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

export function WorkError({ title = "Не удалось выполнить действие", children, action }: {
  title?: string; children: ReactNode; action?: ReactNode;
}) {
  return (
    <Alert variant="destructive" className={styles.error}>
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{children}{action && <div className={styles.actions}>{action}</div>}</AlertDescription>
    </Alert>
  );
}

export function WorkLoading({ label }: { label: string }) {
  return (
    <div className={styles.loading}>
      <AiActivity label={label} />
      <Skeleton className="h-6 w-3/5" aria-hidden="true" />
      <Skeleton className="h-12 w-full" aria-hidden="true" />
      <Skeleton className="h-12 w-full" aria-hidden="true" />
    </div>
  );
}
