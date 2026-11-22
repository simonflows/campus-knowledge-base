import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkItem } from "../../lib/work-queue";
import type { WorkflowPresentation } from "../../lib/workflow-models";
import { defaultFilters, filterWorkItems, keepNewestRecord, operationAttempt } from "./work-state";

const base: WorkItem = {
  id: "action", kind: "article-approval", title: "Текст", reason: "Нужно согласование",
  href: "/editor?draft=one", responsibleId: "author", responsibleName: "Редактор",
  state: "action", dueDate: "2026-11-21",
};
const items: WorkItem[] = [base, {
  ...base, id: "waiting", kind: "request", responsibleId: null, state: "waiting", dueDate: null,
}, { ...base, id: "due", kind: "package", responsibleId: "other", dueDate: "2026-11-29" }];

test("queue applies person, category, time and waiting filters together", () => {
  assert.deepEqual(filterWorkItems(items, {
    category: "request", responsible: "unassigned", due: "none", state: "waiting",
  }, "author", "2026-11-22").map(item => item.id), ["waiting"]);
  assert.deepEqual(filterWorkItems(items, {
    ...defaultFilters, responsible: "mine", due: "overdue",
  }, "author", "2026-11-22").map(item => item.id), ["action"]);
  assert.deepEqual(filterWorkItems(items, {
    ...defaultFilters, due: "week",
  }, "author", "2026-11-22").map(item => item.id), ["due"]);
});

test("a retry sends the original operation and version until the action changes", () => {
  const first = operationAttempt(undefined, { title: "Исправление" }, 1, () => "a");
  const retry = operationAttempt(first, { title: "Исправление" }, 2, () => "b");
  assert.equal(retry.operationId, "a");
  assert.equal(retry.version, 1);
  const edited = operationAttempt(first, { title: "Другое исправление" }, 2, () => "b");
  assert.equal(edited.operationId, "b");
  assert.equal(edited.version, 2);
});

test("a read with an older version cannot replace a successful mutation", () => {
  const update = { record: { id: "one", version: 3, title: "Изменено" } } as WorkflowPresentation;
  const delayed = { record: { id: "one", version: 2, title: "Старое" } } as WorkflowPresentation;
  assert.equal(keepNewestRecord(update, delayed).record.title, "Изменено");
  assert.equal(keepNewestRecord(delayed, update).record.title, "Изменено");
});
