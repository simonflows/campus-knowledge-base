import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
  type ScanCommandOutput,
} from "@aws-sdk/lib-dynamodb";

import {
  articleSeed,
  DEMO_ARTICLE_IDS,
  isDemoArticle,
  isApprovedArticle,
  type ReadyArticle,
} from "./articles";
import { docClient, getStorageMode, getWritableStorageMode } from "./db";
import { getReadableStorageMode } from "./runtime-storage-policy";
import { createPendingDiskSync, diskAttemptCondition, diskAttemptMatches, observedExportCondition, type DiskAttemptGuard, type DiskSyncInfo } from "./disk-sync";
import {
  getPublicApprovedCard,
  isCardApproved,
  knowledgeSeedCards,
  type CardEditRequest,
  type CardStatus,
  type CardTypeDefinition,
  type KnowledgeCard,
} from "./knowledge";
import { mutateLocalStore, readLocalStore } from "./local-store";
import { TableName } from "./schema";
import type { SaveArticleInput } from "./validation/articles";
import type { KnowledgeCardInput } from "./validation/knowledge";
import { knowledgeUpdateModeration } from "./knowledge-lifecycle";

export async function getAllKnowledgeCards(signal?: AbortSignal): Promise<KnowledgeCard[]> {
  const mode = await getReadableStorageMode();

  if (mode === "local-json") {
    const store = await readLocalStore();
    return store.cards;
  }

  if (mode === "static-export") {
    return knowledgeSeedCards;
  }

  const cards: KnowledgeCard[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result: ScanCommandOutput = await docClient.send(
      new ScanCommand({
        TableName: TableName.KNOWLEDGE_CARDS,
        ConsistentRead: true,
        ExclusiveStartKey: cursor,
      }), { abortSignal: signal }
    );
    cards.push(...((result.Items as KnowledgeCard[]) ?? []));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return cards;
}

export async function getCanonicalKnowledgeCards(): Promise<KnowledgeCard[]> {
  const cards = await getAllKnowledgeCards();

  return cards
    .map(getPublicApprovedCard)
    .filter((card): card is KnowledgeCard => card !== null);
}

export async function getKnowledgeCardById(
  id: string
): Promise<KnowledgeCard | null> {
  const mode = await getReadableStorageMode();

  if (mode === "local-json") {
    const store = await readLocalStore();
    return store.cards.find((card) => card.id === id) ?? null;
  }

  if (mode === "static-export") {
    return knowledgeSeedCards.find((card) => card.id === id) ?? null;
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: TableName.KNOWLEDGE_CARDS,
      Key: { id },
      ConsistentRead: true,
    })
  );

  return (result.Item as KnowledgeCard) ?? null;
}

export type KnowledgeCardCreateMeta = {
  status?: CardStatus;
  submittedBy?: string;
  submittedByName?: string;
  participantApprovals?: string[];
};

export async function createKnowledgeCard(
  data: KnowledgeCardInput,
  meta: KnowledgeCardCreateMeta = {}
): Promise<KnowledgeCard> {
  const now = new Date().toISOString();
  const card = {
    ...data,
    ...meta,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    diskSync: createPendingDiskSync(),
  } as KnowledgeCard;

  const mode = await getWritableStorageMode();

  if (mode === "local-json") {
    return mutateLocalStore((store) => ({
      store: { ...store, cards: [...store.cards, card] },
      result: card,
    }));
  }

  await docClient.send(
    new PutCommand({
      TableName: TableName.KNOWLEDGE_CARDS,
      Item: card,
    })
  );

  return card;
}

export type KnowledgeCardModerationPatch = {
  status?: CardStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewComment?: string;
  participantApprovals?: string[];
  editRequests?: CardEditRequest[];
};

function checkVersion(current: { updatedAt: string }, expectedUpdatedAt?: string) {
  if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt)
    throw Object.assign(new Error("Record changed"), { name: "ConditionalCheckFailedException" });
}

// A second successful write in the same millisecond still needs a distinct version.
function nextVersion(current: { updatedAt: string }) {
  return new Date(Math.max(Date.now(), (Date.parse(current.updatedAt) || 0) + 1)).toISOString();
}

function applyModerationPatch(current: KnowledgeCard, patch: KnowledgeCardModerationPatch): KnowledgeCard {
  const updatedAt = nextVersion(current);
  const sync = current.diskSync;
  const onlyRequests = patch.editRequests !== undefined && Object.keys(patch).length === 1;
  const keepExport = onlyRequests && sync?.status === "synced" && sync.sourceUpdatedAt === current.updatedAt;
  return {
    ...current,
    ...patch,
    updatedAt,
    ...(keepExport && { diskSync: { ...sync, sourceUpdatedAt: updatedAt } }),
    ...(!onlyRequests && sync?.status === "pending" && sync.attemptId && { diskSync: createPendingDiskSync(sync) }),
  };
}

export async function setKnowledgeCardModeration(
  id: string,
  patch: KnowledgeCardModerationPatch,
  expectedUpdatedAt?: string
): Promise<KnowledgeCard | null> {
  const mode = await getWritableStorageMode();

  if (mode === "local-json") {
    return mutateLocalStore((store) => {
      const current = store.cards.find((card) => card.id === id);
      if (!current) return { store, result: null };
      checkVersion(current, expectedUpdatedAt);

      const next = applyModerationPatch(current, patch);

      return {
        store: {
          ...store,
          cards: store.cards.map((card) => (card.id === id ? next : card)),
        },
        result: next,
      };
    });
  }

  const current = await getKnowledgeCardById(id);

  if (!current) return null;
  checkVersion(current, expectedUpdatedAt);

  const next = applyModerationPatch(current, patch);

  await docClient.send(
    new PutCommand({
      TableName: TableName.KNOWLEDGE_CARDS,
      Item: next,
      ...observedExportCondition(current),
    })
  );

  return next;
}

export async function updateKnowledgeCard(
  id: string,
  data: KnowledgeCardInput,
  editor?: { id: string; name: string; isAdmin: boolean },
  expectedUpdatedAt?: string
): Promise<KnowledgeCard | null> {
  const mode = await getWritableStorageMode();

  if (mode === "local-json") {
    return mutateLocalStore((store) => {
      const current = store.cards.find((card) => card.id === id);
      if (!current) return { store, result: null };
      checkVersion(current, expectedUpdatedAt);

      const next = {
        ...current,
        ...data,
        ...knowledgeUpdateModeration(current, data, editor),
        diskSync: createPendingDiskSync(current.diskSync),
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: nextVersion(current),
      } as KnowledgeCard;

      return {
        store: {
          ...store,
          cards: store.cards.map((card) => (card.id === id ? next : card)),
        },
        result: next,
      };
    });
  }

  const current = await getKnowledgeCardById(id);

  if (!current) return null;
  checkVersion(current, expectedUpdatedAt);

  const next = {
    ...current,
    ...data,
    ...knowledgeUpdateModeration(current, data, editor),
    diskSync: createPendingDiskSync(current.diskSync),
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: nextVersion(current),
  } as KnowledgeCard;

  await docClient.send(
    new PutCommand({
      TableName: TableName.KNOWLEDGE_CARDS,
      Item: next,
      ...observedExportCondition(current),
    })
  );

  return next;
}

export async function setKnowledgeCardDiskSync(
  id: string,
  diskSync: DiskSyncInfo,
  expectedUpdatedAt: string,
  guard?: DiskAttemptGuard,
  signal?: AbortSignal
): Promise<KnowledgeCard | undefined> {
  const mode = await getWritableStorageMode();
  // Content edits and moderation decisions invalidate the attempt. Comments preserve it.
  function canFinishAfterComment(card: Pick<KnowledgeCard, "diskSync">) {
    return typeof guard === "string" && card.diskSync?.status === "pending" &&
      card.diskSync.attemptId === guard && card.diskSync.sourceUpdatedAt === expectedUpdatedAt;
  }

  if (mode === "local-json") {
    return mutateLocalStore((store) => {
      const card = store.cards.find((item) => item.id === id);
      if (
        !card || !isCardApproved(card) ||
        (card.updatedAt !== expectedUpdatedAt && !canFinishAfterComment(card)) ||
        !diskAttemptMatches(card.diskSync, guard)
      ) {
        throw Object.assign(new Error("Card changed during backup"), {
          name: "ConditionalCheckFailedException",
        });
      }
      const updated = { ...card, diskSync: { ...diskSync, sourceUpdatedAt: card.updatedAt } };
      return {
        store: { ...store, cards: store.cards.map((item) => item.id === id ? updated : item) },
        result: updated,
      };
    });
  }

  const condition = diskAttemptCondition(guard);
  const deadline = signal ?? AbortSignal.timeout(5_000);
  let version = expectedUpdatedAt;
  for (;;) {
    deadline.throwIfAborted();
    const rebased = version !== expectedUpdatedAt;
    try {
      const { Attributes } = await docClient.send(new UpdateCommand({
        TableName: TableName.KNOWLEDGE_CARDS,
        Key: { id },
        ReturnValues: typeof guard === "string" ? "ALL_NEW" : "NONE",
        UpdateExpression: "set diskSync = :diskSync",
        ConditionExpression: `attribute_exists(id) AND updatedAt = :version AND (attribute_not_exists(#status) OR #status = :approved)${condition.ConditionExpression}${rebased ? " AND diskSync.#status = :pending AND diskSync.sourceUpdatedAt = :source" : ""}`,
        ExpressionAttributeNames: { "#status": "status", ...condition.ExpressionAttributeNames },
        ExpressionAttributeValues: {
          ":diskSync": rebased ? { ...diskSync, sourceUpdatedAt: version } : diskSync,
          ":version": version,
          ":approved": "approved",
          ...(rebased && { ":pending": "pending", ":source": expectedUpdatedAt }),
          ...condition.ExpressionAttributeValues,
        },
      }), { abortSignal: deadline });
      return Attributes as KnowledgeCard | undefined;
    } catch (error) {
      if (typeof guard !== "string" || !(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
      const { Item } = await docClient.send(new GetCommand({
        TableName: TableName.KNOWLEDGE_CARDS,
        Key: { id },
        ConsistentRead: true,
        ProjectionExpression: "updatedAt, diskSync.#status, diskSync.attemptId, diskSync.sourceUpdatedAt",
        ExpressionAttributeNames: { "#status": "status" },
      }), { abortSignal: deadline });
      const observed = Item as Pick<KnowledgeCard, "diskSync" | "updatedAt"> | undefined;
      if (!observed || observed.updatedAt === version || !canFinishAfterComment(observed)) throw error;
      version = observed.updatedAt;
    }
  }
}

export async function deleteKnowledgeCard(id: string): Promise<void> {
  const mode = await getWritableStorageMode();

  if (mode === "local-json") {
    await mutateLocalStore((store) => ({
      store: {
        ...store,
        cards: store.cards.filter((card) => card.id !== id),
      },
      result: undefined,
    }));
    return;
  }

  await docClient.send(
    new DeleteCommand({
      TableName: TableName.KNOWLEDGE_CARDS,
      Key: { id },
    })
  );
}

export async function getAllCardTypes(signal?: AbortSignal): Promise<CardTypeDefinition[]> {
  const mode = await getReadableStorageMode();

  if (mode === "local-json") {
    const store = await readLocalStore();
    return store.cardTypes;
  }

  if (mode === "static-export") return [];

  const types: CardTypeDefinition[] = [];
  let cursor: ScanCommandOutput["LastEvaluatedKey"];
  do {
    const page: ScanCommandOutput = await docClient.send(
      new ScanCommand({
        TableName: TableName.KNOWLEDGE_CARD_TYPES,
        ExclusiveStartKey: cursor,
      }), { abortSignal: signal }
    );
    types.push(...((page.Items ?? []) as CardTypeDefinition[]));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return types;
}

export async function getCardTypeById(
  id: string
): Promise<CardTypeDefinition | null> {
  const mode = await getReadableStorageMode();

  if (mode === "local-json") {
    const store = await readLocalStore();
    return store.cardTypes.find((type) => type.id === id) ?? null;
  }

  if (mode === "static-export") return null;

  const result = await docClient.send(
    new GetCommand({
      TableName: TableName.KNOWLEDGE_CARD_TYPES,
      Key: { id },
      ConsistentRead: true,
    })
  );

  return (result.Item as CardTypeDefinition) ?? null;
}

export async function createCardType(
  data: Omit<CardTypeDefinition, "createdAt" | "updatedAt">
): Promise<CardTypeDefinition> {
  const now = new Date().toISOString();
  const cardType: CardTypeDefinition = {
    ...data,
    createdAt: now,
    updatedAt: now,
  };

  const mode = await getWritableStorageMode();

  if (mode === "local-json") {
    return mutateLocalStore((store) => ({
      store: { ...store, cardTypes: [...store.cardTypes, cardType] },
      result: cardType,
    }));
  }

  await docClient.send(
    new PutCommand({
      TableName: TableName.KNOWLEDGE_CARD_TYPES,
      Item: cardType,
    })
  );

  return cardType;
}

export async function updateCardType(
  id: string,
  data: Partial<Pick<CardTypeDefinition, "name" | "description" | "fields">>,
  expectedUpdatedAt?: string
): Promise<CardTypeDefinition | null> {
  const mode = await getWritableStorageMode();

  if (mode === "local-json") {
    return mutateLocalStore((store) => {
      const current = store.cardTypes.find((type) => type.id === id);
      if (!current) return { store, result: null };
      checkVersion(current, expectedUpdatedAt);

      const next: CardTypeDefinition = {
        ...current,
        ...data,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: nextVersion(current),
      };

      return {
        store: {
          ...store,
          cardTypes: store.cardTypes.map((type) =>
            type.id === id ? next : type
          ),
        },
        result: next,
      };
    });
  }

  const current = await getCardTypeById(id);

  if (!current) return null;
  checkVersion(current, expectedUpdatedAt);

  const next: CardTypeDefinition = {
    ...current,
    ...data,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: nextVersion(current),
  };

  await docClient.send(
    new PutCommand({
      TableName: TableName.KNOWLEDGE_CARD_TYPES,
      Item: next,
      ConditionExpression: "attribute_exists(id) AND updatedAt = :version",
      ExpressionAttributeValues: { ":version": current.updatedAt },
    })
  );

  return next;
}

export async function deleteCardType(id: string): Promise<void> {
  const mode = await getWritableStorageMode();

  if (mode === "local-json") {
    await mutateLocalStore((store) => ({
      store: {
        ...store,
        cardTypes: store.cardTypes.filter((type) => type.id !== id),
      },
      result: undefined,
    }));
    return;
  }

  await docClient.send(
    new DeleteCommand({
      TableName: TableName.KNOWLEDGE_CARD_TYPES,
      Key: { id },
    })
  );
}

export function customCardCounts(cards: KnowledgeCard[]): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  for (const card of cards) {
    if (card.type === "custom") counts[card.customTypeId] = (counts[card.customTypeId] ?? 0) + 1;
  }
  return counts;
}

export async function countKnowledgeCardsByCustomType(typeId: string): Promise<number> {
  return customCardCounts(await getAllKnowledgeCards())[typeId] ?? 0;
}

export async function getAllArticles(signal?: AbortSignal): Promise<ReadyArticle[]> {
  const mode = await getReadableStorageMode();

  if (mode === "local-json") {
    const store = await readLocalStore();
    return store.articles.filter(isApprovedArticle);
  }

  if (mode === "static-export")
    return articleSeed.filter(isApprovedArticle);

  const articles: ReadyArticle[] = [];
  let cursor: ScanCommandOutput["LastEvaluatedKey"];
  do {
    const page: ScanCommandOutput = await docClient.send(
      new ScanCommand({
        TableName: TableName.ARTICLES,
        ExclusiveStartKey: cursor,
        ConsistentRead: true,
      }), { abortSignal: signal }
    );
    articles.push(
      ...((page.Items ?? []) as ReadyArticle[]).filter(isApprovedArticle)
    );
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return articles;
}

export async function getArticleById(id: string): Promise<ReadyArticle | null> {
  const mode = await getReadableStorageMode();

  if (mode === "local-json") {
    const store = await readLocalStore();
    return (
      store.articles.find(
        (article) => article.id === id && isApprovedArticle(article)
      ) ?? null
    );
  }

  if (mode === "static-export") {
    return (
      articleSeed.find(
        (article) => article.id === id && isApprovedArticle(article)
      ) ?? null
    );
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: TableName.ARTICLES,
      Key: { id },
      ConsistentRead: true,
    })
  );

  const article = result.Item as ReadyArticle | undefined;
  return article && isApprovedArticle(article) ? article : null;
}

export async function createArticle(
  data: SaveArticleInput
): Promise<ReadyArticle> {
  const now = new Date().toISOString();
  const article: ReadyArticle = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    diskSync: createPendingDiskSync(),
  };

  const mode = await getWritableStorageMode();

  if (mode === "local-json") {
    return mutateLocalStore((store) => ({
      store: { ...store, articles: [article, ...store.articles] },
      result: article,
    }));
  }

  await docClient.send(
    new PutCommand({
      TableName: TableName.ARTICLES,
      Item: article,
    })
  );

  return article;
}

export async function updateArticle(
  id: string,
  data: SaveArticleInput
): Promise<ReadyArticle | null> {
  const mode = await getWritableStorageMode();

  if (mode === "local-json") {
    return mutateLocalStore((store) => {
      const current = store.articles.find((article) => article.id === id);
      if (!current) return { store, result: null };

      const next: ReadyArticle = {
        ...current,
        ...data,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
        diskSync: current.diskSync,
      };

      return {
        store: {
          ...store,
          articles: store.articles.map((article) =>
            article.id === id ? next : article
          ),
        },
        result: next,
      };
    });
  }

  const current = await getArticleById(id);

  if (!current) return null;

  const next: ReadyArticle = {
    ...current,
    ...data,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
    diskSync: current.diskSync,
  };

  await docClient.send(
    new PutCommand({
      TableName: TableName.ARTICLES,
      Item: next,
    })
  );

  return next;
}

export async function setArticleDiskSync(
  id: string,
  diskSync: DiskSyncInfo,
  expectedUpdatedAt: string,
  expectedRevisionId: string,
  guard?: DiskAttemptGuard,
  signal?: AbortSignal
): Promise<void> {
  const mode = await getWritableStorageMode();

  if (mode === "local-json") {
    await mutateLocalStore((store) => ({
      store: {
        ...store,
        articles: store.articles.map((article) => {
          if (article.id !== id) return article;
          if (
            !isApprovedArticle(article) ||
            article.updatedAt !== expectedUpdatedAt ||
            article.approval?.revisionId !== expectedRevisionId ||
            !diskAttemptMatches(article.diskSync, guard)
          )
            throw Object.assign(new Error("Article changed during backup"), {
              name: "ConditionalCheckFailedException",
            });
          return { ...article, diskSync };
        }),
      },
      result: undefined,
    }));
    return;
  }

  const condition = diskAttemptCondition(guard);
  await docClient.send(
    new UpdateCommand({
      TableName: TableName.ARTICLES,
      Key: { id },
      UpdateExpression: "set diskSync = :diskSync",
      ConditionExpression: `attribute_exists(id) AND updatedAt = :version AND approval.revisionId = :revision${condition.ConditionExpression}`,
      ...(condition.ExpressionAttributeNames && Object.keys(condition.ExpressionAttributeNames).length ? { ExpressionAttributeNames: condition.ExpressionAttributeNames } : {}),
      ExpressionAttributeValues: {
        ":diskSync": diskSync,
        ":version": expectedUpdatedAt,
        ":revision": expectedRevisionId,
        ...condition.ExpressionAttributeValues,
      },
    }), { abortSignal: signal }
  );
}

export async function deleteArticle(id: string): Promise<void> {
  const mode = await getWritableStorageMode();

  if (mode === "local-json") {
    await mutateLocalStore((store) => ({
      store: {
        ...store,
        articles: store.articles.filter((article) => article.id !== id),
      },
      result: undefined,
    }));
    return;
  }

  await docClient.send(
    new DeleteCommand({
      TableName: TableName.ARTICLES,
      Key: { id },
    })
  );
}

export async function clearDemoArticles(): Promise<number> {
  const mode = await getStorageMode();

  if (mode === "local-json") {
    return mutateLocalStore((store) => {
      const remaining = store.articles.filter(
        (article) => !isDemoArticle(article.id)
      );
      const removed = store.articles.length - remaining.length;

      return {
        store: {
          ...store,
          articles: remaining,
          demoArticlesCleared: true,
        },
        result: removed,
      };
    });
  }

  if (mode === "static-export" || mode === "read-only") return 0;

  let removed = 0;
  await Promise.all(
    DEMO_ARTICLE_IDS.map(async (id) => {
      const existing = await getArticleById(id);
      if (existing) {
        removed += 1;
        await docClient.send(
          new DeleteCommand({
            TableName: TableName.ARTICLES,
            Key: { id },
          })
        );
      }
    })
  );

  return removed;
}
