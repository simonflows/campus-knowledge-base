import { createHash } from "node:crypto";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
  type ScanCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { docClient, getStorageMode } from "./db";
import { TableName } from "./schema";
import { canSeeCard, canUseStaffWorkflow, type SessionUser } from "./auth";
import { staffDirectory } from "./account-directory";
import { getKnowledgeCardById } from "./models";
import {
  presentInformationRequest,
  canSeeInformationRequest,
  canAnswerInformationRequest,
  informationRequestCardOwner,
  type InformationRequest,
  type createInformationRequestSchema,
  type updateInformationRequestSchema,
} from "./information-requests";
import type { z } from "zod";
import { folderIds, getApprovedVersion, getUniversityFullName, type KnowledgeCard, type ProjectCard } from "./knowledge";
import { knowledgeSourceSchema } from "./validation/knowledge";
export class RequestError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function requireRequestStorage() {
  if (await getStorageMode() !== "dynamodb")
    throw new RequestError("Общая база временно недоступна", 503);
}
async function requestAssignee(recipientUniversityId: string, id: string | null | undefined) {
  if (!id) return { responsibleId: null, responsibleName: "" };
  const person = (await staffDirectory()).find(person => person.id === id && person.universityId === recipientUniversityId && ["university_owner", "university_pr"].includes(person.role));
  if (!person) throw new RequestError("Выберите ответственного из вуза-получателя", 400);
  return { responsibleId: person.id, responsibleName: person.name };
}
export async function getInformationRequest(id: string) {
  await requireRequestStorage();
  const result = await docClient.send(
    new GetCommand({
      TableName: TableName.INFORMATION_REQUESTS,
      Key: { id },
      ConsistentRead: true,
    })
  );
  return result.Item as InformationRequest | undefined;
}
export async function presentRequestFor(user: SessionUser, item: InformationRequest, readCard = getKnowledgeCardById) {
  const [linked, candidate] = await Promise.all([item.linkedCardId ? readCard(item.linkedCardId) : null, item.candidateCardId ? readCard(item.candidateCardId) : null]);
  return presentInformationRequest(item, user, linked, candidate);
}
export async function countIncomingRequests(user: SessionUser) {
  if (!user.universityId || !["university_pr", "university_owner"].includes(user.role)) return 0;
  await requireRequestStorage();
  let count = 0;
  let cursor: ScanCommandOutput["LastEvaluatedKey"];
  do {
    const page: ScanCommandOutput = await docClient.send(new ScanCommand({
      TableName: TableName.INFORMATION_REQUESTS, Select: "COUNT", ExclusiveStartKey: cursor,
      FilterExpression: "recipientUniversityId = :university AND #status = :open",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":university": user.universityId, ":open": "open" },
    }));
    count += page.Count ?? 0;
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return count;
}

export async function listInformationRequests(user: SessionUser) {
  if (!canUseStaffWorkflow(user)) throw new RequestError("Запросы доступны сотрудникам", 403);
  await requireRequestStorage();
  const items: InformationRequest[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result: ScanCommandOutput = await docClient.send(
      new ScanCommand({
        TableName: TableName.INFORMATION_REQUESTS,
        ExclusiveStartKey: cursor,
        ConsistentRead: true,
      })
    );
    items.push(
      ...((result.Items ?? []) as InformationRequest[]).filter((item) =>
        canSeeInformationRequest(user, item)
      )
    );
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  const cards = new Map<string, Promise<KnowledgeCard | null>>();
  const readCard = (id: string) => {
    const read = cards.get(id) ?? getKnowledgeCardById(id);
    cards.set(id, read);
    return read;
  };
  return Promise.all(items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(item => presentRequestFor(user, item, readCard)));
}
function replayCreation(
  item: InformationRequest | undefined,
  authorId: string,
  creationDigest: string
) {
  if (item?.creationDigest === creationDigest && item.authorId === authorId)
    return item;
  throw new RequestError("Повторный запрос изменён: обновите форму", 409);
}

export async function createInformationRequest(
  user: SessionUser,
  input: z.infer<typeof createInformationRequestSchema>
) {
  if (!canUseStaffWorkflow(user))
    throw new RequestError("Отправка запросов доступна сотрудникам", 403);
  const id = digest([user.id, input.operationId]);
  const creationDigest = digest(input);
  const existing = await getInformationRequest(id);
  if (existing) return replayCreation(existing, user.id, creationDigest);

  if (input.recipientUniversityId === user.universityId)
    throw new RequestError("Выберите другой вуз-получатель", 400);
  if (input.linkedCardId) {
    const card = await getKnowledgeCardById(input.linkedCardId);
    if (!card || (!canSeeCard(user, card) && !getApprovedVersion(card)))
      throw new RequestError("Карточка недоступна", 404);
  }
  const now = new Date().toISOString();
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
    ...await requestAssignee(input.recipientUniversityId, input.responsibleId),
    dueDate: input.dueDate ?? null,
  };
  try {
    await docClient.send(
      new PutCommand({
        TableName: TableName.INFORMATION_REQUESTS,
        Item: item,
        ConditionExpression: "attribute_not_exists(id)",
      })
    );
    return item;
  } catch (error) {
    if ((error as Error).name !== "ConditionalCheckFailedException")
      throw error;
    return replayCreation(await getInformationRequest(id), user.id, creationDigest);
  }
}
export async function mutateInformationRequest(
  user: SessionUser,
  id: string,
  input: z.infer<typeof updateInformationRequestSchema>
) {
  if (!canUseStaffWorkflow(user)) throw new RequestError("Запросы доступны сотрудникам", 403);
  const item = await getInformationRequest(id);
  if (!item || !canSeeInformationRequest(user, item))
    throw new RequestError("Запрос не найден", 404);
  if (input.action === "answer" && !canAnswerInformationRequest(user, item))
    throw new RequestError("Отвечать может только вуз-получатель", 403);
  const operationDigest = digest(input);
  if (item.lastOperationId === input.operationId) {
    if (item.lastOperationDigest === operationDigest) return item;
    throw new RequestError("Этот повтор операции отличается от исходного", 409);
  }
  if (item.revision !== input.revision)
    throw new RequestError("Запрос изменился. Обновите страницу", 409);
  const now = new Date().toISOString();
  const next: InformationRequest = {
    ...item,
    revision: item.revision + 1,
    updatedAt: now,
    lastOperationId: input.operationId,
    lastOperationDigest: operationDigest,
  };
  if (input.action === "join" || input.action === "leave") {
    if (input.action === "leave" && item.authorId === user.id)
      throw new RequestError("Автор продолжает получать результат своего запроса", 400);
    const participants = new Set(item.participantIds ?? [item.authorId]);
    if (input.action === "join") participants.add(user.id);
    else participants.delete(user.id);
    next.participantIds = [...participants];
  } else if (input.action === "assign") {
    Object.assign(next, await requestAssignee(item.recipientUniversityId, input.responsibleId), { dueDate: input.dueDate });
  } else if (input.action === "answer") {
    if (item.status !== "open")
      throw new RequestError("На этот запрос уже ответили", 409);
    Object.assign(next, {
      answer: input.answer,
      evidenceUrl: input.evidenceUrl,
      answeredBy: user.id,
      status: "answered",
    });
  } else if (input.action === "submit") {
    if (item.status !== "answered" || !item.answer || !item.evidenceUrl)
      throw new RequestError("Сначала нужен ответ с источником", 409);
    const source = knowledgeSourceSchema.safeParse({ title: "Источник из ответа", url: item.evidenceUrl });
    if (!source.success)
      throw new RequestError("Источник из ответа должен быть HTTPS-ссылкой без логина и пароля", 409);
    const cardId = `request-${id}`;
    const owner = informationRequestCardOwner(item, await staffDirectory());
    const card: ProjectCard = {
      id: cardId,
      type: "project",
      title: item.subject,
      folderId: folderIds.subfolder(item.recipientUniversityId, "products"),
      owners: [owner?.ownershipLabel ?? getUniversityFullName(item.recipientUniversityId)],
      ownerIds: owner ? [owner.id] : [],
      referenceDescription: item.answer,
      sources: [source.data],
      stopFormula:
        "Ответ на запрос: не использовать как утверждённый факт до проверки координатором.",
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
    Object.assign(next, { status: "submitted", candidateCardId: cardId });
    try {
      await docClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TableName.INFORMATION_REQUESTS,
                Item: next,
                ConditionExpression: "revision = :revision",
                ExpressionAttributeValues: { ":revision": item.revision },
              },
            },
            {
              Put: {
                TableName: TableName.KNOWLEDGE_CARDS,
                Item: card,
                ConditionExpression: "attribute_not_exists(id)",
              },
            },
          ],
        })
      );
      return next;
    } catch (error) {
      if (
        error instanceof TransactionCanceledException &&
        error.CancellationReasons?.some(
          ({ Code }) => Code && !["None", "ConditionalCheckFailed", "TransactionConflict"].includes(Code)
        )
      ) throw error;
      if ((error as Error).name === "TransactionCanceledException") {
        const current = await getInformationRequest(id);
        if (
          current?.lastOperationId === input.operationId &&
          current.lastOperationDigest === operationDigest
        )
          return current;
        throw new RequestError("Данные изменились. Обновите страницу", 409);
      }
      throw error;
    }
  }
  try {
    await docClient.send(
      new PutCommand({
        TableName: TableName.INFORMATION_REQUESTS,
        Item: next,
        ConditionExpression: "revision = :revision",
        ExpressionAttributeValues: { ":revision": item.revision },
      })
    );
    return next;
  } catch (error) {
    if ((error as Error).name === "ConditionalCheckFailedException") {
      const current = await getInformationRequest(id);
      if (
        current?.lastOperationId === input.operationId &&
        current.lastOperationDigest === operationDigest
      )
        return current;
      throw new RequestError("Данные изменились. Обновите страницу", 409);
    }
    throw error;
  }
}
