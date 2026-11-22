import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  type ScanCommandInput,
  type ScanCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import type { SessionUser } from "./auth";
import { sessionDirectory } from "./pilot-auth";
import { docClient, isDatabaseAvailable } from "./db";
import { getReadableStorageMode } from "./runtime-storage-policy";
import { TableName } from "./schema";
import { checkFactText } from "./fact-check";
import { getArticleById, getCanonicalKnowledgeCards } from "./models";
import { isApprovedArticle, articleSeed, type ReadyArticle } from "./articles";
import { createPendingDiskSync, observedExportCondition } from "./disk-sync";
import { readLocalStore } from "./local-store";
import { getUniversityById } from "./knowledge";
import {
  EditorialError,
  canReadEditorial,
  editorialContentSchema,
  editorialText,
  validateEditorialAction,
  type EditorialContent,
  type EditorialDocument,
  type EditorialMutation,
  type EditorialRevision,
  type EditorialEvent,
} from "./editorial";

async function available() {
  if (!(await isDatabaseAvailable()))
    throw new EditorialError(
      "Постоянное хранилище DynamoDB недоступно. Текст остаётся на этом устройстве до успешной отправки.",
      503
    );
}
async function scan<T>(
  table: TableName,
  filter?: Pick<
    ScanCommandInput,
    "FilterExpression" | "ExpressionAttributeNames" | "ExpressionAttributeValues"
  >
): Promise<T[]> {
  const rows: T[] = [];
  let key: ScanCommandOutput["LastEvaluatedKey"];
  do {
    const result: ScanCommandOutput = await docClient.send(
      new ScanCommand({
        ...filter,
        TableName: table,
        ExclusiveStartKey: key,
        ConsistentRead: true,
      })
    );
    rows.push(...((result.Items ?? []) as T[]));
    key = result.LastEvaluatedKey;
  } while (key);
  return rows;
}
export async function listEditorial(user: SessionUser) {
  if (!(await isDatabaseAvailable())) return [];
  return (await scan<EditorialDocument>(TableName.EDITORIAL_DOCUMENTS))
    .filter((doc) => canReadEditorial(user, doc))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
async function getReadableEditorialHead(id: string, user: SessionUser) {
  const { Item } = await docClient.send(
    new GetCommand({
      TableName: TableName.EDITORIAL_DOCUMENTS,
      Key: { id },
      ConsistentRead: true,
    })
  );
  const doc = Item as EditorialDocument | undefined;
  if (!doc || !canReadEditorial(user, doc))
    throw new EditorialError("Черновик не найден", 404);
  return doc;
}

type EditorialEventRecord = {
  id: string;
  kind: "event";
  documentId: string;
  event?: EditorialEvent;
};
type EditorialHistoryRecord = EditorialRevision | EditorialEventRecord;

function isEditorialEvent(
  item: EditorialHistoryRecord
): item is EditorialEventRecord {
  return "kind" in item && item.kind === "event";
}

function isReadableRevision(
  item: EditorialHistoryRecord,
  doc: EditorialDocument,
  user: SessionUser
): item is EditorialRevision {
  return (
    item.documentId === doc.id &&
    !isEditorialEvent(item) &&
    item.number <= doc.version &&
    (doc.ownerId === user.id || item.id === doc.submittedRevisionId)
  );
}

function readableRevisions(
  history: EditorialHistoryRecord[],
  doc: EditorialDocument,
  user: SessionUser
) {
  return history
    .filter((item) => isReadableRevision(item, doc, user))
    .sort((a, b) => b.number - a.number);
}

async function scanEditorialHistory(
  doc: EditorialDocument,
  user: SessionUser,
  scope: "events" | "revisions" | "both"
) {
  const names: Record<string, string> = {
    "#documentId": "documentId",
    "#kind": "kind",
  };
  const values: Record<string, string | number> = {
    ":documentId": doc.id,
    ":event": "event",
  };
  const conditions: string[] = [];
  if (scope !== "revisions") conditions.push("#kind = :event");

  const owner = doc.ownerId === user.id;
  if (scope !== "events" && (owner || doc.submittedRevisionId)) {
    names["#number"] = "number";
    values[":version"] = doc.version;
    // Revision records have no kind, including those written before events had their own rows.
    let revision =
      "(attribute_not_exists(#kind) OR #kind <> :event) AND #number <= :version";
    if (!owner && doc.submittedRevisionId) {
      names["#id"] = "id";
      values[":submittedRevisionId"] = doc.submittedRevisionId;
      revision += " AND #id = :submittedRevisionId";
    }
    conditions.push(revision);
  }

  if (!conditions.length) return [];
  const condition = conditions.length === 1
    ? conditions[0]
    : `(${conditions[0]} OR (${conditions[1]}))`;
  return scan<EditorialHistoryRecord>(TableName.EDITORIAL_REVISIONS, {
    FilterExpression: `#documentId = :documentId AND ${condition}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  });
}

async function readEditorial(
  id: string,
  user: SessionUser,
  includeRevisions: boolean
) {
  await available();
  let doc = await getReadableEditorialHead(id, user);
  for (let attempt = 0; attempt < 3; attempt++) {
    const history = await scanEditorialHistory(
      doc,
      user,
      includeRevisions ? "both" : "events"
    );
    // A consistent scan can still see events committed after the first read.
    const latest = await getReadableEditorialHead(id, user);
    if (latest.version !== doc.version) {
      doc = latest;
      continue;
    }

    const combined = new Map(doc.events.map((item) => [item.id, item]));
    for (const item of history) {
      if (isEditorialEvent(item) && item.documentId === id && item.event)
        combined.set(item.event.id, item.event);
    }
    return {
      document: {
        ...doc,
        events: [...combined.values()].sort((a, b) => a.at.localeCompare(b.at)),
      },
      revisions: includeRevisions ? readableRevisions(history, doc, user) : [],
    };
  }
  throw new EditorialError("Черновик сейчас изменяется. Повторите запрос.", 409);
}

export async function getEditorial(id: string, user: SessionUser) {
  return (await readEditorial(id, user, false)).document;
}

export function getEditorialWithRevisions(id: string, user: SessionUser) {
  return readEditorial(id, user, true);
}

export async function getEditorialRevisions(
  doc: EditorialDocument,
  user: SessionUser
) {
  if (!canReadEditorial(user, doc))
    throw new EditorialError("Черновик не найден", 404);
  const history = await scanEditorialHistory(doc, user, "revisions");
  return readableRevisions(history, doc, user);
}

async function getEditorialRevision(
  doc: EditorialDocument,
  user: SessionUser,
  revisionId: string
) {
  if (doc.ownerId !== user.id && revisionId !== doc.submittedRevisionId)
    throw new EditorialError("Редакция не найдена", 404);
  const { Item } = await docClient.send(
    new GetCommand({
      TableName: TableName.EDITORIAL_REVISIONS,
      Key: { id: revisionId },
      ConsistentRead: true,
    })
  );
  const item = Item as EditorialHistoryRecord | undefined;
  if (!item || item.id !== revisionId || !isReadableRevision(item, doc, user))
    throw new EditorialError("Редакция не найдена", 404);
  return item;
}
export function canReadLegacyArticle(user: SessionUser | null, article: ReadyArticle) {
  return !isApprovedArticle(article) && Boolean(user && (user.role === "admin" ||
    (["university_owner", "university_pr"].includes(user.role) && user.universityId === article.universityId)));
}

export async function listLegacyArticles(user: SessionUser | null): Promise<ReadyArticle[]> {
  if (!user || user.role === "guest") return [];
  const visible = (article: ReadyArticle) => canReadLegacyArticle(user, article);
  const mode = await getReadableStorageMode();
  if (mode === "static-export") return articleSeed.filter(visible);
  if (mode === "local-json") return (await readLocalStore()).articles.filter(visible);
  return (await scan<ReadyArticle>(TableName.ARTICLES)).filter(visible);
}
function event(
  user: SessionUser,
  action: EditorialEvent["action"],
  revisionId: string,
  comment = ""
): EditorialEvent {
  return {
    id: crypto.randomUUID(),
    action,
    revisionId,
    actorId: user.id,
    actorName: user.name,
    at: new Date().toISOString(),
    comment,
  };
}
function validateUniversity(user: SessionUser, content: EditorialContent) {
  if (!content.universityId) return;
  if (!getUniversityById(content.universityId))
    throw new EditorialError("Выберите вуз из списка резидентов");
  if (
    (user.role === "university_owner" || user.role === "university_pr") &&
    content.universityId !== user.universityId
  )
    throw new EditorialError(
      "Представитель вуза готовит материалы в папке своего университета",
      403
    );
}
async function normalizeSources(
  content: EditorialContent
): Promise<EditorialContent> {
  if (!content.sourceCardIds.length)
    return { ...content, sourceCardTitles: [] };
  const cards = await getCanonicalKnowledgeCards();
  return {
    ...content,
    sourceCardTitles: content.sourceCardIds.map(
      (id) =>
        cards.find((c) => c.id === id)?.title || `Источник недоступен (${id})`
    ),
  };
}
export async function getEditorialReviewers(doc: EditorialDocument) {
  const cards = await getCanonicalKnowledgeCards();
  const university = getUniversityById(doc.content.universityId);
  const shared = cards
    .filter((card) => doc.content.sourceCardIds.includes(card.id))
    .some((card) => {
      if (card.type === "campus") return true;
      if (card.type === "project")
        return (
          card.isJoint ||
          card.initiatorUniversityId !== doc.content.universityId
        );
      if (card.type === "university")
        return card.universityId !== doc.content.universityId;
      if (card.type === "laboratory")
        return (
          !university ||
          ![university.shortName, university.fullName].includes(
            card.affiliation
          )
        );
      return !card.folderId.startsWith(
        `01_universities/${doc.content.universityId}/`
      );
    });
  return sessionDirectory()
    .filter(
      (account) =>
        account.id !== doc.ownerId &&
        (account.role === "admin" ||
          (!shared &&
            account.role === "university_owner" &&
            account.universityId === doc.content.universityId))
    )
    .map((account) => ({
      id: account.id,
      name: account.name,
      role: account.role,
      organization: account.organization,
    }))
    .sort((a, b) =>
      a.role === "university_owner" ? -1 : b.role === "university_owner" ? 1 : 0
    );
}
export async function createEditorial(
  user: SessionUser,
  input: {
    content: EditorialContent;
    originalId?: string;
    channel: string;
    legacyArticleId?: string;
  }
) {
  await available();
  if (user.role === "guest")
    throw new EditorialError("Гость не может сохранять личные черновики", 403);
  const id = crypto.randomUUID(),
    revisionId = crypto.randomUUID(),
    now = new Date().toISOString();
  let content = input.content;
  let originalId = id;
  if (input.originalId) {
    const original = await getEditorial(input.originalId, user);
    if (original.ownerId !== user.id)
      throw new EditorialError("Вариант создаёт автор оригинала", 403);
    originalId = original.originalId;
  }
  if (input.legacyArticleId) {
    const legacy = (await listLegacyArticles(user)).find(
      (a) => a.id === input.legacyArticleId
    );
    if (!legacy) throw new EditorialError("Архивная статья не найдена", 404);
    content = editorialContentSchema.parse({
      ...legacy,
      ...input.content,
      title: input.content.title || legacy.title,
      lead: input.content.lead || legacy.lead,
      sections: input.content.sections.length
        ? input.content.sections
        : legacy.sections,
      sourceCardIds: legacy.sourceCardIds,
      sourceCardTitles: legacy.sourceCardTitles,
    });
  }
  content = await normalizeSources(content);
  const doc: EditorialDocument = {
    id,
    ownerId: user.id,
    ownerName: user.name,
    originalId,
    channel: input.channel,
    version: 1,
    revisionId,
    submittedRevisionId: null,
    approvedRevisionId: null,
    status: "draft",
    content,
    createdAt: now,
    updatedAt: now,
    events: [event(user, "created", revisionId)],
    ...(input.legacyArticleId
      ? { legacyArticleId: input.legacyArticleId }
      : {}),
  };
  validateUniversity(user, content);
  const revision: EditorialRevision = {
    id: revisionId,
    documentId: id,
    number: 1,
    content,
    actorId: user.id,
    actorName: user.name,
    createdAt: now,
  };
  await docClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TableName.EDITORIAL_DOCUMENTS,
            Item: doc,
            ConditionExpression: "attribute_not_exists(id)",
          },
        },
        {
          Put: {
            TableName: TableName.EDITORIAL_REVISIONS,
            Item: revision,
            ConditionExpression: "attribute_not_exists(id)",
          },
        },
        {
          Put: {
            TableName: TableName.EDITORIAL_REVISIONS,
            Item: {
              id: doc.events[0].id,
              documentId: id,
              kind: "event",
              event: doc.events[0],
            },
            ConditionExpression: "attribute_not_exists(id)",
          },
        },
      ],
    })
  );
  return doc;
}
export async function mutateEditorial(
  id: string,
  user: SessionUser,
  mutation: EditorialMutation
) {
  const current = await getEditorial(id, user);
  validateEditorialAction(user, current, mutation);
  const now = new Date().toISOString();
  const next: EditorialDocument = {
    ...current,
    version: current.version + 1,
    updatedAt: now,
  };
  let revision: EditorialRevision | undefined;
  let publication: ReadyArticle | undefined;
  let previousPublication: ReadyArticle | null = null;
  let action: EditorialEvent["action"] = "saved";
  if (mutation.action === "save" || mutation.action === "restore") {
    let content: EditorialContent;
    if (mutation.action === "save") content = mutation.content;
    else {
      const old = await getEditorialRevision(current, user, mutation.revisionId);
      content = old.content;
    }
    content = await normalizeSources(content);
    const revisionId = crypto.randomUUID();
    revision = {
      id: revisionId,
      documentId: id,
      number: next.version,
      content,
      actorId: user.id,
      actorName: user.name,
      createdAt: now,
      ...(mutation.action === "restore"
        ? { restoredFrom: mutation.revisionId }
        : {}),
    };
    next.content = content;
    validateUniversity(user, content);
    next.revisionId = revisionId;
    next.status = "draft";
    next.submittedRevisionId = null;
    action = mutation.action === "save" ? "saved" : "restored";
  } else {
    const target = await getEditorialRevision(current, user, mutation.revisionId);
    if (mutation.action === "submit" || mutation.action === "approve") {
      if (
        !target.content.title.trim() ||
        !target.content.lead.trim() ||
        !target.content.sections.some((s) =>
          s.chunks.some((c) => c.content.trim())
        ) ||
        !target.content.universityId
      )
        throw new EditorialError(
          "Для согласования заполните заголовок, лид, вуз и хотя бы один абзац"
        );
    }
    if (mutation.action === "submit") {
      const reviewers = await getEditorialReviewers(current);
      const reviewer = reviewers.find(
        (candidate) => mutation.reviewerId ? candidate.id === mutation.reviewerId : candidate.role === "admin"
      );
      if (!reviewer)
        throw new EditorialError(
          "Выберите руководителя своего вуза; межвузовские материалы направляются координатору",
          403
        );
      next.reviewerId = reviewer.id;
      next.reviewerName = reviewer.name;
      next.submittedOnce = true;
      next.status = "submitted";
      next.submittedRevisionId = mutation.revisionId;
      action = "submitted";
    }
    if (mutation.action === "return") {
      next.status = "returned";
      action = "returned";
    }
    if (mutation.action === "comment") action = "commented";
    if (mutation.action === "approve") {
      const allowedReviewers = await getEditorialReviewers(current);
      if (!allowedReviewers.some((reviewer) => reviewer.id === user.id))
        throw new EditorialError(
          "Этот материал требует согласования координатором",
          403
        );
      const cards = await getCanonicalKnowledgeCards();
      if (!cards.length)
        throw new EditorialError("Нет официальных данных для проверки", 409);
      const check = checkFactText(editorialText(target.content), cards);
      if (check.summary.red > 0)
        throw new EditorialError(
          "Согласование заблокировано: исправьте красные замечания фактчека",
          422
        );
      const ids = target.content.sourceCardIds;
      const sources = cards.filter((c) => ids.includes(c.id));
      if (!sources.length || sources.length !== new Set(ids).size)
        throw new EditorialError(
          "Укажите доступные источники официальных данных",
          422
        );
      next.status = "approved";
      next.approvedRevisionId = target.id;
      action = "approved";
      previousPublication = current.approvedRevisionId ? await getArticleById(id) : null;
      publication = {
        title: target.content.title,
        lead: target.content.lead,
        sections: target.content.sections,
        sourceCardIds: ids,
        sourceCardTitles: ids.map(
          (id) => sources.find((c) => c.id === id)!.title
        ),
        universityId: target.content.universityId,
        projectTitle: target.content.projectTitle,
        topic: target.content.topic,
        query: "",
        id,
        originalDraftId: current.originalId,
        channel: current.channel,
        createdAt: current.createdAt,
        updatedAt: now,
        approval: {
          revisionId: target.id,
          approvedBy: user.id,
          approvedAt: now,
        },
        diskSync: createPendingDiskSync(previousPublication?.diskSync),
      };
    }
  }
  next.events = [
    ...current.events,
    event(
      user,
      action,
      mutation.action === "comment" ? mutation.revisionId : next.revisionId,
      "comment" in mutation ? mutation.comment : ""
    ),
  ];
  // Keep immutable events separately: autosave history cannot exhaust the head item.
  const head = { ...next, events: next.events.slice(-20) };
  const writes: NonNullable<
    ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]
  > = [
    {
      Put: {
        TableName: TableName.EDITORIAL_DOCUMENTS,
        Item: head,
        ConditionExpression: "#version = :version",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: { ":version": current.version },
      },
    },
  ];
  const latestEvent = next.events[next.events.length - 1];
  writes.push({
    Put: {
      TableName: TableName.EDITORIAL_REVISIONS,
      Item: {
        id: latestEvent.id,
        documentId: id,
        kind: "event",
        event: latestEvent,
      },
      ConditionExpression: "attribute_not_exists(id)",
    },
  });
  if (revision)
    writes.push({
      Put: {
        TableName: TableName.EDITORIAL_REVISIONS,
        Item: revision,
        ConditionExpression: "attribute_not_exists(id)",
      },
    });
  if (publication) {
    const observed = previousPublication && observedExportCondition(previousPublication);
    const condition = observed && previousPublication?.approval
      ? {
          ...observed,
          ConditionExpression: observed.ConditionExpression + " AND approval.revisionId = :previousRevision",
          ExpressionAttributeValues: { ...observed.ExpressionAttributeValues, ":previousRevision": previousPublication.approval.revisionId },
        }
      : { ConditionExpression: "attribute_not_exists(id)" };
    writes.push({ Put: { TableName: TableName.ARTICLES, Item: publication, ...condition } });
  }
  try {
    await docClient.send(new TransactWriteCommand({ TransactItems: writes }));
  } catch (error) {
    if (
      error instanceof TransactionCanceledException &&
      error.CancellationReasons?.some(
        ({ Code }) => Code && !["None", "ConditionalCheckFailed", "TransactionConflict"].includes(Code)
      )
    ) throw error;
    if (
      error instanceof Error &&
      [
        "TransactionCanceledException",
        "ConditionalCheckFailedException",
      ].includes(error.name)
    )
      throw new EditorialError(
        "Редакция изменилась в другой вкладке. Обновите данные и сравните свой текст",
        409
      );
    throw error;
  }
  return { document: next, publication };
}
