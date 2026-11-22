import assert from "node:assert/strict";
import { test } from "node:test";
import { demoIncomingRequestCount, handleDemoCollaboration } from "../lib/browser-demo-collaboration";
import { createBrowserDemoRequest } from "../lib/browser-demo-http";
import { getDemoCard, moderateDemoCard, nextDemoTimestamp, readBrowserDemo, selectDemoProfile, updateDemoCard, writeBrowserDemo } from "../lib/browser-demo";
import { editorialContentSchema } from "../lib/editorial";
import type { InformationRequest } from "../lib/information-requests";
import type { WorkData } from "../lib/work-data";
import type { WorkflowPresentation } from "../lib/workflow-models";

function fixture() {
  const rows = new Map<string, string>();
  const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => rows.set(key, value) };
  const state = () => readBrowserDemo(storage);
  const mount = () => createBrowserDemoRequest(storage, state(), [handleDemoCollaboration]);
  let request = mount();
  const save = (next: ReturnType<typeof state>) => writeBrowserDemo(storage, next);
  return {
    state, save,
    switchTo: (profile: string) => {
      save(selectDemoProfile(state(), profile));
      request = mount();
    },
    call: (url: string, method = "GET", payload?: unknown) =>
      request(url, { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }),
  };
}

async function json<T>(response: Response, status = 200): Promise<T> {
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}

test("demo request grants recipient access, detects stale updates and follows local card moderation", async (context) => {
  context.mock.method(globalThis, "fetch", () => assert.fail("No demo collaboration may contact a server"));
  const { state, save, switchTo, call } = fixture();
  const input = {
    operationId: crypto.randomUUID(), recipientUniversityId: "csu", subject: "Учебный запрос",
    question: "Уточните назначение учебной лаборатории.", responsibleId: "demo-owner-csu",
  };
  const draft = await json<InformationRequest>(await call("/api/requests", "POST", input), 201);
  const url = "/api/requests/" + draft.id;
  assert.equal(draft.status, "open");
  assert.equal(draft.authorId, "demo-pr-midis");
  assert.equal((await json<InformationRequest>(await call("/api/requests", "POST", input), 201)).id, draft.id);
  assert.equal(state().requests?.length, 1);
  assert.equal((await call("/api/requests", "POST", { ...input, subject: "Другая тема" })).status, 409);
  const answer = { action: "answer", operationId: crypto.randomUUID(), revision: 0, answer: "Учебная лаборатория открыта для студентов.", evidenceUrl: "https://example.invalid/evidence" };
  assert.equal((await call(url, "PATCH", answer)).status, 403);
  switchTo("demo-pr-susu");
  assert.deepEqual((await json<{ items: InformationRequest[] }>(await call("/api/requests"))).items, []);
  assert.equal((await call(url)).status, 404);
  assert.equal((await call(url, "PATCH", answer)).status, 404);

  switchTo("demo-owner-csu");
  assert.equal(demoIncomingRequestCount(state()), 1);
  const { item, people } = await json<{ item: InformationRequest; people: { id: string }[] }>(await call(url));
  assert.equal(item.id, draft.id);
  assert.ok(people.some(person => person.id === "demo-owner-csu"));
  assert.ok(!people.some(person => person.id === "demo-pr-midis"));
  const inbox = await json<WorkData>(await call("/api/work"));
  assert.ok(inbox.items.some(entry => entry.href === `/requests?request=${draft.id}` && entry.state === "action"));
  const joined = await json<InformationRequest>(await call(url, "PATCH", { action: "join", operationId: crypto.randomUUID(), revision: 0 }));
  assert.ok(joined.participantIds?.includes("demo-owner-csu"));
  assert.equal((await call(url, "PATCH", answer)).status, 409);
  const answered = await json<InformationRequest>(await call(url, "PATCH", { ...answer, revision: 1 }));
  assert.equal(answered.status, "answered");
  assert.equal(demoIncomingRequestCount(state()), 0);
  switchTo("demo-pr-midis");
  const submitted = await json<InformationRequest>(await call(url, "PATCH", { action: "submit", operationId: crypto.randomUUID(), revision: 2 }));
  assert.equal(submitted.status, "submitted");
  assert.ok(submitted.candidateCardId);
  assert.equal(getDemoCard(state(), submitted.candidateCardId)?.status, "pending");
  switchTo("demo-admin");
  const queue = await json<WorkData>(await call("/api/work"));
  assert.ok(queue.items.some(entry => entry.kind === "card-approval" && entry.href.includes(submitted.candidateCardId!)));
  save(moderateDemoCard(state(), submitted.candidateCardId, "return"));
  switchTo("demo-pr-midis");
  assert.equal((await json<{ item: InformationRequest }>(await call(url))).item.status, "rejected");
});

test("demo package stores approved versions and redacts an attached draft for a participant", async (context) => {
  context.mock.method(globalThis, "fetch", () => assert.fail("No demo collaboration may contact a server"));
  const { state, save, switchTo, call } = fixture();
  const now = new Date().toISOString();
  save({
    ...state(), editorialRows: [{
      document: {
        id: "demo-private-draft", originalId: "demo-private-draft", ownerId: "demo-pr-midis", ownerName: "Учебный автор",
        channel: "Оригинал", version: 1, revisionId: "revision-1", status: "draft", approvedRevisionId: null,
        submittedRevisionId: null, content: editorialContentSchema.parse({ title: "Личный текст" }), events: [], createdAt: now, updatedAt: now,
      }, revisions: [],
    }],
  });
  const available = await json<WorkData>(await call("/api/work"));
  const { cardId, versionId, title } = available.sources[0];
  const input = {
    operationId: crypto.randomUUID(), kind: "package", title: "Учебный инфоповод",
    responsibleId: "demo-pr-midis", participantIds: ["demo-owner-csu"],
    sources: [{ cardId, versionId }], documentIds: ["demo-private-draft"],
  };
  assert.equal((await call("/api/workflows", "POST", { ...input, sources: [{ cardId, versionId: "forged-version" }] })).status, 404);
  const entry = await json<WorkflowPresentation>(await call("/api/workflows", "POST", input), 201);
  assert.equal(entry.materialDetails[0].title, "Личный текст");
  const previousSource = getDemoCard(state(), cardId);
  assert.ok(previousSource);
  save(updateDemoCard(state(), { ...previousSource, title: "Изменившийся источник", updatedAt: nextDemoTimestamp(previousSource.updatedAt) }));
  const url = "/api/workflows/" + entry.record.id;
  switchTo("demo-pr-susu");
  assert.equal((await call(url)).status, 404);
  switchTo("demo-owner-csu");
  const visible = await json<WorkflowPresentation>(await call(url));
  assert.deepEqual(visible.materialDetails, []);
  assert.equal(visible.record.kind, "package");
  assert.deepEqual(visible.record.documentIds, []);
  assert.deepEqual(visible.sourceDetails.find(source => source.cardId === cardId), { cardId, versionId, title });
  assert.equal((await call(url, "PATCH", { action: "edit", title: "Чужие правки", version: 1, operationId: crypto.randomUUID() })).status, 403);
  switchTo("demo-guest");
  assert.equal((await call("/api/work")).status, 403);
  assert.equal((await call("/api/unknown")).status, 404);
});

test("demo dispute resolves once and concurrent submissions cannot replace the decision", async (context) => {
  context.mock.method(globalThis, "fetch", () => assert.fail("No demo collaboration may contact a server"));
  const { call, switchTo } = fixture();
  const evidence = {
    object: "Учебный объект", statement: "В источнике указано первое значение.", state: "actual",
    year: 2025, unit: "единиц", url: "https://example.invalid/first",
  };
  const entry = await json<WorkflowPresentation>(await call("/api/workflows", "POST", {
    kind: "dispute", title: "Разбор учебных сведений", operationId: crypto.randomUUID(),
    responsibleId: "demo-owner-csu", evidence: [evidence, { ...evidence, url: "https://example.invalid/second" }],
  }), 201);
  const url = "/api/workflows/" + entry.record.id;
  const answer = { action: "resolve", version: 1, operationId: crypto.randomUUID(), decision: "Принято значение первого источника." };
  assert.equal((await call(url, "PATCH", answer)).status, 403);
  switchTo("demo-owner-csu");
  const competing = { ...answer, operationId: crypto.randomUUID(), decision: "Принято значение второго источника." };
  const [first, second] = await Promise.all([call(url, "PATCH", answer), call(url, "PATCH", competing)]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  const winner = first.ok ? answer : competing;
  assert.equal((await call(url, "PATCH", winner)).status, 200);
  const resolved = await json<WorkflowPresentation & { events: { version: number }[] }>(await call(url));
  assert.equal(resolved.record.kind, "dispute");
  assert.equal(resolved.record.status, "resolved");
  assert.equal(resolved.record.decision, winner.decision);
  assert.deepEqual(resolved.events.map(event => event.version), [1, 2]);
  const reopened = await json<WorkflowPresentation>(await call(url, "PATCH", { action: "reopen", operationId: crypto.randomUUID(), version: 2, reason: "Появились новые учебные сведения." }));
  assert.equal(reopened.record.kind, "dispute");
  assert.equal(reopened.record.status, "open");
});
