import type { ZodType } from "zod";
import {
  canSeeCard,
  demoAccounts,
  toSessionUser,
  type SessionUser,
} from "./auth";
import {
  allDemoCards,
  approvedDemoCards,
  demoUser,
  getDemoCard,
  nextDemoTimestamp,
  updateDemoCard,
  type BrowserDemoState,
} from "./browser-demo";
import { demoEditorialRows } from "./browser-demo-editor";
import { demoError, type DemoCall, type DemoHandler } from "./browser-demo-http";
import { demoCardVersionId } from "./browser-demo-version";
import { canReadEditorial, type EditorialDocument } from "./editorial";
import {
  canAnswerInformationRequest,
  canSeeInformationRequest,
  createInformationRequestSchema,
  presentInformationRequest,
  updateInformationRequestSchema,
  type InformationRequest,
} from "./information-requests";
import { folderIds, getApprovedVersion, type ProjectCard } from "./knowledge";
import type { SourceVersionReference } from "./source-references";
import { evidenceUrlSchema } from "./validation/knowledge";
import { createWorkflowSchema, workflowMutationSchema } from "./validation/workflow";
import { buildUniversityCoverage, buildWorkQueue, type QueueReadiness } from "./work-queue";
import type { WorkData } from "./work-data";
import type { WorkflowEvent, WorkflowRecord } from "./workflow";
import type { WorkflowPresentation } from "./workflow-models";
import { applyWorkflowMutation, canReadWorkflow, makeWorkflowRecord, WorkflowError } from "./workflow-policy";

const people = demoAccounts.map(toSessionUser).filter(({ role }) => role !== "guest");

function parse<T>(call: DemoCall, schema: ZodType<T>): T {
  const result = schema.safeParse(call.body());
  if (!result.success) throw new WorkflowError(result.error.issues[0]?.message ?? "Проверьте поля формы");
  return result.data;
}

async function digest(input: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

function currentState(call: DemoCall, user: SessionUser) {
  // Re-read after hashing so two requests in the same tab cannot save from one revision.
  const state = call.state;
  if (demoUser(state).id !== user.id) throw new WorkflowError("Учебная роль изменилась. Повторите действие.", 409);
  return state;
}

function cardById(state: BrowserDemoState, id: string | null) {
  return id ? getDemoCard(state, id) ?? null : null;
}

function presentRequest(state: BrowserDemoState, user: SessionUser, item: InformationRequest) {
  return presentInformationRequest(item, user, cardById(state, item.linkedCardId), cardById(state, item.candidateCardId));
}

export function visibleDemoRequests(state: BrowserDemoState) {
  const user = demoUser(state);
  return (state.requests ?? []).filter(item => canSeeInformationRequest(user, item))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(item => presentRequest(state, user, item));
}

export function demoIncomingRequestCount(state: BrowserDemoState) {
  const user = demoUser(state);
  return (state.requests ?? []).filter(item => item.status === "open" && canAnswerInformationRequest(user, item)).length;
}

const recipientPeople = (universityId: string) =>
  people.filter(person => person.universityId === universityId &&
    (person.role === "university_pr" || person.role === "university_owner"));

function assignee(universityId: string, id?: string | null) {
  if (!id) return { responsibleId: null, responsibleName: "" };
  const person = recipientPeople(universityId).find(person => person.id === id);
  if (!person) throw new WorkflowError("Выберите ответственного из вуза-получателя");
  return { responsibleId: person.id, responsibleName: person.name };
}

async function createRequest(call: DemoCall, user: SessionUser) {
  const input = parse(call, createInformationRequestSchema);
  const creationDigest = await digest(input);
  const state = currentState(call, user);
  const id = `demo-request-${user.id}-${input.operationId}`;
  const requests = state.requests ?? [];
  const existing = requests.find(item => item.id === id);
  if (existing) {
    if (existing.authorId !== user.id || existing.creationDigest !== creationDigest)
      throw new WorkflowError("Повторный запрос изменён. Обновите форму.", 409);
    return Response.json(presentRequest(state, user, existing), { status: 201 });
  }
  if (user.universityId === input.recipientUniversityId)
    throw new WorkflowError("Выберите другой вуз-получатель");
  const card = cardById(state, input.linkedCardId);
  if (input.linkedCardId && (!card || (!canSeeCard(user, card) && !getApprovedVersion(card))))
    throw new WorkflowError("Карточка недоступна", 404);
  const now = nextDemoTimestamp();
  const item: InformationRequest = {
    id,
    authorId: user.id,
    authorName: user.name,
    authorOrganization: user.organization,
    recipientUniversityId: input.recipientUniversityId,
    subject: input.subject,
    question: input.question,
    linkedCardId: input.linkedCardId,
    status: "open",
    answer: null,
    evidenceUrl: null,
    answeredBy: null,
    candidateCardId: null,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    creationDigest,
    lastOperationId: null,
    lastOperationDigest: null,
    participantIds: [user.id],
    ...assignee(input.recipientUniversityId, input.responsibleId),
    dueDate: input.dueDate ?? null,
  };
  call.save({ ...state, requests: [...requests, item] });
  return Response.json(presentRequest(state, user, item), { status: 201 });
}

function readableRequest(state: BrowserDemoState, user: SessionUser, id: string) {
  const item = state.requests?.find(entry => entry.id === id);
  if (!item || !canSeeInformationRequest(user, item)) throw new WorkflowError("Запрос не найден", 404);
  return item;
}

function requestCandidate(state: BrowserDemoState, user: SessionUser, item: InformationRequest, now: string): ProjectCard {
  if (item.status !== "answered" || !item.answer || !item.evidenceUrl)
    throw new WorkflowError("Сначала нужен ответ с источником", 409);
  const id = `request-${item.id}`;
  if (getDemoCard(state, id)) throw new WorkflowError("Данные изменились. Обновите страницу.", 409);
  const recipients = recipientPeople(item.recipientUniversityId);
  const leads = recipients.filter(person => person.role === "university_owner");
  const owner = leads.length === 1 ? leads[0] : recipients.find(person => person.id === item.answeredBy);
  return {
    id,
    type: "project",
    title: item.subject,
    folderId: folderIds.subfolder(item.recipientUniversityId, "products"),
    owners: [owner?.ownershipLabel ?? item.recipientUniversityId],
    ownerIds: owner ? [owner.id] : [],
    referenceDescription: item.answer,
    sources: [{ title: "Источник из ответа", url: item.evidenceUrl }],
    stopFormula: "Учебный ответ на запрос. Использовать после подтверждения координатором.",
    status: "pending",
    submittedBy: user.id,
    submittedByName: user.name,
    participantApprovals: [],
    createdAt: now,
    updatedAt: now,
    sphere: "Требует уточнения",
    initiatorUniversityId: item.recipientUniversityId,
    coExecutors: [],
    industrialPartner: "Не указан",
    readinessStage: "Не уточнено",
    contour: "не уточнён",
    confirmedFigures: [],
    isJoint: false,
    participantUniversityIds: [item.recipientUniversityId],
  };
}

async function updateRequest(call: DemoCall, user: SessionUser, id: string) {
  const input = parse(call, updateInformationRequestSchema);
  const operationDigest = await digest(input);
  let state = currentState(call, user);
  const item = readableRequest(state, user, id);
  if (input.action === "answer" && !canAnswerInformationRequest(user, item))
    throw new WorkflowError("Отвечать может только вуз-получатель", 403);
  if (item.lastOperationId === input.operationId) {
    if (item.lastOperationDigest !== operationDigest)
      throw new WorkflowError("Этот повтор операции отличается от исходного", 409);
    return Response.json(presentRequest(state, user, item));
  }
  if (item.revision !== input.revision)
    throw new WorkflowError("Запрос изменился. Обновите страницу.", 409);
  const next: InformationRequest = {
    ...item,
    revision: item.revision + 1,
    updatedAt: nextDemoTimestamp(item.updatedAt),
    lastOperationId: input.operationId,
    lastOperationDigest: operationDigest,
  };
  switch (input.action) {
    case "join":
    case "leave": {
      if (input.action === "leave" && item.authorId === user.id)
        throw new WorkflowError("Автор продолжает получать результат своего запроса");
      const participants = new Set(item.participantIds ?? [item.authorId]);
      if (input.action === "join") participants.add(user.id);
      else participants.delete(user.id);
      next.participantIds = [...participants];
      break;
    }
    case "assign":
      Object.assign(next, assignee(item.recipientUniversityId, input.responsibleId), { dueDate: input.dueDate });
      break;
    case "answer":
      if (item.status !== "open") throw new WorkflowError("На этот запрос уже ответили", 409);
      Object.assign(next, {
        answer: input.answer, evidenceUrl: evidenceUrlSchema.parse(input.evidenceUrl),
        answeredBy: user.id, status: "answered",
      });
      break;
    case "submit": {
      const candidate = requestCandidate(state, user, item, next.updatedAt);
      state = updateDemoCard(state, candidate);
      Object.assign(next, { status: "submitted", candidateCardId: candidate.id });
    }
  }
  call.save({ ...state, requests: (state.requests ?? []).map(entry => entry.id === id ? next : entry) });
  return Response.json(presentRequest(state, user, next));
}

function requestRoute(call: DemoCall, user: SessionUser, id?: string) {
  if (!id && call.method === "GET") {
    if (user.role === "guest") return demoError("Войдите в аккаунт для просмотра запросов", 401);
    return Response.json({ items: visibleDemoRequests(call.state), dbAvailable: true });
  }
  if (!id && call.method === "POST") {
    if (user.role === "guest") return demoError("Гостям недоступна отправка запросов", 403);
    return createRequest(call, user);
  }
  if (id && call.method === "GET") {
    const state = call.state;
    const item = readableRequest(state, user, id);
    return Response.json({
      item: presentRequest(state, user, item),
      people: recipientPeople(item.recipientUniversityId).map(({ id, name }) => ({ id, name })),
      participants: (item.participantIds ?? [item.authorId]).map(id => ({
        id, name: people.find(person => person.id === id)?.name ?? "Учётная запись недоступна",
      })),
    });
  }
  if (id && call.method === "PATCH") return updateRequest(call, user, id);
  return demoError("Действие недоступно для этого запроса", 405);
}

function approvedSource(state: BrowserDemoState, user: SessionUser, source: SourceVersionReference) {
  const card = cardById(state, source.cardId);
  if (!card) return null;
  const approved = getApprovedVersion(card);
  if (!approved && !canSeeCard(user, card)) return null;
  if (approved && demoCardVersionId(approved) === source.versionId) return approved;
  const historical = state.cardVersions?.find(version =>
    version.id === source.cardId && demoCardVersionId(version) === source.versionId
  );
  return historical ? getApprovedVersion(historical) : null;
}

function visibleEditorialRows(state: BrowserDemoState, user: SessionUser) {
  return demoEditorialRows(state).filter(({ document }) => canReadEditorial(user, document));
}

function documentSummary({ id, content, channel, status }: EditorialDocument) {
  return { id, title: content.title || "Материал без названия", channel, status };
}

function recordPresentation(state: BrowserDemoState, user: SessionUser, record: WorkflowRecord): WorkflowPresentation {
  if (record.kind !== "package") {
    const card = cardById(state, record.cardId);
    const projected = card && canSeeCard(user, card) ? record : { ...record, cardId: null };
    return { record: projected, sourceDetails: [], materialDetails: [] };
  }
  const sourceDetails = record.sources.flatMap(source => {
    const card = approvedSource(state, user, source);
    return card ? [{ ...source, title: card.title }] : [];
  });
  const visible = new Map(visibleEditorialRows(state, user).map(({ document }) => [document.id, document]));
  const materialDetails = record.documentIds.flatMap(id => {
    const document = visible.get(id);
    return document ? [documentSummary(document)] : [];
  });
  return {
    record: {
      ...record,
      sources: sourceDetails.map(({ cardId, versionId }) => ({ cardId, versionId })),
      documentIds: materialDetails.map(({ id }) => id),
    },
    sourceDetails,
    materialDetails,
  };
}

function listWorkflows(state: BrowserDemoState, user: SessionUser) {
  return (state.workflows ?? []).map(({ record }) => record).filter(record => canReadWorkflow(user, record))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(record => recordPresentation(state, user, record));
}

const workPeople = people.map(({ id, name, organization }) => ({ id, name, organization }));

function workData(state: BrowserDemoState, user: SessionUser): WorkData {
  if (user.role === "guest") throw new WorkflowError("Эта работа доступна сотрудникам", 403);
  const cards = allDemoCards(state);
  const workflows = listWorkflows(state, user);
  const editorialRows = visibleEditorialRows(state, user);
  const documents = editorialRows.map(({ document }) => document);
  const sources = approvedDemoCards(state).map(card => ({
    cardId: card.id, versionId: demoCardVersionId(card), title: card.title,
  }));
  const currentVersion = new Map(sources.map(({ cardId, versionId }) => [cardId, versionId]));
  const readiness: Record<string, QueueReadiness> = {};
  for (const { document: { id, content, revisionId }, readiness: review } of editorialRows) {
    const pins = new Map(content.sourceVersions?.map(({ cardId, versionId }) => [cardId, versionId]));
    if (review?.revisionId === revisionId) {
      for (const { cardId, versionId } of review.reviews ?? []) pins.set(cardId, versionId);
    }
    readiness[id] = {
      changedSources: content.sourceCardIds.flatMap(cardId => {
        const currentVersionId = currentVersion.get(cardId);
        const usedVersionId = pins.get(cardId) ?? null;
        return currentVersionId !== usedVersionId && currentVersionId
          ? [{ cardId, usedVersionId, currentVersionId }]
          : [];
      }),
      unknownSources: content.sourceCardIds.filter(cardId => !currentVersion.has(cardId) || !pins.has(cardId)),
    };
  }
  const items = buildWorkQueue(user, {
    cards, documents, requests: visibleDemoRequests(state), readiness,
    workflows: workflows.map(({ record }) => record),
  });
  const names = new Map(workPeople.map(person => [person.id, person.name]));
  return {
    user: { id: user.id, name: user.name, role: user.role },
    items: items.map(item => ({
      ...item, responsibleName: names.get(item.responsibleId ?? "") ?? item.responsibleName,
    })),
    workflows, people: workPeople, sources,
    documents: documents.map(documentSummary),
    coverage: user.role === "admin" ? buildUniversityCoverage(user, cards) : null,
  };
}

function retainPackageReferences(
  state: BrowserDemoState,
  user: SessionUser,
  sources: SourceVersionReference[],
  documentIds: string[],
) {
  const visibleIds = new Set(visibleEditorialRows(state, user).map(({ document }) => document.id));
  if (documentIds.some(id => !visibleIds.has(id))) throw new WorkflowError("Черновик не найден", 404);
  if (!sources.length) return state;
  const versions = new Map((state.cardVersions ?? []).map(card => [demoCardVersionId(card), card]));
  for (const source of sources) {
    const card = approvedSource(state, user, source);
    if (!card) throw new WorkflowError("Утверждённая версия источника недоступна", 404);
    versions.set(source.versionId, card);
  }
  return { ...state, cardVersions: [...versions.values()] };
}

function workflowEvent(record: WorkflowRecord, user: SessionUser, action: string, message: string): WorkflowEvent {
  return {
    id: `${record.id}:event:${record.lastOperationId}`,
    kind: "workflow-event",
    recordId: record.id,
    actorId: user.id,
    actorName: user.name,
    at: record.updatedAt,
    action, message, version: record.version,
  };
}

async function createWorkflow(call: DemoCall, user: SessionUser) {
  const input = parse(call, createWorkflowSchema);
  const operationDigest = await digest(input);
  let state = currentState(call, user);
  const record = makeWorkflowRecord(user, input, people, () => operationDigest);
  const workflows = state.workflows ?? [];
  const existing = workflows.find(row => row.record.id === record.id);
  if (existing) {
    if (existing.record.creatorId !== user.id || existing.record.creationDigest !== operationDigest)
      throw new WorkflowError("Повтор создания содержит другие данные", 409);
    return Response.json(recordPresentation(state, user, existing.record), { status: 201 });
  }
  if (record.kind === "package") {
    state = retainPackageReferences(state, user, record.sources, record.documentIds);
  } else if (record.cardId) {
    const card = cardById(state, record.cardId);
    if (!card || !canSeeCard(user, card)) throw new WorkflowError("Карточка недоступна", 404);
  }
  call.save({
    ...state,
    workflows: [...workflows, { record, events: [workflowEvent(record, user, "created", "Создана рабочая запись")] }],
  });
  return Response.json(recordPresentation(state, user, record), { status: 201 });
}

function readableWorkflow(state: BrowserDemoState, user: SessionUser, id: string) {
  const row = state.workflows?.find(({ record }) => record.id === id);
  if (!row || !canReadWorkflow(user, row.record)) throw new WorkflowError("Запись не найдена", 404);
  return row;
}

async function updateWorkflow(call: DemoCall, user: SessionUser, id: string) {
  const input = parse(call, workflowMutationSchema);
  const operationDigest = await digest(input);
  let state = currentState(call, user);
  const row = readableWorkflow(state, user, id);
  const record = applyWorkflowMutation(user, row.record, input, people, () => operationDigest);
  if (record === row.record) return Response.json(recordPresentation(state, user, record));
  if (input.action === "add-source") state = retainPackageReferences(state, user, [input.source], []);
  if (input.action === "add-document") state = retainPackageReferences(state, user, [], [input.documentId]);
  const message = input.action === "resolve" ? input.decision : input.action === "reopen"
    ? input.reason : "Обновлена рабочая запись";
  const events = [...row.events, workflowEvent(record, user, input.action, message)].slice(-80);
  call.save({ ...state, workflows: (state.workflows ?? []).map(entry => entry === row ? { record, events } : entry) });
  return Response.json(recordPresentation(state, user, record));
}

function workflowRoute(call: DemoCall, user: SessionUser, id?: string) {
  if (!id && call.method === "GET") return Response.json({ items: listWorkflows(call.state, user), people: workPeople });
  if (!id && call.method === "POST") return createWorkflow(call, user);
  if (id && call.method === "GET") {
    const state = call.state;
    const { record, events } = readableWorkflow(state, user, id);
    return Response.json({ ...recordPresentation(state, user, record), events });
  }
  if (id && call.method === "PATCH") return updateWorkflow(call, user, id);
  return demoError("Действие недоступно для этой записи", 405);
}

export const handleDemoCollaboration: DemoHandler = async call => {
  const match = /^\/api\/(requests|workflows)(?:\/([^/]+))?$/.exec(call.url.pathname);
  const isWork = call.url.pathname === "/api/work";
  if (!match && !isWork) return undefined;
  try {
    const user = demoUser(call.state);
    const id = match?.[2] && decodeURIComponent(match[2]);
    if (match?.[1] === "requests") return await requestRoute(call, user, id);
    if (isWork) return call.method === "GET"
      ? Response.json(workData(call.state, user))
      : demoError("Рабочая очередь доступна для чтения", 405);
    if (user.role === "guest") return demoError("Эта работа доступна сотрудникам", 403);
    return await workflowRoute(call, user, id);
  } catch (error) {
    if (error instanceof WorkflowError) return demoError(error.message, error.status);
    throw error;
  }
};
