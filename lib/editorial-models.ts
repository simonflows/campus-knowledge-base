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
import { getArticleById, getCanonicalKnowledgeCards, getKnowledgeCardById } from "./models";
import {
  articleBasisReference, flattenArticleChunks, isApprovedArticle, articleSeed,
  sameArticleBasisReference, type ArticleBasisReference, type ReadyArticle,
} from "./articles";
import { createPendingDiskSync, observedExportCondition } from "./disk-sync";
import { readLocalStore } from "./local-store";
import { getApprovedVersion, getPublicApprovedCard, getUniversityById, type KnowledgeCard } from "./knowledge";
import { ensureApprovedCardVersion, getApprovedCardVersion, getCardVersionId } from "./knowledge-versions";
import {
  EditorialError,
  canDeleteEditorial,
  canReadEditorial,
  canWriteEditorial,
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

function isEditorialWriteConflict(error: unknown) {
  if (!(error instanceof Error)) return false;
  if (error.name === "ConditionalCheckFailedException") return true;
  return error.name === "TransactionCanceledException" && (
    !(error instanceof TransactionCanceledException) ||
    !error.CancellationReasons?.some(
      ({ Code }) => Code && !["None", "ConditionalCheckFailed", "TransactionConflict"].includes(Code)
    )
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

export async function getCurrentEditorialSnapshot(id: string, user: SessionUser) {
  await available();
  const document = await getReadableEditorialHead(id, user);
  const revision = await getEditorialRevision(document, user, document.revisionId);
  return { document, revision };
}

export async function deleteEditorial(id: string, user: SessionUser, version: number) {
  await available();
  const current = await getReadableEditorialHead(id, user);
  if (!canWriteEditorial(user, current))
    throw new EditorialError("Черновик не найден", 404);
  if (current.version !== version)
    throw new EditorialError("Черновик изменился. Откройте актуальную редакцию.", 409);
  if (!canDeleteEditorial(user, current))
    throw new EditorialError("Удалить можно черновик, который не находится на согласовании и ещё не был утверждён.", 409);

  const audit = event(user, "deleted", current.revisionId);
  try {
    await docClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TableName.EDITORIAL_DOCUMENTS,
            Item: {
              ...current,
              version: current.version + 1,
              updatedAt: audit.at,
              deletedAt: audit.at,
              events: [...current.events, audit].slice(-20),
            },
            ConditionExpression: "#version = :version AND ownerId = :ownerId AND attribute_not_exists(deletedAt)",
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: { ":version": current.version, ":ownerId": user.id },
          },
        },
        {
          Put: {
            TableName: TableName.EDITORIAL_REVISIONS,
            Item: { id: audit.id, documentId: id, kind: "event", event: audit },
            ConditionExpression: "attribute_not_exists(id)",
          },
        },
        {
          ConditionCheck: {
            TableName: TableName.ARTICLES,
            Key: { id },
            ConditionExpression: "attribute_not_exists(id)",
          },
        },
      ],
    }));
  } catch (error) {
    if (isEditorialWriteConflict(error))
      throw new EditorialError("Черновик изменился или уже опубликован. Обновите список.", 409);
    throw error;
  }
}

export async function getEditorialSourceVersions(content: EditorialContent) {
  const pinned = new Map(content.sourceVersions?.map((source) => [source.cardId, source.versionId]));
  return Promise.all([...new Set(content.sourceCardIds)].map(async (id) => {
    const versionId = pinned.get(id);
    const [card, version] = await Promise.all([
      getKnowledgeCardById(id),
      versionId ? getApprovedCardVersion(versionId) : null,
    ]);
    const available = card && getPublicApprovedCard(card);
    return {
      id,
      available: Boolean(available),
      version: available && version?.cardId === id && getCardVersionId(version.snapshot) === versionId
        ? version : null,
    };
  }));
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
async function validateArticleBasis(
  references: ArticleBasisReference[],
  missingStatus = 404,
) {
  const publications = await Promise.all([...new Set(references.map(({ articleId }) => articleId))]
    .map(getArticleById));
  if (publications.some((publication) => !publication || !isApprovedArticle(publication)))
    throw new EditorialError("Утверждённая статья недоступна. Снова выберите опорный блок.", missingStatus);

  return publications.flatMap((publication) => {
    if (!publication?.approval) return [];
    const { id, approval, updatedAt } = publication;
    const chunks = flattenArticleChunks(publication);
    for (const reference of references.filter(({ articleId }) => articleId === id)) {
      if (approval.revisionId !== reference.revisionId)
        throw new EditorialError("Редакция опорной статьи изменилась. Снова выберите блок.", 409);
      const matches = chunks.filter((chunk) => chunk.chunkId === reference.chunkId);
      const approved = matches.length === 1 ? articleBasisReference(matches[0]) : null;
      if (!approved || !sameArticleBasisReference(approved, reference))
        throw new EditorialError("Блок опорной статьи не совпадает с утверждённой редакцией.", 422);
    }
    return [{
      ConditionCheck: {
        TableName: TableName.ARTICLES,
        Key: { id },
        ConditionExpression: "approval.revisionId = :basisRevision AND updatedAt = :basisUpdated",
        ExpressionAttributeValues: { ":basisRevision": approval.revisionId, ":basisUpdated": updatedAt },
      },
    }];
  });
}
async function normalizeSources(
  content: EditorialContent,
  previous?: EditorialContent,
) {
  const { sourceVersions: supplied, articleBasis: suppliedBasis, ...fields } = content;
  const basis = suppliedBasis ?? previous?.articleBasis;
  const addedBasis = suppliedBasis?.filter((reference) =>
    !previous?.articleBasis?.some((saved) => sameArticleBasisReference(saved, reference))) ?? [];
  const basisGuards = await validateArticleBasis(addedBasis);
  const requested = supplied ?? previous?.sourceVersions?.filter((source) =>
    content.sourceCardIds.includes(source.cardId),
  );
  const ids = [...new Set(content.sourceCardIds)];
  const pinned = new Map(requested?.map((source) => [source.cardId, source.versionId]));
  const sourceCardTitles = await Promise.all(ids.map(async (id) => {
    const raw = await getKnowledgeCardById(id);
    const card = raw && getPublicApprovedCard(raw);
    const versionId = pinned.get(id);
    if (!card) {
      const previousIndex = previous?.sourceCardIds.indexOf(id) ?? -1;
      if (versionId || previousIndex < 0) throw new EditorialError("Источник недоступен в утверждённой базе", 422);
      return previous?.sourceCardTitles[previousIndex] ?? "Источник недоступен";
    }
    if (!versionId) return card.title;
    const stored = await getApprovedCardVersion(versionId) ??
      (getCardVersionId(card) === versionId ? await ensureApprovedCardVersion(card) : null);
    if (!stored || stored.cardId !== id || getCardVersionId(stored.snapshot) !== versionId) {
      throw new EditorialError("Версия источника недоступна или относится к другой карточке", 422);
    }
    return stored.snapshot.title;
  }));
  return {
    content: {
      ...fields,
      sourceCardIds: ids,
      sourceCardTitles,
      ...(requested !== undefined ? { sourceVersions: requested } : {}),
      ...(basis !== undefined ? { articleBasis: basis } : {}),
    },
    basisGuards,
  };
}
export async function getEditorialReviewers(doc: EditorialDocument, observedCards?: KnowledgeCard[]) {
  const cards = observedCards ?? await getCanonicalKnowledgeCards();
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
      sourceVersions: legacy.sourceVersions,
    });
  }
  const normalized = await normalizeSources(content);
  content = normalized.content;
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
  try {
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
          ...normalized.basisGuards,
        ],
      })
    );
  } catch (error) {
    if (normalized.basisGuards.length && error instanceof Error &&
        error.name === "TransactionCanceledException" &&
        (!(error instanceof TransactionCanceledException) || !error.CancellationReasons ||
          error.CancellationReasons.slice(3).some(({ Code }) => Code === "ConditionalCheckFailed"))) {
      throw new EditorialError("Опорная статья изменилась. Снова выберите блок.", 409);
    }
    throw error;
  }
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
  const sourceGuards: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [];
  let basisGuards: Awaited<ReturnType<typeof validateArticleBasis>> = [];
  let action: EditorialEvent["action"] = "saved";
  if (mutation.action === "save" || mutation.action === "restore") {
    let content: EditorialContent;
    if (mutation.action === "save") {
      const normalized = await normalizeSources(mutation.content, current.content);
      content = normalized.content;
      basisGuards = normalized.basisGuards;
    } else {
      const old = await getEditorialRevision(current, user, mutation.revisionId);
      content = old.content;
    }
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
      const ids = [...new Set(target.content.sourceCardIds)];
      // Approval uses three writes and one condition per external source under the YDB 25-operation limit.
      const articleBasis = target.content.articleBasis ?? [];
      const basisIds = new Set(articleBasis.map(({ articleId }) => articleId));
      basisIds.delete(id);
      const maxCards = 22 - basisIds.size;
      if (ids.length > maxCards)
        throw new EditorialError(`Для согласования оставьте не больше ${maxCards} используемых карточек с учётом опорных статей.`, 422);
      basisGuards = await validateArticleBasis(articleBasis, 409);
      const rawSources = await Promise.all(ids.map(getKnowledgeCardById));
      const currentSources = rawSources.flatMap(raw => {
        if (!raw) return [];
        const approved = getApprovedVersion(raw);
        const publicSource = getPublicApprovedCard(raw);
        if (!approved || !publicSource) return [];
        sourceGuards.push({
          ConditionCheck: {
            TableName: TableName.KNOWLEDGE_CARDS, Key: { id: raw.id },
            ConditionExpression: approved === raw ? "updatedAt = :sourceHead" :
              "updatedAt = :sourceHead AND approvedSnapshot.updatedAt = :publishedSnapshot",
            ExpressionAttributeValues: {
              ":sourceHead": raw.updatedAt,
              ...(approved !== raw ? { ":publishedSnapshot": approved.updatedAt } : {}),
            },
          },
        });
        return [publicSource];
      });
      if (!currentSources.length || currentSources.length !== ids.length)
        throw new EditorialError("Укажите доступные источники официальных данных", 422);
      const allowedReviewers = await getEditorialReviewers(current, currentSources);
      if (!allowedReviewers.some((reviewer) => reviewer.id === user.id))
        throw new EditorialError(
          "Этот материал требует согласования координатором",
          403
        );
      const references = target.content.sourceVersions ?? [];
      const pinned = references.length ? new Map((await getEditorialSourceVersions(target.content))
        .flatMap(({ id, version }): [string, KnowledgeCard][] => version ? [[id, version.snapshot]] : []))
        : new Map<string, KnowledgeCard>();
      if (references.some(({ cardId }) => !pinned.has(cardId))) {
        throw new EditorialError("Закреплённая версия источника недоступна", 422);
      }
      const sources = currentSources.map((card) => pinned.get(card.id) ?? card);
      const articleText = editorialText(target.content);
      const check = checkFactText(articleText, sources);
      if (check.summary.red > 0)
        throw new EditorialError(
          "Согласование заблокировано: исправьте красные замечания фактчека",
          422
        );
      const currentVersionByCard = new Map(currentSources.map(card => [card.id, getCardVersionId(card)]));
      if (references.some(({ cardId, versionId }) => currentVersionByCard.get(cardId) !== versionId)) {
        throw new EditorialError(
          "Источники обновились. Сверьте текст, переподключите актуальные карточки в источниках редакции и отправьте её на согласование.",
          409
        );
      }
      // Selected cards provide the evidence. Omitting a card cannot hide a known
      // contradiction elsewhere in the approved corpus.
      const corpusCheck = checkFactText(articleText, await getCanonicalKnowledgeCards());
      if (corpusCheck.findings.some(finding =>
        finding.level === "red" && (references.length === 0 || Boolean(finding.sourceCardId))
      )) {
        throw new EditorialError("Согласование заблокировано: текст расходится с утверждёнными карточками.", 422);
      }
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
        ...(target.content.sourceVersions ? { sourceVersions: target.content.sourceVersions } : {}),
        ...(target.content.articleBasis ? { articleBasis: target.content.articleBasis } : {}),
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
      : { ConditionExpression: "attribute_not_exists(id)", ExpressionAttributeValues: undefined };
    const ownBasis = basisGuards.find(({ ConditionCheck }) => ConditionCheck.Key.id === id)?.ConditionCheck;
    const articleCondition = ownBasis ? {
      ...condition,
      ConditionExpression: condition.ConditionExpression + " AND " + ownBasis.ConditionExpression,
      ExpressionAttributeValues: { ...condition.ExpressionAttributeValues, ...ownBasis.ExpressionAttributeValues },
    } : condition;
    writes.push(...sourceGuards, { Put: { TableName: TableName.ARTICLES, Item: publication, ...articleCondition } });
    // A transaction cannot condition-check and write the same publication as separate items.
    basisGuards = basisGuards.filter(({ ConditionCheck }) => ConditionCheck.Key.id !== id);
  }
  writes.push(...basisGuards);
  try {
    await docClient.send(new TransactWriteCommand({ TransactItems: writes }));
  } catch (error) {
    if (isEditorialWriteConflict(error))
      throw new EditorialError(
        publication
          ? "Редакция или её источник изменились. Обновите материал и проверьте источники."
          : basisGuards.length
            ? "Черновик или опорная статья изменились. Обновите данные и проверьте опорные блоки."
            : "Редакция изменилась в другой вкладке. Обновите данные и сравните свой текст",
        409
      );
    throw error;
  }
  return { document: next, publication };
}
