import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { CardUsage } from "../lib/card-usage";
import type { EditorialDocument } from "../lib/editorial";
import type { EditorialReadiness } from "../lib/editorial-readiness";
import type { InformationRequest } from "../lib/information-requests";
import type { KnowledgeCard } from "../lib/knowledge";
import type { ApprovedCardVersion } from "../lib/knowledge-versions";
import type { WorkData } from "../lib/work-data";
import type { WorkflowEvent } from "../lib/workflow";
import type { WorkflowPresentation } from "../lib/workflow-models";
import { requireFixtureServer } from "./qa-fixture";

type Credentials = (profile: string) => { accountId: string; accessKey: string };
type Send = (path: string, options?: {
  method?: "POST" | "PUT" | "PATCH";
  body?: object;
  rawBody?: string;
  ifMatch?: string;
}) => Promise<Response>;
type FixtureUser = { send: Send; id: string };
type WorkflowDetail = WorkflowPresentation & { events: WorkflowEvent[] };
type CardHistory = {
  currentVersionId: string | null;
  cardUpdatedAt: string;
  canVerifyFreshness: boolean;
  versions: Pick<ApprovedCardVersion, "id" | "legacyBaseline">[];
  responsibleId?: string;
};

function client(base: string, cookie?: string): Send {
  return (path, { method, body, rawBody, ifMatch } = {}) => fetch(base + path, {
    method,
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(ifMatch ? { "If-Match": ifMatch } : {}),
    },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
}

async function expectStatus(response: Promise<Response>, status: number, label: string) {
  const result = await response;
  assert.equal(result.status, status, label);
  return result;
}

async function json<T>(response: Promise<Response>, status: number, label: string): Promise<T> {
  return await (await expectStatus(response, status, label)).json() as T;
}

async function login(base: string, credentials: Credentials, profile: string): Promise<FixtureUser> {
  const body = credentials(profile);
  const response = await expectStatus(client(base)("/api/auth/session", { method: "POST", body }), 200, "Synthetic QA sign-in");
  const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  assert.ok(cookie.length, "Synthetic QA sign-in returned a session cookie");
  return { send: client(base, cookie), id: "pilot-" + body.accountId };
}

async function checkCardAndPackage(publicGet: Send, admin: FixtureUser, owner: FixtureUser, participant: FixtureUser, outsider: FixtureUser) {
  const title = "Учебная лаборатория " + randomUUID();
  const cardInput = {
    type: "laboratory", title, folderId: "01_universities/midis/infrastructure",
    owners: ["Тестовый сотрудник МИДиС"], ownerIds: [owner.id],
    referenceDescription: "Синтетическое описание для проверки истории источников.",
    stopFormula: "Только учебный материал.", affiliation: "МИДиС",
    partner: "Тестовый партнёр", head: "Тестовый руководитель",
    placementStatus: "active", placementDetails: "Тестовый корпус",
    workDirections: [], equipment: [], confirmedIndicators: [],
  };
  const card = await json<KnowledgeCard>(
    admin.send("/api/knowledge/cards", { method: "POST", body: cardInput }), 201, "Coordinator creates a valid approved card",
  );
  assert.equal(card.status, "approved");
  const cardPath = "/api/knowledge/cards/" + card.id;
  const historyPath = cardPath + "/versions";
  const initial = await json<CardHistory>(publicGet(historyPath), 200, "Published source has a public history");
  const oldVersion = initial.currentVersionId;
  assert.ok(oldVersion);
  assert.deepEqual(initial.versions.map(row => [row.id, row.legacyBaseline]), [[oldVersion, false]]);
  const oldPath = historyPath + "/" + oldVersion;
  const before = await json<ApprovedCardVersion>(publicGet(oldPath), 200, "Initial source permalink");
  assert.equal(before.snapshot.title, title);

  const freshness = cardPath + "/freshness";
  const schedule = { action: "schedule", responsibleId: owner.id, nextReviewAt: "2020-01-01" };
  const verify = { action: "verify", versionId: oldVersion };
  const scheduled = await json<KnowledgeCard>(admin.send(freshness, {
    method: "PATCH", ifMatch: initial.cardUpdatedAt, body: schedule,
  }), 200, "Coordinator schedules reassessment of the current source");
  assert.equal(scheduled.freshness?.nextReviewAt, schedule.nextReviewAt);
  const ownerHistory = await json<CardHistory>(owner.send(historyPath), 200, "Owner can see their permission to verify");
  assert.equal(ownerHistory.canVerifyFreshness, true);
  assert.equal(ownerHistory.responsibleId, undefined);
  const adminHistory = await json<CardHistory>(admin.send(historyPath), 200, "Only a coordinator can see the assigned staff ID");
  assert.equal(adminHistory.responsibleId, owner.id);
  const publicCards = await json<KnowledgeCard[]>(publicGet("/api/knowledge/cards"), 200, "Overdue source remains public");
  const overdueCard = publicCards.find(row => row.id === card.id);
  assert.equal(overdueCard?.status, "approved");
  assert.equal(overdueCard.freshness?.nextReviewAt, schedule.nextReviewAt);
  await expectStatus(outsider.send(freshness, {
    method: "PATCH", ifMatch: scheduled.updatedAt, body: verify,
  }), 403, "An unrelated employee cannot verify a source");
  await expectStatus(owner.send(freshness, {
    method: "PATCH", ifMatch: initial.cardUpdatedAt, body: verify,
  }), 409, "Freshness rejects an obsolete If-Match");
  const verified = await json<KnowledgeCard>(owner.send(freshness, {
    method: "PATCH", ifMatch: scheduled.updatedAt, body: verify,
  }), 200, "Owner verifies the exact approved version");
  assert.equal(verified.freshness?.verifiedVersionId, oldVersion);
  assert.ok(verified.freshness?.lastVerifiedAt);
  assert.equal(verified.freshness?.nextReviewAt, undefined);
  const afterVerify = await json<CardHistory>(publicGet(historyPath), 200, "Freshness is separate from source history");
  assert.deepEqual(afterVerify.versions, initial.versions);
  assert.equal(afterVerify.currentVersionId, oldVersion);
  assert.equal(afterVerify.canVerifyFreshness, false);
  assert.equal(afterVerify.responsibleId, undefined);
  await expectStatus(owner.send(freshness, {
    method: "PATCH", ifMatch: verified.updatedAt, body: { action: "verify", versionId: "cv-" + "0".repeat(64) },
  }), 409, "Freshness verification rejects an incorrect source version");

  const pin = { cardId: card.id, versionId: oldVersion };
  const draftTitle = "Учебная редакция " + randomUUID();
  const createDraft = (user: FixtureUser, universityId: string, materialTitle: string, pinned = false) =>
    json<EditorialDocument>(user.send("/api/editor/drafts", {
      method: "POST", body: { content: {
        universityId, title: materialTitle, lead: "Синтетический материал для внутренней проверки.",
        ...(pinned && { sourceCardIds: [card.id], sourceVersions: [pin] }),
      } },
    }), 201, "Employee creates a private draft");
  const draft = await createDraft(owner, "midis", draftTitle, true);
  const otherDraft = await createDraft(participant, "susu", "Учебная закрытая редакция " + randomUUID());
  const draftPath = "/api/editor/drafts/" + draft.id;
  const readinessPath = draftPath + "/readiness";
  assert.deepEqual(draft.content.sourceVersions, [pin]);
  await expectStatus(participant.send(draftPath), 404, "Draft detail and revision history are private");
  await expectStatus(participant.send(readinessPath), 404, "Readiness is private");
  await expectStatus(participant.send(draftPath + "/docx"), 404, "DOCX shares the draft ACL");
  await expectStatus(admin.send(draftPath), 404, "A coordinator cannot see an unsubmitted private draft");
  const saved = await json<{ document: EditorialDocument; revisions: { content: EditorialDocument["content"] }[] }>(
    owner.send(draftPath), 200, "The owning employee can read the private revision",
  );
  assert.deepEqual(saved.revisions[0]?.content.sourceVersions, [pin]);

  const created = await json<WorkflowPresentation>(owner.send("/api/workflows", {
    method: "POST", body: { kind: "package", operationId: randomUUID(), title: "Учебный инфоповод " + randomUUID(),
      responsibleId: owner.id, participantIds: [participant.id], sources: [pin] },
  }), 201, "Create package with a pinned source");
  const packagePath = "/api/workflows/" + created.record.id;
  assert.deepEqual(created.sourceDetails, [{ ...pin, title }]);
  const attach = { action: "add-document", operationId: randomUUID(), version: created.record.version, documentId: draft.id };
  const attached = await json<WorkflowPresentation>(owner.send(packagePath, { method: "PATCH", body: attach }), 200, "Package owner attaches own draft");
  assert.deepEqual(attached.materialDetails.map(row => row.id), [draft.id]);
  const replay = await json<WorkflowPresentation>(owner.send(packagePath, { method: "PATCH", body: attach }), 200, "Exact package operation retry");
  assert.equal(replay.record.version, attached.record.version);
  await expectStatus(owner.send(packagePath, {
    method: "PATCH", body: { ...attach, operationId: randomUUID() },
  }), 409, "A new package mutation with a stale version is refused");
  await expectStatus(owner.send(packagePath, {
    method: "PATCH", body: { ...attach, operationId: randomUUID(), version: attached.record.version, documentId: otherDraft.id },
  }), 404, "Adding someone else's private draft is refused");
  await expectStatus(owner.send(packagePath, {
    method: "PATCH", body: { action: "add-source", operationId: randomUUID(), version: attached.record.version, source: { ...pin, versionId: "cv-" + "0".repeat(64) } },
  }), 404, "Adding a nonexistent approved source version is refused");
  const allowedPackage = await json<WorkflowDetail>(owner.send(packagePath), 200, "Read package after retry and rejected updates");
  assert.equal(allowedPackage.record.version, attached.record.version);
  assert.equal(allowedPackage.events.filter(event => event.action === "add-document").length, 1);
  const participantView = await json<WorkflowDetail>(participant.send(packagePath), 200, "Participant sees the package");
  assert.equal(participantView.record.kind, "package");
  assert.deepEqual(participantView.record.documentIds, []);
  assert.deepEqual(participantView.materialDetails, []);
  assert.ok(!JSON.stringify(participantView).includes(draft.id), "Private draft ID must be absent from all package fields and history");
  assert.ok(!JSON.stringify(participantView).includes(draftTitle), "Private draft title must be absent from all package fields and history");
  await expectStatus(outsider.send(packagePath), 404, "Nonparticipants cannot read private packages");

  const newTitle = title + " — уточнение";
  await json<KnowledgeCard>(admin.send(cardPath, {
    method: "PUT", ifMatch: verified.updatedAt,
    body: { ...cardInput, title: newTitle, referenceDescription: "Уточнённое синтетическое описание для проверки истории." },
  }), 200, "Publish a new approved version of the source");
  const currentHistory = await json<CardHistory>(publicGet(historyPath), 200, "Read the updated source history");
  const newVersion = currentHistory.currentVersionId;
  assert.ok(newVersion);
  assert.notEqual(newVersion, oldVersion);
  assert.deepEqual(new Set(currentHistory.versions.map(row => row.id)), new Set([oldVersion, newVersion]));
  assert.deepEqual(await json<ApprovedCardVersion>(publicGet(oldPath), 200, "Old permalink stays readable"), before);
  const newSnapshot = await json<ApprovedCardVersion>(publicGet(historyPath + "/" + newVersion), 200, "New permalink shows the new source");
  assert.equal(newSnapshot.snapshot.title, newTitle);
  const packaged = await json<WorkflowDetail>(owner.send(packagePath), 200, "Package retains the originally pinned source");
  assert.deepEqual(packaged.sourceDetails, [{ ...pin, title }]);

  const usagePath = cardPath + "/usage";
  const ownerUsage = await json<{ items: CardUsage[] }>(owner.send(usagePath), 200, "Owner can see the material's source dependency");
  const usage = ownerUsage.items.find(row => row.id === draft.id);
  assert.equal(usage?.versionId, oldVersion);
  assert.equal(usage?.needsReview, true);
  const hiddenUsage = await json<{ items: CardUsage[] }>(participant.send(usagePath), 200, "Staff can read their own source usages");
  assert.ok(!hiddenUsage.items.some(row => row.id === draft.id));
  const taskId = `source-change:${draft.id}:${card.id}:${newVersion}`;
  for (let read = 0; read < 2; read++) {
    const work = await json<WorkData>(owner.send("/api/work"), 200, "Read the owner's work queue");
    const tasks = work.items.filter(item => item.id === taskId);
    assert.deepEqual(tasks.map(item => item.href), ["/editor?draft=" + draft.id], "The source change yields one stable task with a direct draft link");
  }
  const participantWork = await json<WorkData>(participant.send("/api/work"), 200, "Read the participant's work queue");
  assert.equal(participantWork.coverage, null);
  assert.ok(!JSON.stringify(participantWork).includes(draft.id), "Work must not leak an attached private draft");
  assert.ok(!JSON.stringify(participantWork).includes(draftTitle));

  const snapshot = await json<EditorialReadiness>(owner.send(readinessPath), 200, "Read exact draft readiness");
  const changed = [{ cardId: card.id, usedVersionId: oldVersion, currentVersionId: newVersion }];
  assert.deepEqual(snapshot.changedSources, changed);
  assert.equal(snapshot.documentId, draft.id);
  assert.equal(snapshot.revisionId, draft.revisionId);
  const expectedHead = { revisionId: draft.revisionId, version: draft.version };
  const check = () => json<EditorialReadiness>(owner.send(readinessPath, {
    method: "POST", body: { action: "check", ...expectedHead },
  }), 200, "Run the deterministic checker for the exact revision");
  const checked = await check();
  assert.ok(checked.check.checkedAt);
  assert.deepEqual(checked.changedSources, changed, "Text checking cannot accept changed sources");
  const newPin = { cardId: card.id, versionId: newVersion };
  const review = { action: "review-sources", ...expectedHead, sourceVersions: [newPin], comment: "Сверено вручную для точной редакции." };
  const submitReview = () => json<EditorialReadiness>(owner.send(readinessPath, { method: "POST", body: review }), 200, "Record explicit source review for the same revision");
  const reviewed = await submitReview();
  assert.deepEqual(reviewed.changedSources, []);
  assert.equal(reviewed.reviewedSourceVersions.length, 1);
  const receipt = reviewed.reviewedSourceVersions[0];
  assert.equal(receipt.cardId, newPin.cardId);
  assert.equal(receipt.versionId, newPin.versionId);
  assert.equal(receipt.reviewedBy, owner.id);
  assert.equal(receipt.comment, review.comment);
  assert.ok(receipt.reviewedAt);
  assert.deepEqual((await submitReview()).reviewedSourceVersions, [receipt], "Retry leaves the initial source review receipt intact");
  assert.deepEqual(reviewed.sourceVersions, [pin], "Source review preserves the original editorial provenance");
  assert.equal(reviewed.approval.status, "draft");
  assert.equal(reviewed.ready, false);
  await check();
  const confirmed = await json<EditorialReadiness>(owner.send(readinessPath), 200, "Read the stored review and check receipt");
  assert.ok(confirmed.check.checkedAt);
  assert.ok(["passed", "attention"].includes(confirmed.check.status));
  assert.equal(confirmed.revisionId, draft.revisionId);
  assert.equal(confirmed.approval.status, "draft");
  const afterReview = await json<WorkData>(owner.send("/api/work"), 200, "Read queue after manual source review");
  assert.ok(!afterReview.items.some(item => item.id === taskId));
  const next = await json<{ document: EditorialDocument }>(owner.send(draftPath, {
    method: "PATCH", body: { action: "save", version: draft.version, content: { ...draft.content, lead: "Изменённое вступление для внутренней проверки." } },
  }), 200, "Save a new revision while preserving its editorial source pin");
  assert.notEqual(next.document.revisionId, draft.revisionId);
  await expectStatus(owner.send(readinessPath, { method: "POST", body: review }), 409, "Old head cannot accept a source review");
  await expectStatus(owner.send(readinessPath, {
    method: "POST", body: { action: "check", ...expectedHead },
  }), 409, "Old head cannot record a new check");
  const nextReadiness = await json<EditorialReadiness>(owner.send(readinessPath), 200, "New revision has its own readiness");
  assert.equal(nextReadiness.check.status, "missing");
  assert.deepEqual(nextReadiness.changedSources, changed);
  console.log("PASS Canon HTTP: immutable card versions, freshness, pinned packages, private drafts, stable source tasks and exact-revision readiness");
}

async function checkDispute(owner: FixtureUser, responsible: FixtureUser, outsider: FixtureUser) {
  const first = { statement: "Описание завершённой работы", object: "Учебный объект", year: 2025, unit: "работа", state: "actual", url: "https://example.org/qa/actual" };
  const second = { ...first, statement: "Описание предстоящей работы", year: 2026, state: "plan", url: "https://example.org/qa/plan" };
  const created = await json<WorkflowPresentation>(owner.send("/api/workflows", {
    method: "POST", body: { kind: "dispute", operationId: randomUUID(), title: "Разбор источников " + randomUUID(),
      responsibleId: responsible.id, evidence: [first, second] },
  }), 201, "Create a dispute from two structured sources");
  assert.equal(created.record.kind, "dispute");
  assert.deepEqual(created.record.evidence, [first, second]);
  const route = "/api/workflows/" + created.record.id;
  await expectStatus(outsider.send(route), 404, "An unrelated employee cannot see a dispute or its events");
  const resolve = { action: "resolve", operationId: randomUUID(), version: created.record.version,
    decision: "Оставляем сроки как разные периоды наблюдения." };
  await expectStatus(owner.send(route, { method: "PATCH", body: resolve }), 403, "An author cannot resolve an assigned dispute");
  const resolved = await json<WorkflowPresentation>(responsible.send(route, { method: "PATCH", body: resolve }), 200, "Assigned employee resolves the dispute");
  assert.equal(resolved.record.kind, "dispute");
  assert.equal(resolved.record.status, "resolved");
  const repeat = await json<WorkflowPresentation>(responsible.send(route, { method: "PATCH", body: resolve }), 200, "Repeat the exact dispute decision");
  assert.equal(repeat.record.version, resolved.record.version);
  const reopen = { action: "reopen", operationId: randomUUID(), version: created.record.version, reason: "Требуется уточнить период исходного документа." };
  await expectStatus(responsible.send(route, { method: "PATCH", body: reopen }), 409, "Dispute cannot be reopened against a stale version");
  const reopened = await json<WorkflowPresentation>(responsible.send(route, {
    method: "PATCH", body: { ...reopen, version: resolved.record.version },
  }), 200, "Reopen a dispute against its current version");
  assert.equal(reopened.record.kind, "dispute");
  assert.equal(reopened.record.status, "open");
  const restored = await json<WorkflowDetail>(responsible.send(route), 200, "Read stored dispute history");
  assert.equal(restored.record.kind, "dispute");
  assert.deepEqual(restored.record.evidence, [first, second]);
  assert.deepEqual(restored.events.toSorted((a, b) => a.version - b.version).map(event => event.action), ["created", "resolve", "reopen"]);
  assert.equal(restored.events.find(event => event.action === "resolve")?.message, resolve.decision);
  assert.equal(restored.events.find(event => event.action === "reopen")?.message, reopen.reason);
  console.log("PASS Canon HTTP: dispute assignment, decisions, stale writes, exact replay and stored event history");
}

async function checkSharedRequest(publicGet: Send, admin: FixtureUser, author: FixtureUser, recipient: FixtureUser, outsider: FixtureUser) {
  const create = { operationId: randomUUID(), recipientUniversityId: "susu", subject: "Учебный вопрос " + randomUUID(),
    question: "Укажите опубликованный источник для учебной проверки.", linkedCardId: null };
  const createRequest = () => json<InformationRequest>(author.send("/api/requests", {
    method: "POST", body: create,
  }), 201, "Create a shared request or replay the same operation");
  const fresh = await createRequest();
  assert.equal((await createRequest()).id, fresh.id);
  const route = "/api/requests/" + fresh.id;
  const join = { action: "join", operationId: randomUUID(), revision: fresh.revision };
  await expectStatus(outsider.send(route), 404, "Unrelated organization cannot read the request");
  await expectStatus(outsider.send(route, { method: "PATCH", body: join }), 404, "Unrelated organization cannot join the request");
  const update = (user: FixtureUser, body: object, label: string) => json<InformationRequest>(
    user.send(route, { method: "PATCH", body }), 200, label,
  );
  const joined = await update(recipient, join, "Recipient joins the request");
  assert.equal((await update(recipient, join, "Replay exact join")).revision, joined.revision);
  const assign = { action: "assign", operationId: randomUUID(), revision: joined.revision, responsibleId: recipient.id, dueDate: "2030-01-15" };
  await expectStatus(author.send(route, {
    method: "PATCH", body: { ...assign, responsibleId: author.id },
  }), 400, "The request assignee must be in the receiving university");
  const assigned = await update(author, assign, "Assign a recipient and due date");
  assert.equal((await update(author, assign, "Replay exact assignment")).revision, assigned.revision);
  await expectStatus(author.send(route, {
    method: "PATCH", body: { ...assign, operationId: randomUUID() },
  }), 409, "A distinct write with a stale request revision is rejected");
  const answer = { action: "answer", operationId: randomUUID(), revision: assigned.revision,
    answer: "Описание учебного результата. Стадия проекта и контур не указаны.", evidenceUrl: "https://example.org/qa/request-evidence" };
  await expectStatus(author.send(route, { method: "PATCH", body: answer }), 403, "Only the receiving university can answer");
  const answered = await update(recipient, answer, "Recipient answers in the application");
  const detail = await json<{ item: InformationRequest; participants: { id: string }[] }>(
    author.send(route), 200, "Request author sees the saved answer, assignment and participants",
  );
  assert.equal(detail.item.status, "answered");
  assert.equal(detail.item.answer, answer.answer);
  assert.equal(detail.item.evidenceUrl, answer.evidenceUrl);
  assert.equal(detail.item.responsibleId, recipient.id);
  assert.equal(detail.item.dueDate, assign.dueDate);
  assert.deepEqual(new Set(detail.participants.map(person => person.id)), new Set([author.id, recipient.id]));
  const submitted = await update(author, {
    action: "submit", operationId: randomUUID(), revision: answered.revision,
  }, "Submit the answer as a candidate");
  assert.equal(submitted.status, "submitted");
  assert.ok(submitted.candidateCardId);
  const admins = await json<KnowledgeCard[]>(admin.send("/api/knowledge/cards"), 200, "Coordinator sees a candidate awaiting evidence");
  const candidate = admins.find(card => card.id === submitted.candidateCardId);
  assert.ok(candidate?.type === "project");
  assert.equal(candidate.status, "pending");
  assert.equal(candidate.readinessStage, "Не уточнено");
  assert.equal(candidate.contour, "не уточнён");
  assert.deepEqual(candidate.confirmedFigures, []);
  const cards = await json<KnowledgeCard[]>(publicGet("/api/knowledge/cards"), 200, "Public cards exclude candidates that await review");
  assert.ok(!cards.some(card => card.id === candidate.id));
  await expectStatus(admin.send("/api/knowledge/cards/" + candidate.id + "/moderation", {
    method: "POST", ifMatch: candidate.updatedAt, body: { action: "approve" },
  }), 409, "Coordinator cannot publish a project before stage and contour are confirmed");
  console.log("PASS Canon HTTP: shared request privacy, participation, assignment, answer and pending candidate");
}

export async function runCanonRoutes(credentials: Credentials) {
  const base = await requireFixtureServer();
  const publicGet = client(base);
  const system = await json<{
    storageMode: string; yandexAi: { configured: boolean }; alibabaAi: { configured: boolean }; yandexDisk: { configured: boolean };
  }>(publicGet("/api/system/status"), 200, "Read isolated fixture integration flags");
  assert.equal(system.storageMode, "dynamodb");
  assert.deepEqual([system.yandexAi.configured, system.alibabaAi.configured, system.yandexDisk.configured], [false, false, false], "External integrations must be off before mutating fixture data");
  const version = await json<{ version: string }>(publicGet("/api/version"), 200, "Read the installed application version");
  assert.equal(version.version, "0.9.5");
  const [owner, participant, outsider, admin, guest] = await Promise.all(
    ["demo-pr-midis", "demo-pr-susu", "demo-pr-csu", "demo-admin", "demo-guest"]
      .map(profile => login(base, credentials, profile)),
  );
  for (const route of ["/api/work", "/api/workflows"]) {
    await expectStatus(publicGet(route), 401, "Anonymous access to staff work is denied");
    await expectStatus(guest.send(route), 403, "Guest account cannot read staff work");
  }
  await expectStatus(owner.send("/api/workflows", {
    method: "POST", rawBody: JSON.stringify({ oversized: "x".repeat(100_000) }),
  }), 413, "Oversized workflow requests are refused");
  await expectStatus(owner.send("/api/workflows", {
    method: "POST", rawBody: "{",
  }), 400, "Malformed workflow JSON is refused");
  console.log("PASS Canon HTTP: version, staff access and workflow request limits");
  await checkCardAndPackage(publicGet, admin, owner, participant, outsider);
  await checkDispute(owner, participant, outsider);
  await checkSharedRequest(publicGet, admin, owner, participant, outsider);
}
