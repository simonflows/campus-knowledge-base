import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type ScanCommandOutput,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";

import {
  articleSeed,
  DEMO_ARTICLE_IDS,
  isDemoArticle,
  isApprovedArticle,
  type ReadyArticle,
} from "./articles";
import { docClient, getStorageMode, getWritableStorageMode } from "./db";
import { getReadableStorageMode } from "./runtime-storage-policy";
import { createPendingDiskSync, diskAttemptCondition, diskAttemptMatches, observedExportCondition, type DiskAttemptGuard, type DiskRegistry, type DiskRegistryCommit, type DiskSyncInfo } from "./disk-sync";
import {
  folderIds,
  getApprovedVersion,
  getLegacyCustomDraftUniversityId,
  getPublicApprovedCard,
  isCardApproved,
  isCardReadyForPublication,
  knowledgeSeedCards,
  type CardEditRequest,
  type CardFreshness,
  type CardStatus,
  type CardTypeDefinition,
  type KnowledgeCard,
} from "./knowledge";
import { mutateLocalStore, readLocalStore } from "./local-store";
import { TableName } from "./schema";
import type { SaveArticleInput } from "./validation/articles";
import { buildCustomFieldValuesSchema, canonicalCustomFieldValues, type KnowledgeCardInput } from "./validation/knowledge";
import { knowledgeUpdateModeration } from "./knowledge-lifecycle";
import {
  describeApprovedCardVersion,
  getApprovedCardVersion,
  getCardVersionId,
  insertCardVersion,
  type CardVersionActor,
} from "./knowledge-versions";

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
  requiredApprovalStakeholderRoles?: KnowledgeCard["requiredApprovalStakeholderRoles"];
};

type CardTransaction = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

function conditionalConflict(message: string, cause?: unknown) {
  return Object.assign(new Error(message, { cause }), { name: "ConditionalCheckFailedException" });
}

function isTransactionConflict(error: unknown): boolean {
  return error instanceof Error && error.name === "TransactionCanceledException" &&
    (!(error instanceof TransactionCanceledException) ||
      !error.CancellationReasons?.some(({ Code }) =>
        Code && !["None", "ConditionalCheckFailed", "TransactionConflict"].includes(Code)));
}

function typeEpochWrite(definition: CardTypeDefinition): CardTransaction {
  return {
    Update: {
      TableName: TableName.KNOWLEDGE_CARD_TYPES,
      Key: { id: definition.id },
      ConditionExpression: "attribute_exists(id) AND updatedAt = :version",
      UpdateExpression: "SET updatedAt = :next",
      ExpressionAttributeValues: { ":version": definition.updatedAt, ":next": nextVersion(definition) },
    },
  };
}

function prepareCustomCard(card: KnowledgeCard, definition: CardTypeDefinition | null): KnowledgeCard {
  if (card.type !== "custom") return card;
  if (!definition) throw conditionalConflict("Тип карточки удалён");
  const fields = buildCustomFieldValuesSchema(definition).strict().safeParse(card.customFields);
  if (!fields.success) throw conditionalConflict("Поля пользовательского типа изменились");
  if ((card.organizationScope === "chkk") !== (definition.organizationScope === "chkk")) {
    throw conditionalConflict("Зона доступа карточки расходится с определением её типа");
  }
  return {
    ...card,
    folderId: definition.organizationScope === "chkk" ? folderIds.chkkParameters
      : getLegacyCustomDraftUniversityId(card) ? card.folderId : folderIds.customType(definition.id),
    customFields: canonicalCustomFieldValues(fields.data),
  };
}

async function writeKnowledgeCard(
  next: KnowledgeCard,
  options: {
    previous?: KnowledgeCard;
    actor?: CardVersionActor;
    reason?: string;
    guardCustomType?: boolean;
  } = {}
): Promise<KnowledgeCard> {
  const { previous, actor, reason, guardCustomType } = options;
  const definition = guardCustomType && next.type === "custom"
    ? await getCardTypeById(next.customTypeId)
    : null;
  const card = guardCustomType ? prepareCustomCard(next, definition) : next;
  const cardWrite = {
    TableName: TableName.KNOWLEDGE_CARDS,
    Item: card,
    ...(previous ? observedExportCondition(previous) : { ConditionExpression: "attribute_not_exists(id)" }),
  };
  const prior = previous ? getApprovedVersion(previous) : null;
  const published = getApprovedVersion(card);
  const priorId = prior ? getCardVersionId(prior) : null;
  const newId = published ? getCardVersionId(published) : null;
  const changesCanonicalContent = newId !== priorId;
  const recordedAt = new Date().toISOString();
  const versions = changesCanonicalContent ? [
    ...(prior ? [describeApprovedCardVersion(prior, { legacyBaseline: true, recordedAt })] : []),
    ...(published ? [describeApprovedCardVersion(published, { legacyBaseline: false, recordedAt, actor, reason })] : []),
  ] : [];

  for (let attempt = 0; ; attempt++) {
    const missing = (await Promise.all(versions.map(async (version) =>
      (await getApprovedCardVersion(version.id)) ? null : version
    ))).filter(version => version !== null);
    if (!definition && missing.length === 0) {
      await docClient.send(new PutCommand(cardWrite));
      return card;
    }
    try {
      await docClient.send(new TransactWriteCommand({
        TransactItems: [
          { Put: cardWrite },
          ...(definition ? [typeEpochWrite(definition)] : []),
          ...missing.map(version => ({ Put: insertCardVersion(version) })),
        ],
      }));
      return card;
    } catch (error) {
      if (!isTransactionConflict(error)) throw error;
      // A simultaneous pin of the same immutable snapshot is compatible with this write.
      // Retry only against the original card/type conditions to avoid overwriting concurrent edits.
      if (attempt === 0 && missing.length && (await Promise.all(
        missing.map(version => getApprovedCardVersion(version.id))
      )).some(Boolean)) continue;
      throw conditionalConflict("Карточка или её тип изменились", error);
    }
  }
}

export async function insertApprovedKnowledgeCard(card: KnowledgeCard): Promise<KnowledgeCard> {
  if (!isCardApproved(card) || !isCardReadyForPublication(card))
    throw new Error("Импорт утверждённых карточек требует подтверждения и известных параметров проекта");
  if (await getWritableStorageMode() !== "dynamodb")
    throw new Error("Импорт утверждённых карточек доступен только в DynamoDB");
  return writeKnowledgeCard(card, {
    guardCustomType: true,
    reason: card.changeReason || "Импорт согласованной карточки",
  });
}

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
  if (isCardApproved(card) && !isCardReadyForPublication(card)) card.status = "pending";

  const mode = await getWritableStorageMode();

  if (mode === "local-json") {
    return mutateLocalStore((store) => {
      const definition = card.type === "custom"
        ? store.cardTypes.find(type => type.id === card.customTypeId) ?? null : null;
      const checked = prepareCustomCard(card, definition);
      return {
        store: { ...store, cards: [...store.cards, checked] },
        result: checked,
      };
    });
  }

  return writeKnowledgeCard(card, {
    guardCustomType: true,
    actor: meta.submittedBy && meta.submittedByName
      ? { id: meta.submittedBy, name: meta.submittedByName } : undefined,
    reason: card.changeReason || "Создана утверждённая карточка",
  });
}

export type KnowledgeCardModerationPatch = {
  status?: CardStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewComment?: string;
  participantApprovals?: string[];
  participantApprovalRecords?: KnowledgeCard["participantApprovalRecords"];
  stakeholderApprovals?: KnowledgeCard["stakeholderApprovals"];
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
  if (patch.status === "approved" && !isCardReadyForPublication(current)) {
    throw conditionalConflict("Перед согласованием уточните стадию и контур проекта");
  }
  const updatedAt = nextVersion(current);
  const sync = current.diskSync;
  const onlyRequests = patch.editRequests !== undefined && Object.keys(patch).length === 1;
  const keepExport = onlyRequests && sync?.status === "synced" && sync.sourceUpdatedAt === current.updatedAt;
  const next = {
    ...current,
    ...patch,
    updatedAt,
    ...(keepExport && { diskSync: { ...sync, sourceUpdatedAt: updatedAt } }),
    ...(!onlyRequests && sync?.status === "pending" && sync.attemptId && { diskSync: createPendingDiskSync(sync) }),
  };
  if (patch.status === "approved") {
    if (next.type === "project" || !next.requiredApprovalUniversityIds?.length) {
      delete next.requiredApprovalUniversityIds;
    }
    delete next.requiredApprovalStakeholderRoles;
    delete next.approvedSnapshot;
  }
  return next;
}

export async function setKnowledgeCardModeration(
  id: string,
  patch: KnowledgeCardModerationPatch,
  expectedUpdatedAt?: string,
  actor?: CardVersionActor
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

  return writeKnowledgeCard(next, {
    previous: current,
    actor,
    reason: next.changeReason || "Утверждена координатором",
  });
}

function applyKnowledgeUpdate(
  current: KnowledgeCard,
  data: KnowledgeCardInput,
  editor?: { id: string; name: string; isAdmin: boolean }
): KnowledgeCard {
  if (current.type !== data.type || (current.type === "custom" &&
      data.type === "custom" && current.customTypeId !== data.customTypeId)) {
    throw conditionalConflict("Тип карточки нельзя изменить после создания");
  }
  const updatedAt = nextVersion(current);
  const next = {
    ...current,
    ...data,
    ...knowledgeUpdateModeration(current, data, editor),
    diskSync: createPendingDiskSync(current.diskSync),
    id: current.id,
    createdAt: current.createdAt,
    updatedAt,
  } as KnowledgeCard;
  if (isCardApproved(next) && getCardVersionId(next) !== getCardVersionId(current)) {
    // A direct publication by the coordinator approves this change at its own time.
    if (editor?.isAdmin) {
      next.reviewedAt = updatedAt;
      next.reviewedBy = editor.name;
    } else {
      delete next.reviewedAt;
      delete next.reviewedBy;
    }
    delete next.reviewComment;
  }
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

      const definition = current.type === "custom"
        ? store.cardTypes.find(type => type.id === current.customTypeId) ?? null : null;
      const next = prepareCustomCard(applyKnowledgeUpdate(current, data, editor), definition);

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

  const next = applyKnowledgeUpdate(current, data, editor);
  return writeKnowledgeCard(next, {
    previous: current,
    guardCustomType: true,
    actor: editor,
    reason: data.changeReason || "Обновлена утверждённая карточка",
  });
}

export async function setKnowledgeCardFreshness(
  id: string, freshness: CardFreshness, expectedUpdatedAt: string
): Promise<KnowledgeCard | null> {
  const mode = await getWritableStorageMode();
  const update = (current: KnowledgeCard) => {
    checkVersion(current, expectedUpdatedAt);
    const sync = current.diskSync;
    const updatedAt = nextVersion(current);
    return {
      ...current, freshness, updatedAt,
      ...(sync?.sourceUpdatedAt === current.updatedAt && {
        diskSync: { ...sync, sourceUpdatedAt: updatedAt },
      }),
    };
  };
  if (mode === "local-json") return mutateLocalStore(store => {
    const current = store.cards.find(card => card.id === id);
    if (!current) return { store, result: null };
    const next = update(current);
    return { store: { ...store, cards: store.cards.map(card => card.id === id ? next : card) }, result: next };
  });
  const current = await getKnowledgeCardById(id);
  if (!current) return null;
  const next = update(current);
  await docClient.send(new PutCommand({
    TableName: TableName.KNOWLEDGE_CARDS, Item: next, ...observedExportCondition(current),
  }));
  return next;
}

export async function getDiskRegistry(id: string, signal: AbortSignal): Promise<DiskRegistry | null> {
  if (await getWritableStorageMode() !== "dynamodb") return null;
  const { Item } = await docClient.send(new GetCommand({
    TableName: TableName.WORKFLOW_RECORDS, Key: { id }, ConsistentRead: true,
  }), { abortSignal: signal });
  return Item?.kind === "disk-registry" ? Item as DiskRegistry : null;
}

export async function getAllDiskRegistries(signal: AbortSignal): Promise<DiskRegistry[]> {
  if (await getWritableStorageMode() !== "dynamodb") return [];
  const registries: DiskRegistry[] = [];
  let cursor: ScanCommandOutput["LastEvaluatedKey"];
  do {
    const page: ScanCommandOutput = await docClient.send(new ScanCommand({
      TableName: TableName.WORKFLOW_RECORDS, ConsistentRead: true, ExclusiveStartKey: cursor,
      FilterExpression: "#kind = :kind", ExpressionAttributeNames: { "#kind": "kind" },
      ExpressionAttributeValues: { ":kind": "disk-registry" },
    }), { abortSignal: signal });
    registries.push(...(page.Items ?? []).filter(item => item.kind === "disk-registry") as DiskRegistry[]);
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return registries;
}

function diskRegistryWrite({ next, expectedVersionId }: DiskRegistryCommit): NonNullable<CardTransaction["Put"]> {
  return {
    TableName: TableName.WORKFLOW_RECORDS,
    Item: next,
    ConditionExpression: expectedVersionId === undefined ? "attribute_not_exists(id)" : "versionId = :expected",
    ...(expectedVersionId !== undefined && { ExpressionAttributeValues: { ":expected": expectedVersionId } }),
  };
}

export async function replaceDiskRegistry(commit: DiskRegistryCommit, signal: AbortSignal) {
  await docClient.send(new PutCommand(diskRegistryWrite(commit)), { abortSignal: signal });
}

export async function noteDiskRegistryRebuildError(registry: DiskRegistry, error: string, signal: AbortSignal) {
  await docClient.send(new UpdateCommand({
    TableName: TableName.WORKFLOW_RECORDS, Key: { id: registry.id },
    UpdateExpression: "SET rebuildLastAttemptAt = :attempt, rebuildError = :error",
    ConditionExpression: "versionId = :version",
    ExpressionAttributeValues: { ":version": registry.versionId, ":attempt": new Date().toISOString(), ":error": error },
  }), { abortSignal: signal });
}

export async function claimDiskRegistryReceipt(registry: DiskRegistry, attemptedAt: string, signal: AbortSignal) {
  if (await getWritableStorageMode() !== "dynamodb") return false;
  await docClient.send(new UpdateCommand({
    TableName: TableName.WORKFLOW_RECORDS, Key: { id: registry.id },
    UpdateExpression: "SET receiptLastAttemptAt = :attempt",
    ConditionExpression: "versionId = :version AND attribute_not_exists(receiptPath) AND " +
      (registry.receiptLastAttemptAt ? "receiptLastAttemptAt = :previous" : "attribute_not_exists(receiptLastAttemptAt)"),
    ExpressionAttributeValues: {
      ":version": registry.versionId, ":attempt": attemptedAt,
      ...(registry.receiptLastAttemptAt && { ":previous": registry.receiptLastAttemptAt }),
    },
  }), { abortSignal: signal });
  return true;
}

export async function finishDiskRegistryReceipt(
  registry: DiskRegistry, attemptedAt: string, result: { path: string } | { error: string; summaryInvalid?: true }, signal: AbortSignal,
) {
  const invalid = "error" in result && result.summaryInvalid;
  await docClient.send(new UpdateCommand({
    TableName: TableName.WORKFLOW_RECORDS, Key: { id: registry.id },
    UpdateExpression: "path" in result ? "SET receiptPath = :result REMOVE receiptError" :
      "SET receiptError = :result" + (invalid ? ", summaryInvalid = :invalid" : ""),
    ConditionExpression: "versionId = :version AND receiptLastAttemptAt = :attempt AND attribute_not_exists(receiptPath)",
    ExpressionAttributeValues: {
      ":version": registry.versionId, ":attempt": attemptedAt, ":result": "path" in result ? result.path : result.error,
      ...(invalid ? { ":invalid": true } : {}),
    },
  }), { abortSignal: signal });
}

async function commitDiskRegistry(
  update: NonNullable<CardTransaction["Update"]>,
  commit: DiskRegistryCommit,
  signal?: AbortSignal
) {
  try {
    await docClient.send(new TransactWriteCommand({
      TransactItems: [
        { Update: update },
        { Put: diskRegistryWrite(commit) },
      ],
    }), { abortSignal: signal });
  } catch (error) {
    if (!isTransactionConflict(error)) throw error;
    throw conditionalConflict("Редакция или подтверждённая сводка изменились", error);
  }
}

export async function setKnowledgeSnapshotDiskSync(
  head: KnowledgeCard, snapshot: KnowledgeCard, diskSync: DiskSyncInfo,
  guard: DiskAttemptGuard, signal: AbortSignal, registryCommit?: DiskRegistryCommit,
): Promise<KnowledgeCard | undefined> {
  const condition = diskAttemptCondition(guard, true);
  const update = {
    TableName: TableName.KNOWLEDGE_CARDS, Key: { id: head.id },
    UpdateExpression: "SET approvedSnapshot.diskSync = :diskSync",
    ConditionExpression: "updatedAt = :head AND #status <> :approved AND approvedSnapshot.updatedAt = :snapshot" +
      " AND (attribute_not_exists(approvedSnapshot.#status) OR approvedSnapshot.#status = :approved)" +
      condition.ConditionExpression,
    ExpressionAttributeNames: { "#status": "status", ...condition.ExpressionAttributeNames },
    ExpressionAttributeValues: {
      ":head": head.updatedAt, ":snapshot": snapshot.updatedAt, ":approved": "approved", ":diskSync": diskSync,
      ...condition.ExpressionAttributeValues,
    },
  };
  if (registryCommit) {
    await commitDiskRegistry(update, registryCommit, signal);
    const { Item } = await docClient.send(new GetCommand({
      TableName: TableName.KNOWLEDGE_CARDS, Key: { id: head.id }, ConsistentRead: true,
    }), { abortSignal: signal });
    return Item as KnowledgeCard | undefined;
  }
  const { Attributes } = await docClient.send(new UpdateCommand({ ...update, ReturnValues: "ALL_NEW" }), { abortSignal: signal });
  return Attributes as KnowledgeCard | undefined;
}

export async function setKnowledgeCardDiskSync(
  id: string,
  diskSync: DiskSyncInfo,
  expectedUpdatedAt: string,
  guard?: DiskAttemptGuard,
  signal?: AbortSignal,
  registryCommit?: DiskRegistryCommit
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
      const update = {
        TableName: TableName.KNOWLEDGE_CARDS,
        Key: { id },
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
      };
      if (registryCommit) {
        await commitDiskRegistry(update, registryCommit, deadline);
        const { Item } = await docClient.send(new GetCommand({
          TableName: TableName.KNOWLEDGE_CARDS, Key: { id }, ConsistentRead: true,
        }), { abortSignal: deadline });
        return Item as KnowledgeCard | undefined;
      }
      const { Attributes } = await docClient.send(new UpdateCommand({
        ...update, ReturnValues: typeof guard === "string" ? "ALL_NEW" : "NONE",
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

  const current = await getKnowledgeCardById(id);
  if (!current) return;
  const definition = current.type === "custom" ? await getCardTypeById(current.customTypeId) : null;
  const deletion = { TableName: TableName.KNOWLEDGE_CARDS, Key: { id }, ...observedExportCondition(current) };
  if (!definition) {
    await docClient.send(new DeleteCommand(deletion));
    return;
  }
  try {
    await docClient.send(new TransactWriteCommand({
      TransactItems: [{ Delete: deletion }, typeEpochWrite(definition)],
    }));
  } catch (error) {
    if (!isTransactionConflict(error)) throw error;
    throw conditionalConflict("Карточка или её тип изменились", error);
  }
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
        ConsistentRead: true,
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
      ConditionExpression: "attribute_not_exists(id)",
    })
  );

  return cardType;
}

export class CardTypeInUseError extends Error {
  constructor(public count: number) {
    super("Этот тип уже используется в карточках");
  }
}

function typeFieldsChanged(current: CardTypeDefinition, fields?: CardTypeDefinition["fields"]) {
  if (!fields) return false;
  const shape = (list: CardTypeDefinition["fields"]) => list.map(
    ({ id, name, type, required, options }) => [id, name, type, required, options]
  );
  return JSON.stringify(shape(current.fields)) !== JSON.stringify(shape(fields));
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
      if (typeFieldsChanged(current, data.fields)) {
        const count = customCardCounts(store.cards)[id] ?? 0;
        if (count) throw new CardTypeInUseError(count);
      }

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
  // Read the epoch before scanning legacy and new cards. Every type-aware card writer
  // invalidates that epoch in the same transaction, including the first writer.
  if (typeFieldsChanged(current, data.fields)) {
    const count = await countKnowledgeCardsByCustomType(id);
    if (count) throw new CardTypeInUseError(count);
  }

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

export async function deleteCardType(id: string, expectedUpdatedAt?: string): Promise<void> {
  const mode = await getWritableStorageMode();

  if (mode === "local-json") {
    await mutateLocalStore((store) => {
      const current = store.cardTypes.find(type => type.id === id);
      if (!current) return { store, result: undefined };
      checkVersion(current, expectedUpdatedAt);
      const count = customCardCounts(store.cards)[id] ?? 0;
      if (count) throw new CardTypeInUseError(count);
      return {
        store: { ...store, cardTypes: store.cardTypes.filter(type => type.id !== id) },
        result: undefined,
      };
    });
    return;
  }

  const current = await getCardTypeById(id);
  if (!current) return;
  checkVersion(current, expectedUpdatedAt);
  const count = await countKnowledgeCardsByCustomType(id);
  if (count) throw new CardTypeInUseError(count);
  await docClient.send(
    new DeleteCommand({
      TableName: TableName.KNOWLEDGE_CARD_TYPES,
      Key: { id },
      ConditionExpression: "attribute_exists(id) AND updatedAt = :version",
      ExpressionAttributeValues: { ":version": current.updatedAt },
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
  signal?: AbortSignal,
  registryCommit?: DiskRegistryCommit
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
  const update = {
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
  };
  if (registryCommit) await commitDiskRegistry(update, registryCommit, signal);
  else await docClient.send(new UpdateCommand(update), { abortSignal: signal });
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
