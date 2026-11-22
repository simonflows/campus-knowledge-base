import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { requireFixtureDatabase } from "./qa-fixture";
import { installPilotFixture } from "./pilot-fixture";
import { createWorkflowSchema, workflowMutationSchema } from "../lib/workflow";
import { createWorkflowRecord, getWorkflowRecord, mutateWorkflowRecord, getWorkflowEvents } from "../lib/workflow-models";
import { createEditorial } from "../lib/editorial-models";
import { createEditorialSchema } from "../lib/editorial";

test("workflow records survive readback, retries, competing edits and preserve their decision history", async () => {
  await requireFixtureDatabase();
  const people = installPilotFixture();
  const author = people.account("demo-pr-midis"), responsible = people.account("demo-owner-midis"), outsider = people.account("demo-pr-susu");
  const input = createWorkflowSchema.parse({ kind: "package", operationId: randomUUID(), title: "QA пакет инфоповода", responsibleId: responsible.id });
  const created = await createWorkflowRecord(author, input);
  const read = await getWorkflowRecord(author, created.id).catch(() => null);
  assert.equal(read?.record.title, input.title, "a successful create must really persist the record");
  assert.equal((await createWorkflowRecord(author, input)).id, created.id);
  await assert.rejects(() => getWorkflowRecord(outsider, created.id), (e: Error & { status?: number }) => e.status === 404);
  const outcomes = await Promise.allSettled(["Первая правка", "Вторая правка"].map(title => mutateWorkflowRecord(author, created.id,
    workflowMutationSchema.parse({ action: "edit", operationId: randomUUID(), version: 1, title }))));
  assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(item => item.status === "rejected" && item.reason.status === 409).length, 1);
  assert.equal((await getWorkflowEvents(author, created.id)).length, 2, "creation and the sole successful edit are auditable");
  const evidence = { statement: "Две разные границы объекта", object: "Объект кампуса", year: 2026, unit: "м²", state: "plan", url: "https://example.org/source" };
  const conflict = await createWorkflowRecord(author, createWorkflowSchema.parse({ kind: "dispute", operationId: randomUUID(), title: "QA спорные источники", responsibleId: responsible.id, evidence: [evidence, { ...evidence, statement: "Иная площадь объекта" }] }));
  const resolution = workflowMutationSchema.parse({ action: "resolve", operationId: randomUUID(), version: 1, decision: "Сначала запросить у владельца документ с составом объектов." });
  const resolved = await mutateWorkflowRecord(responsible, conflict.id, resolution);
  assert.equal(resolved.kind === "dispute" && resolved.status, "resolved");
  await mutateWorkflowRecord(responsible, conflict.id, resolution);
  const events = await getWorkflowEvents(author, conflict.id);
  assert.equal(events.length, 2);
  assert.equal(events[1].message, resolution.action === "resolve" ? resolution.decision : "");
});

test("membership in a news package does not disclose another author's private draft", async () => {
  await requireFixtureDatabase();
  const people = installPilotFixture();
  const author = people.account("demo-pr-midis"), colleague = people.account("demo-owner-midis");
  const draft = await createEditorial(author, createEditorialSchema.parse({ content: { title: "Личный невыпущенный материал" } }));
  const pack = await createWorkflowRecord(author, createWorkflowSchema.parse({ kind: "package", operationId: randomUUID(), title: "QA пакет с личным черновиком", responsibleId: colleague.id, documentIds: [draft.id] }));
  assert.equal((await getWorkflowRecord(author, pack.id)).materialDetails[0].title, "Личный невыпущенный материал");
  const visible = await getWorkflowRecord(colleague, pack.id);
  assert.equal(visible.record.kind, "package");
  if (visible.record.kind === "package") assert.deepEqual(visible.record.documentIds, []);
  assert.deepEqual(visible.materialDetails, []);
  await assert.rejects(() => mutateWorkflowRecord(colleague, pack.id, workflowMutationSchema.parse({ action: "add-document", operationId: randomUUID(), version: 1, documentId: draft.id })), (e: Error & { status?: number }) => e.status === 404);
  assert.equal((await getWorkflowRecord(author, pack.id)).record.version, 1);
});
