"use client";

import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { StructuredMetric } from "@/lib/knowledge";

export function UniversityMetricsEditor({
  metrics,
  onChange,
}: {
  metrics: StructuredMetric[];
  onChange: (metrics: StructuredMetric[]) => void;
}) {
  const update = (index: number, patch: Partial<StructuredMetric>) =>
    onChange(
      metrics.map((metric, position) =>
        position === index ? { ...metric, ...patch } : metric
      )
    );
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="mb-2 font-semibold">
        Показатели вуза с документами
      </legend>
      <p className="text-sm text-muted-foreground">
        Факт и план хранятся раздельно по годам. Вносите только сведения из
        документа; пустая карточка не подтверждает чисел.
      </p>
      {metrics.map((metric, index) => (
        <fieldset
          key={metric.id}
          className="grid gap-3 rounded-xl border p-4 sm:grid-cols-2"
        >
          <legend className="px-1 text-sm">Показатель {index + 1}</legend>
          {(
            [
              ["label", "Название показателя", "text"],
              ["value", "Значение", "number"],
              ["unit", "Единица (мест, студентов…)", "text"],
              ["year", "Год", "number"],
              ["evidenceUrl", "Документ (HTTPS-ссылка)", "url"],
              ["verifiedAt", "Дата проверки", "date"],
              ["owner", "Ответственный за проверку", "text"],
            ] as const
          ).map(([key, label, type]) => (
            <label
              className="flex flex-col gap-2 text-sm"
              key={key}
              htmlFor={`${metric.id}-${key}`}
            >
              {label}
              <Input
                id={`${metric.id}-${key}`}
                type={type}
                value={
                  typeof metric[key] === "number" && Number.isNaN(metric[key])
                    ? ""
                    : metric[key]
                }
                required
                min={key === "year" ? 1900 : key === "value" ? 0 : undefined}
                step={key === "value" ? "any" : undefined}
                onChange={(event) =>
                  update(index, {
                    [key]:
                      type === "number"
                        ? event.target.value === ""
                          ? Number.NaN
                          : Number(event.target.value)
                        : event.target.value,
                  })
                }
              />
            </label>
          ))}
          <label
            className="flex flex-col gap-2 text-sm"
            htmlFor={`${metric.id}-kind`}
          >
            Статус
            <select
              id={`${metric.id}-kind`}
              className="h-10 rounded-md border bg-background px-3"
              value={metric.kind}
              onChange={(event) =>
                update(index, {
                  kind: event.target.value as StructuredMetric["kind"],
                })
              }
            >
              <option value="actual">Факт</option>
              <option value="plan">План</option>
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              onChange(metrics.filter((_, position) => position !== index))
            }
          >
            <X data-icon="inline-start" />
            Убрать показатель
          </Button>
        </fieldset>
      ))}
      <Button
        type="button"
        variant="outline"
        onClick={() =>
          onChange([
            ...metrics,
            {
              id: crypto.randomUUID(),
              label: "",
              value: Number.NaN,
              unit: "",
              year: new Date().getUTCFullYear(),
              kind: "actual",
              evidenceUrl: "",
              verifiedAt: new Date().toISOString().slice(0, 10),
              owner: "",
            },
          ])
        }
      >
        <Plus data-icon="inline-start" />
        Добавить показатель
      </Button>
    </fieldset>
  );
}
