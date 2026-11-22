import type { WorkItem } from "@/lib/work-queue";
import type { WorkflowPresentation } from "@/lib/workflow-models";

export type WorkSection = "queue" | "packages" | "disputes" | "coverage";
export type WorkFilters = { category: string; responsible: string; due: string; state: string };
export const defaultFilters: WorkFilters = { category: "all", responsible: "all", due: "all", state: "all" };

export const workCategories: Record<string, string> = {
  "card-approval": "Подтверждение карточки", "card-return": "Карточка на доработке",
  "card-request": "Правка карточки", freshness: "Срок сверки", "article-approval": "Согласование текста",
  "article-return": "Текст на доработке", "source-change": "Сверка источников",
  request: "Межвузовский запрос", package: "Инфоповод", dispute: "Разбор источников",
};

export function filterWorkItems(items: WorkItem[], filter: WorkFilters, viewer: string, today: string) {
  const cutoff = new Date(today + "T00:00:00Z");
  cutoff.setUTCDate(cutoff.getUTCDate() + 7);
  const weekEnd = cutoff.toISOString().slice(0, 10);
  return items.filter((item) => {
    if (filter.category !== "all" && item.kind !== filter.category) return false;
    if (filter.state !== "all" && item.state !== filter.state) return false;
    if (filter.responsible === "mine" && item.responsibleId !== viewer) return false;
    if (filter.responsible === "unassigned" && item.responsibleId !== null) return false;
    if (!["all", "mine", "unassigned"].includes(filter.responsible) && item.responsibleId !== filter.responsible) return false;
    const due = item.dueDate;
    if (filter.due === "overdue") return Boolean(due && due < today);
    if (filter.due === "today") return due === today;
    if (filter.due === "week") return Boolean(due && due >= today && due <= weekEnd);
    if (filter.due === "none") return due === null;
    return true;
  });
}

export type OperationAttempt = { signature: string; operationId: string; version: number | undefined };

export function operationAttempt(
  previous: OperationAttempt | undefined,
  payload: object,
  version: number | undefined,
  makeId = () => crypto.randomUUID(),
): OperationAttempt {
  const signature = JSON.stringify(payload);
  return previous?.signature === signature ? previous : { signature, operationId: makeId(), version };
}

export function keepNewestRecord(previous: WorkflowPresentation | undefined, received: WorkflowPresentation) {
  if (previous?.record.id === received.record.id && previous.record.version > received.record.version) {
    return previous;
  }
  return received;
}

export function workHref(section: WorkSection, record?: string, create = false) {
  const params = new URLSearchParams();
  if (section !== "queue") params.set("tab", section);
  if (record) params.set("record", record);
  if (create) params.set("new", "1");
  return params.size ? `/work?${params}` : "/work";
}

export function normalizeWorkSection(value: string | undefined, admin: boolean): WorkSection {
  if (value === "packages" || value === "disputes" || (value === "coverage" && admin)) return value;
  return "queue";
}

export function formatWorkDay(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(value));
}

export class WorkRequestError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

export async function requestWork<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    ...(init.body && { headers: { "Content-Type": "application/json" } }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw new WorkRequestError(data?.error || "Не удалось выполнить действие. Попробуйте ещё раз.", response.status);
  }
  return data as T;
}
