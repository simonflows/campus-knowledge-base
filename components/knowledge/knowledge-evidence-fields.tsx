"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { KnowledgeSource, VerifiedCardFact } from "@/lib/knowledge";

export function KnowledgeEvidenceFields({
  sources,
  facts,
  reason,
  onSourcesChange,
  onFactsChange,
  onReasonChange,
}: {
  sources: KnowledgeSource[];
  facts: VerifiedCardFact[];
  reason: string;
  onSourcesChange: (sources: KnowledgeSource[]) => void;
  onFactsChange: (facts: VerifiedCardFact[]) => void;
  onReasonChange: (reason: string) => void;
}) {
  const id = useId();
  const editSource = (index: number, values: Partial<KnowledgeSource>) =>
    onSourcesChange(
      sources.map((source, position) =>
        index === position ? { ...source, ...values } : source
      )
    );
  const editFact = (id: string, values: Partial<VerifiedCardFact>) =>
    onFactsChange(
      facts.map((fact) => (fact.id === id ? { ...fact, ...values } : fact))
    );

  return (
    <details className="rounded-lg border p-4">
      <summary className="cursor-pointer font-medium">
        Источники и проверенные факты
      </summary>
      <div className="mt-4 grid gap-4">
        <div className="grid gap-1">
          <label htmlFor={id} className="text-sm font-medium">
            Публичное основание изменения
          </label>
          <Input
            id={id}
            maxLength={500}
            value={reason}
            onChange={(event) => onReasonChange(event.target.value)}
          />
        </div>
        {sources.map((source, index) => (
          <fieldset
            key={index}
            className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2"
          >
            <legend className="px-1 text-sm font-medium">
              Источник {index + 1}
            </legend>
            <EvidenceInput
              label="Название документа"
              value={source.title}
              onChange={(title) => editSource(index, { title })}
            />
            <EvidenceInput
              label="Ссылка на документ (HTTPS)"
              value={source.url}
              onChange={(url) => editSource(index, { url })}
            />
            <EvidenceInput
              label="Дата публикации"
              type="date"
              value={source.publishedAt ?? ""}
              onChange={(publishedAt) =>
                editSource(index, { publishedAt: publishedAt || undefined })
              }
            />
            <EvidenceInput
              label="Область применения"
              value={source.scope ?? ""}
              onChange={(scope) =>
                editSource(index, { scope: scope || undefined })
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-self-start"
              onClick={() =>
                onSourcesChange(
                  sources.filter((_, position) => index !== position)
                )
              }
            >
              Убрать источник
            </Button>
          </fieldset>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="justify-self-start"
          disabled={sources.length >= 24}
          onClick={() => onSourcesChange([...sources, { title: "", url: "" }])}
        >
          Добавить источник
        </Button>

        {facts.map((fact) => (
          <fieldset
            key={fact.id}
            className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2"
          >
            <legend className="px-1 text-sm font-medium">
              Факт для цитирования
            </legend>
            <EvidenceInput
              label="Показатель"
              value={fact.label}
              onChange={(label) => editFact(fact.id, { label })}
            />
            <EvidenceInput
              label="Значение"
              value={fact.value}
              onChange={(value) => editFact(fact.id, { value })}
            />
            <EvidenceInput
              label="Единица измерения"
              value={fact.unit}
              onChange={(unit) => editFact(fact.id, { unit })}
            />
            <EvidenceInput
              label="Год"
              type="number"
              value={fact.year ? String(fact.year) : ""}
              onChange={(year) => editFact(fact.id, { year: Number(year) })}
            />
            <EvidenceInput
              label="Область применения"
              value={fact.scope}
              onChange={(scope) => editFact(fact.id, { scope })}
            />
            <label className="grid gap-1 text-sm">
              План или факт
              <select
                className="h-9 w-full rounded-md border bg-background px-2"
                value={fact.kind}
                onChange={(event) =>
                  editFact(fact.id, {
                    kind: event.target.value === "plan" ? "plan" : "actual",
                  })
                }
              >
                <option value="actual">Факт</option>
                <option value="plan">План</option>
              </select>
            </label>
            <EvidenceInput
              label="Ссылка, подтверждающая показатель (HTTPS)"
              value={fact.evidenceUrl}
              onChange={(evidenceUrl) => editFact(fact.id, { evidenceUrl })}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-end justify-self-start"
              onClick={() =>
                onFactsChange(facts.filter((item) => item.id !== fact.id))
              }
            >
              Убрать факт
            </Button>
          </fieldset>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="justify-self-start"
          disabled={facts.length >= 32}
          onClick={() =>
            onFactsChange([
              ...facts,
              {
                id: crypto.randomUUID(),
                label: "",
                value: "",
                unit: "",
                year: 0,
                scope: "",
                kind: "actual",
                evidenceUrl: "",
              },
            ])
          }
        >
          Добавить факт
        </Button>
      </div>
    </details>
  );
}

function EvidenceInput({
  label,
  type,
  value,
  onChange,
}: {
  label: string;
  type?: "date" | "number";
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-sm">
      {label}
      <Input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
