"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { ArrowRight, CalendarClock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { WorkData } from "@/lib/work-data";
import { WorkEmpty, WorkSelect } from "./work-primitives";
import { defaultFilters, filterWorkItems, formatWorkDay, workCategories, type WorkFilters } from "./work-state";
import styles from "./workspace.module.css";

export function WorkQueue({ data }: { data: WorkData }) {
  const [filters, setFilters] = useState(defaultFilters);
  const today = new Date().toISOString().slice(0, 10);
  const update = (field: keyof WorkFilters) => (value: string) => setFilters((current) => ({ ...current, [field]: value }));
  const filtered = filterWorkItems(data.items, filters, data.user.id, today);
  const categories = [...new Set(data.items.map(({ kind }) => kind))];
  const people = [...new Map(data.items.flatMap(({ responsibleId, responsibleName }) => responsibleId && responsibleId !== data.user.id
    ? [[responsibleId, responsibleName] as const] : [])).entries()].sort((a, b) => a[1].localeCompare(b[1], "ru"));
  const hasFilters = Object.values(filters).some((value) => value !== "all");

  return (
    <section className="desk-panel" aria-labelledby="work-queue-title">
      <header className={styles.panelHeading}>
        <div>
          <h2 id="work-queue-title">Очередь задач</h2>
          {data.items.length > 0 && <p className={styles.muted}>К действию: {data.items.filter((item) => item.state === "action").length} · В ожидании: {data.items.filter((item) => item.state === "waiting").length}</p>}
        </div>
        <Button variant="outline" nativeButton={false} render={<Link href="/requests" />}>
          Межвузовские запросы <ArrowRight data-icon="inline-end" aria-hidden="true" />
        </Button>
      </header>
      {data.items.length > 0 && (
        <div className={styles.filters}>
          <WorkSelect label="Категория" value={filters.category} onChange={update("category")}
            options={[{ value: "all", label: "Все категории" }, ...categories.map((value) => ({ value, label: workCategories[value] ?? "Задача" }))]} />
          <WorkSelect label="Ответственный" value={filters.responsible} onChange={update("responsible")}
            options={[{ value: "all", label: "Все ответственные" }, { value: "mine", label: "Только мои" }, { value: "unassigned", label: "Без назначения" },
              ...people.map(([value, label]) => ({ value, label }))]} />
          <WorkSelect label="Срок" value={filters.due} onChange={update("due")}
            options={[{ value: "all", label: "Все сроки" }, { value: "overdue", label: "Просрочено" },
              { value: "today", label: "Сегодня" }, { value: "week", label: "На ближайшую неделю" }, { value: "none", label: "Без срока" }]} />
          <WorkSelect label="Состояние" value={filters.state} onChange={update("state")}
            options={[{ value: "all", label: "Все состояния" }, { value: "action", label: "К действию" }, { value: "waiting", label: "В ожидании" }]} />
        </div>
      )}
      {hasFilters && filtered.length > 0 && (
        <div className={styles.filterCount}>
          <span aria-live="polite">Показано {filtered.length} из {data.items.length}</span>
          <Button variant="ghost" size="sm" onClick={() => setFilters(defaultFilters)}>Сбросить фильтры</Button>
        </div>
      )}
      {!filtered.length ? (
        <WorkEmpty title={hasFilters ? "Задач по этим фильтрам нет" : "Пока нет задач"}
          action={hasFilters && <Button variant="outline" onClick={() => setFilters(defaultFilters)}>Сбросить фильтры</Button>}>
          {!hasFilters && "Здесь появятся задачи по согласованию, запросам и сверке источников."}
        </WorkEmpty>
      ) : (
        <ul className={styles.queueList}>
          {filtered.map((item) => (
            <li key={item.id} className={styles.queueRow}>
              <div>
                <div className={styles.rowTags}>
                  <span>{workCategories[item.kind] ?? "Задача"}</span>
                  {item.state === "waiting" && <Badge variant="outline">В ожидании</Badge>}
                </div>
                <h3><Link href={item.href}>{item.title} <ArrowRight size={15} aria-hidden="true" /></Link></h3>
                <p>{item.reason}</p>
              </div>
              <div className={styles.queueMeta}>
                <span>{item.responsibleName || "Ответственный не назначен"}</span>
                {item.dueDate
                  ? <span className={styles.due} data-overdue={item.dueDate < today || undefined}>
                    <CalendarClock size={15} aria-hidden="true" />
                    {item.dueDate < today && "Просрочено · "}<time dateTime={item.dueDate}>{formatWorkDay(item.dueDate)}</time>
                  </span>
                  : <span>Без срока</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CoverageOverview({ rows }: { rows: NonNullable<WorkData["coverage"]> }) {
  const [university, setUniversity] = useState("all");
  const [query, setQuery] = useState("");
  const searchId = useId();
  const normalized = query.trim().toLocaleLowerCase("ru");
  const visible = rows.filter((row) => university === "all" || row.universityId === university)
    .map((row) => ({ ...row, gaps: row.gaps.filter((gap) => gap.title.toLocaleLowerCase("ru").includes(normalized)) }))
    .filter((row) => !normalized || row.gaps.length > 0);

  return (
    <section className="desk-panel" aria-labelledby="work-coverage-title">
      <header className={styles.panelHeading}>
        <div><h2 id="work-coverage-title">Полнота данных вузов</h2><p className={styles.muted}>Каких карточек и сведений не хватает для работы.</p></div>
      </header>
      <div className={styles.coverageFilters}>
        <WorkSelect label="Вуз" value={university} onChange={setUniversity}
          options={[{ value: "all", label: "Все вузы" }, ...rows.map(({ universityId: value, name: label }) => ({ value, label }))]} />
        <Field>
          <FieldLabel htmlFor={searchId}>Карточка</FieldLabel>
          <Input id={searchId} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="По названию" />
        </Field>
      </div>
      {visible.length ? (
        <div className={styles.coverageRows}>
          {visible.map(({ universityId, name, cards, gaps }) => (
            <section key={universityId} aria-labelledby={`coverage-${universityId}`} className={styles.coverageRow}>
              <header>
                <h3 id={`coverage-${universityId}`}>{name}</h3>
                <p className={styles.muted}>Карточек: {cards}</p>
              </header>
              {gaps.length === 0 ? <p className={styles.muted}>Пробелов по этим критериям нет.</p> : (
                <ul className={styles.lineList}>
                  {gaps.map(({ cardId, title, reason }) => (
                    <li key={`${cardId ?? "missing"}:${reason}`}>
                      {cardId ? <Link className={styles.textLink} href={`/knowledge?card=${encodeURIComponent(cardId)}`}>{title}</Link> : <strong>{title}</strong>}
                      <p>{reason}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      ) : <WorkEmpty title="Карточек по этому поиску нет" />}
    </section>
  );
}
