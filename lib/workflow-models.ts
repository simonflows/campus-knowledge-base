import { GetCommand, ScanCommand, TransactWriteCommand, type ScanCommandInput, type ScanCommandOutput } from "@aws-sdk/lib-dynamodb";
import { canSeeCard, canUseStaffWorkflow, type SessionUser } from "./auth";
import { docClient, isDatabaseAvailable } from "./db";
import { getEditorial } from "./editorial-models";
import { getApprovedVersion } from "./knowledge";
import { ensureApprovedCardVersion, getApprovedCardVersion, getCardVersionId } from "./knowledge-versions";
import { getKnowledgeCardById } from "./models";
import { TableName } from "./schema";
import { staffDirectory } from "./account-directory";
import type { SourceVersionReference } from "./source-references";
import { applyWorkflowMutation, canReadWorkflow, makeWorkflowRecord, WorkflowError, workflowDigest, type WorkflowRecord, type CreateWorkflowInput, type WorkflowMutation, type WorkflowEvent } from "./workflow";

export type WorkflowPresentation = { record: WorkflowRecord; sourceDetails: { cardId: string; versionId: string; title: string }[]; materialDetails: { id: string; title: string; channel: string; status: string }[] };
async function available() {
  if (!(await isDatabaseAvailable())) throw new WorkflowError("Общая база временно недоступна", 503);
}
async function scan<T>(filter: Pick<ScanCommandInput, "FilterExpression" | "ExpressionAttributeNames" | "ExpressionAttributeValues">): Promise<T[]> {
  const rows: T[] = [];
  let cursor: ScanCommandOutput["LastEvaluatedKey"];
  do {
    const page: ScanCommandOutput = await docClient.send(new ScanCommand({ TableName: TableName.WORKFLOW_RECORDS, ConsistentRead: true, ExclusiveStartKey: cursor, ...filter }));
    rows.push(...((page.Items ?? []) as T[])); cursor = page.LastEvaluatedKey;
  } while (cursor);
  return rows;
}
async function rawRecord(id: string): Promise<WorkflowRecord | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TableName.WORKFLOW_RECORDS, Key: { id }, ConsistentRead: true }));
  return Item && (Item.kind === "package" || Item.kind === "dispute") ? Item as WorkflowRecord : null;
}
function readable(user: SessionUser, record: WorkflowRecord | null): asserts record is WorkflowRecord {
  if (!record || !canReadWorkflow(user, record)) throw new WorkflowError("Запись не найдена", 404);
}
async function sourceFor(user: SessionUser, source: SourceVersionReference, captureBaseline = false) {
  const card = await getKnowledgeCardById(source.cardId);
  if (!card || (!canSeeCard(user, card) && !getApprovedVersion(card))) throw new WorkflowError("Источник недоступен", 404);
  let version = await getApprovedCardVersion(source.versionId);
  const approved = getApprovedVersion(card);
  if (!version && captureBaseline && approved && getCardVersionId(approved) === source.versionId)
    version = await ensureApprovedCardVersion(approved, { id: user.id, name: user.name });
  if (!version || version.cardId !== source.cardId) throw new WorkflowError("Утверждённая версия источника недоступна", 404);
  return { cardId: source.cardId, versionId: version.id, title: version.snapshot.title };
}
async function materialFor(user: SessionUser, id: string) {
  const document = await getEditorial(id, user);
  return { id: document.id, title: document.content.title || "Материал без названия", channel: document.channel, status: document.status };
}
async function optional<T>(read: () => Promise<T>): Promise<T | null> {
  try { return await read(); } catch (error) {
    if (error instanceof Error && "status" in error && [403, 404].includes(Number(error.status))) return null;
    throw error;
  }
}
async function present(user: SessionUser, record: WorkflowRecord): Promise<WorkflowPresentation> {
  if (record.kind !== "package") return { record, sourceDetails: [], materialDetails: [] };
  const sources = await Promise.all(record.sources.map(source => optional(() => sourceFor(user, source))));
  const materials = await Promise.all(record.documentIds.map(id => optional(() => materialFor(user, id))));
  const sourceDetails = sources.filter((row): row is NonNullable<typeof row> => row !== null);
  const materialDetails = materials.filter((row): row is NonNullable<typeof row> => row !== null);
  return { record: { ...record, sources: sourceDetails.map(({ cardId, versionId }) => ({ cardId, versionId })), documentIds: materialDetails.map(row => row.id) }, sourceDetails, materialDetails };
}
function eventFor(record: WorkflowRecord, user: SessionUser, operationId: string, action: string, message: string): WorkflowEvent {
  return { id: `${record.id}:event:${operationId}`, kind: "workflow-event", recordId: record.id, actorId: user.id, actorName: user.name, at: record.updatedAt, action, message, version: record.version };
}
function insertEvent(event: WorkflowEvent) {
  return { Put: { TableName: TableName.WORKFLOW_RECORDS, Item: event, ConditionExpression: "attribute_not_exists(id)" } };
}
export async function listWorkflowRecords(user: SessionUser): Promise<WorkflowPresentation[]> {
  await available();
  if (!canUseStaffWorkflow(user)) throw new WorkflowError("Рабочие записи доступны сотрудникам", 403);
  const rows = await scan<WorkflowRecord>({ FilterExpression: "#kind IN (:package, :dispute)", ExpressionAttributeNames: { "#kind": "kind" }, ExpressionAttributeValues: { ":package": "package", ":dispute": "dispute" } });
  return Promise.all(rows.filter(row => canReadWorkflow(user, row)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(row => present(user, row)));
}
export async function createWorkflowRecord(user: SessionUser, input: CreateWorkflowInput): Promise<WorkflowRecord> {
  if (!canUseStaffWorkflow(user)) throw new WorkflowError("Рабочие записи доступны сотрудникам", 403);
  await available();
  const record = makeWorkflowRecord(user, input, await staffDirectory());
  const replay = (current: WorkflowRecord | null) => {
    if (current && current.creatorId === user.id && current.creationDigest === record.creationDigest) return current;
    throw new WorkflowError("Повтор создания содержит другие данные", 409);
  };
  const existing = await rawRecord(record.id);
  if (existing) return replay(existing);
  if (record.kind === "package") {
    for (const source of record.sources) await sourceFor(user, source, true);
    for (const id of record.documentIds) await materialFor(user, id);
  } else if (record.cardId) {
    const card = await getKnowledgeCardById(record.cardId);
    if (!card || !canSeeCard(user, card)) throw new WorkflowError("Карточка недоступна", 404);
  }
  try {
    await docClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: TableName.WORKFLOW_RECORDS, Item: record, ConditionExpression: "attribute_not_exists(id)" } },
      insertEvent(eventFor(record, user, input.operationId, "created", "Создана рабочая запись")),
    ] }));
    return record;
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      const current = await rawRecord(record.id);
      if (current) return replay(current);
      throw new WorkflowError("Не удалось сохранить запись. Повторите попытку", 503);
    }
    throw error;
  }
}
export async function getWorkflowRecord(user: SessionUser, id: string): Promise<WorkflowPresentation> {
  await available(); const record = await rawRecord(id); readable(user, record); return present(user, record);
}
export async function mutateWorkflowRecord(user: SessionUser, id: string, input: WorkflowMutation): Promise<WorkflowRecord> {
  await available(); const record = await rawRecord(id); readable(user, record);
  const next = applyWorkflowMutation(user, record, input, await staffDirectory());
  if (next === record) return record;
  if (input.action === "add-source") await sourceFor(user, input.source, true);
  if (input.action === "add-document") await materialFor(user, input.documentId);
  const message = input.action === "resolve" ? input.decision : input.action === "reopen" ? input.reason : "Обновлена рабочая запись";
  try {
    await docClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: TableName.WORKFLOW_RECORDS, Item: next, ConditionExpression: "attribute_exists(id) AND #version = :version", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":version": record.version } } },
      insertEvent(eventFor(next, user, input.operationId, input.action, message)),
    ] })); return next;
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      const current = await rawRecord(id); readable(user, current);
      if (current.lastOperationId === input.operationId && current.lastOperationDigest === workflowDigest(input)) return current;
      if (current.version !== record.version) throw new WorkflowError("Запись изменилась. Обновите её", 409);
      throw new WorkflowError("Общая база не смогла сохранить запись", 503);
    }
    throw error;
  }
}
export async function getWorkflowEvents(user: SessionUser, id: string): Promise<WorkflowEvent[]> {
  await available(); readable(user, await rawRecord(id));
  return (await scan<WorkflowEvent>({ FilterExpression: "recordId = :id AND #kind = :kind", ExpressionAttributeNames: { "#kind": "kind" }, ExpressionAttributeValues: { ":id": id, ":kind": "workflow-event" } })).sort((a, b) => a.version - b.version);
}
