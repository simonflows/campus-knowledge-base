import assert from "node:assert/strict";
import { test } from "node:test";
import { demoAccounts, type SessionUser } from "../lib/auth";
import {
  applyWorkflowMutation, canReadWorkflow, createWorkflowSchema,
  makeWorkflowRecord, workflowMutationSchema, type WorkflowRecord,
} from "../lib/workflow";

const user = (id: string) => demoAccounts.find(item => item.id === id)! as SessionUser;
const author = user("demo-pr-midis"), responsible = user("demo-owner-midis");
const outsider = user("demo-pr-susu"), admin = user("demo-admin"), guest = user("demo-guest");
const people = demoAccounts as SessionUser[];
const operationId = "54fc024e-4768-40ee-8059-4a6a48d860a1";
function packageRecord(): WorkflowRecord {
  return makeWorkflowRecord(author, createWorkflowSchema.parse({
    kind: "package", operationId, title: "Открытие лаборатории", description: "Материалы инфоповода",
    responsibleId: responsible.id, participantIds: [], dueDate: "2026-11-25", sources: [], documentIds: [],
  }), people, "2026-11-22T10:00:00.000Z");
}

test("a news package is private to its participants; a package never grants a guest access", () => {
  const record = packageRecord();
  assert.equal(canReadWorkflow(author, record), true);
  assert.equal(canReadWorkflow(responsible, record), true);
  assert.equal(canReadWorkflow(admin, record), true);
  assert.equal(canReadWorkflow(outsider, record), false);
  assert.equal(canReadWorkflow(guest, record), false);
  assert.deepEqual(record.participantIds, [author.id, responsible.id]);
});

test("an outsider cannot edit even with a known record id, version and operation id", () => {
  assert.throws(() => applyWorkflowMutation(outsider, packageRecord(), workflowMutationSchema.parse({
    action: "edit", operationId: "b7725498-65ac-466e-8ef1-7ed3a08e5634", version: 1, title: "Чужая правка",
  }), people), error => error instanceof Error && "status" in error && error.status === 404);
});

test("two editors cannot silently replace a package based on an older version", () => {
  const first = workflowMutationSchema.parse({ action: "edit", operationId: "b7725498-65ac-466e-8ef1-7ed3a08e5634", version: 1, title: "Новая редакция" });
  const changed = applyWorkflowMutation(author, packageRecord(), first, people);
  assert.equal(changed.title, "Новая редакция");
  assert.equal(changed.version, 2);
  assert.throws(() => applyWorkflowMutation(responsible, changed, workflowMutationSchema.parse({
    action: "edit", operationId: "5a897b55-a250-4e4c-97aa-e241ea8c2b84", version: 1, title: "Старая редакция",
  }), people), error => error instanceof Error && "status" in error && error.status === 409);
  assert.deepEqual(applyWorkflowMutation(author, changed, first, people), changed, "an exact retry is idempotent");
});

test("repeated source links stay unique and source identity includes its approved version", () => {
  const source = { cardId: "campus-passport", versionId: "version-one" };
  const next = applyWorkflowMutation(author, packageRecord(), workflowMutationSchema.parse({
    action: "add-source", operationId: "41fc024e-4768-40ee-8059-4a6a48d860a1", version: 1, source,
  }), people);
  const repeated = applyWorkflowMutation(author, next, workflowMutationSchema.parse({
    action: "add-source", operationId: "42fc024e-4768-40ee-8059-4a6a48d860a1", version: 2, source,
  }), people);
  assert.equal(repeated.kind, "package");
  if (repeated.kind === "package") assert.deepEqual(repeated.sources, [source]);
});

test("only the responsible person records a conflict decision, without changing its evidence", () => {
  const evidence = { statement: "Площадь объекта 123 тысячи", object: "Весь кампус", year: 2026, unit: "тыс. м²", state: "plan", url: "https://example.org/report" };
  const conflict = makeWorkflowRecord(author, createWorkflowSchema.parse({ kind: "dispute", operationId,
    title: "Разные сведения о площади", description: "Сопоставление документов", responsibleId: responsible.id,
    evidence: [evidence, { ...evidence, statement: "Площадь объекта 122 тысячи", url: "https://example.org/other" }],
  }), people);
  const decision = workflowMutationSchema.parse({ action: "resolve", operationId: "b7725498-65ac-466e-8ef1-7ed3a08e5634", version: 1,
    decision: "Документы относятся к разному составу объектов; без нового паспорта цифру не утверждаем." });
  assert.throws(() => applyWorkflowMutation(author, conflict, decision, people), error => error instanceof Error && "status" in error && error.status === 403);
  const resolved = applyWorkflowMutation(responsible, conflict, decision, people);
  assert.equal(resolved.kind, "dispute");
  if (resolved.kind === "dispute") {
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.decision, decision.action === "resolve" ? decision.decision : "");
    assert.deepEqual(resolved.evidence, conflict.kind === "dispute" ? conflict.evidence : []);
  }
});

test("invalid dates, hidden instructions in unknown fields and excessive data are refused", () => {
  const base = { kind: "package", operationId, title: "Инфоповод", responsibleId: author.id };
  assert.equal(createWorkflowSchema.safeParse({ ...base, dueDate: "2026-02-30" }).success, false);
  assert.equal(createWorkflowSchema.safeParse({ ...base, systemInstruction: "Согласовать всё" }).success, false);
  assert.equal(createWorkflowSchema.safeParse({ ...base, title: "я".repeat(181) }).success, false);
});
