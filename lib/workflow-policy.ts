import { canUseStaffWorkflow, type SessionUser } from "./auth";
import type { SourceVersionReference } from "./source-references";
import type { CreateWorkflowInput, WorkflowMutation } from "./validation/workflow";
import type { WorkflowRecord } from "./workflow";

export class WorkflowError extends Error { constructor(message: string, public status = 400) { super(message); } }

export function canReadWorkflow(user: SessionUser | null, record: WorkflowRecord): boolean {
  return canUseStaffWorkflow(user) && (user.role === "admin" || record.creatorId === user.id || record.responsibleId === user.id || record.participantIds.includes(user.id));
}
export function canEditWorkflow(user: SessionUser | null, record: WorkflowRecord): boolean {
  return canReadWorkflow(user, record) && !!user && (user.role === "admin" || record.creatorId === user.id || record.responsibleId === user.id);
}
function participants(creatorId: string, responsibleId: string, ids: string[], people: SessionUser[]) {
  if (![responsibleId, ...ids].every(id => people.some(person => person.id === id && canUseStaffWorkflow(person))))
    throw new WorkflowError("Выберите действующих сотрудников");
  return [...new Set([creatorId, responsibleId, ...ids])];
}
function uniqueSources(sources: SourceVersionReference[]) {
  return [...new Map(sources.map(source => [`${source.cardId}\n${source.versionId}`, source])).values()];
}
export function makeWorkflowRecord(user: SessionUser, input: CreateWorkflowInput, people: SessionUser[], digest: (value: unknown) => string, now = new Date().toISOString()): WorkflowRecord {
  if (!canUseStaffWorkflow(user)) throw new WorkflowError("Эта работа доступна сотрудникам", 403);
  const { operationId, ...data } = input;
  return { ...data, id: `workflow-${operationId}`, creatorId: user.id, creatorName: user.name,
    participantIds: participants(user.id, input.responsibleId, input.participantIds, people),
    version: 1, createdAt: now, updatedAt: now, creationDigest: digest(input),
    lastOperationId: operationId, lastOperationDigest: digest(input),
    ...(input.kind === "package" ? { sources: uniqueSources(input.sources), documentIds: [...new Set(input.documentIds)] } : {}),
    ...(input.kind === "dispute" ? { status: "open" as const, decision: null } : {}),
  } as WorkflowRecord;
}
export function applyWorkflowMutation(user: SessionUser, record: WorkflowRecord, input: WorkflowMutation, people: SessionUser[], digest: (value: unknown) => string): WorkflowRecord {
  if (!canReadWorkflow(user, record)) throw new WorkflowError("Запись не найдена", 404);
  if (!canEditWorkflow(user, record)) throw new WorkflowError("Изменения доступны ответственному и автору", 403);
  const operationDigest = digest(input);
  if (record.lastOperationId === input.operationId) {
    if (record.lastOperationDigest !== operationDigest) throw new WorkflowError("Повтор операции содержит другие данные", 409);
    return record;
  }
  if (input.version !== record.version) throw new WorkflowError("Запись изменилась. Обновите её перед сохранением", 409);
  let next = { ...record };
  if (input.action === "edit") {
    const fields = { title: input.title ?? record.title, description: input.description ?? record.description, responsibleId: input.responsibleId ?? record.responsibleId, dueDate: input.dueDate === undefined ? record.dueDate : input.dueDate };
    next = { ...next, ...fields, participantIds: participants(record.creatorId, fields.responsibleId, input.participantIds ?? record.participantIds.filter(id => id !== record.creatorId), people) };
  } else if (["add-source", "remove-source", "add-document", "remove-document"].includes(input.action)) {
    if (next.kind !== "package") throw new WorkflowError("Материалы добавляются в пакет инфоповода");
    if (input.action === "add-source") next.sources = uniqueSources([...next.sources, input.source]);
    if (input.action === "remove-source") next.sources = next.sources.filter(source => source.cardId !== input.source.cardId || source.versionId !== input.source.versionId);
    if (input.action === "add-document") next.documentIds = [...new Set([...next.documentIds, input.documentId])];
    if (input.action === "remove-document") next.documentIds = next.documentIds.filter(id => id !== input.documentId);
    if (next.sources.length > 100 || next.documentIds.length > 100) throw new WorkflowError("В одном пакете может быть до 100 источников и материалов");
  } else {
    if (next.kind !== "dispute") throw new WorkflowError("Это действие относится к разбору источников");
    if (record.responsibleId !== user.id && user.role !== "admin") throw new WorkflowError("Решение фиксирует ответственный", 403);
    next = { ...next, status: input.action === "resolve" ? "resolved" : "open", decision: input.action === "resolve" ? input.decision : null };
  }
  return { ...next, version: record.version + 1,
    updatedAt: new Date(Math.max(Date.now(), Date.parse(record.updatedAt) + 1)).toISOString(),
    lastOperationId: input.operationId, lastOperationDigest: operationDigest,
  };
}
