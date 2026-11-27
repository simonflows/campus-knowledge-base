import { createHash } from "node:crypto";
import {
  GetCommand,
  PutCommand,
  ScanCommand,
  type ScanCommandOutput,
} from "@aws-sdk/lib-dynamodb";

import { docClient, getWritableStorageMode } from "./db";
import {
  cardContent,
  getApprovedVersion,
  type KnowledgeCard,
} from "./knowledge";
import {
  isRoadmapIndicator,
  type IndicatorConfirmation,
  type IndicatorSlot,
} from "./strategy";
import { getReadableStorageMode } from "./runtime-storage-policy";
import { TableName } from "./schema";

export type ApprovedCardVersion = {
  id: string;
  cardId: string;
  snapshot: KnowledgeCard;
  recordedAt: string;
  actorId: string;
  actorName: string;
  reason: string;
  legacyBaseline: boolean;
  /** Internal audit metadata, excluded from the public snapshot and its hash. */
  indicatorConfirmations?: Partial<
    Record<IndicatorSlot, IndicatorConfirmation>
  >;
};

export type CardVersionActor = { id: string; name: string };

// DynamoDB maps and JSON objects can present the same keys in a different order.
function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left === right ? 0 : 1))
        .map(([key, content]) => [key, sortObjectKeys(content)])
    );
  }
  return value;
}

export function getCardVersionId(card: KnowledgeCard): string {
  const published: Partial<KnowledgeCard> = cardContent(
    getApprovedVersion(card) ?? card
  );
  delete published.createdAt;
  delete published.updatedAt;
  delete published.status;
  delete published.freshness;
  delete published.changeReason;
  // Omitting optional metadata and explicitly clearing it describe the same public content.
  if (!published.sources?.length) delete published.sources;
  if (!published.verifiedFacts?.length) delete published.verifiedFacts;
  return (
    "cv-" +
    createHash("sha256")
      .update(JSON.stringify(sortObjectKeys(published)))
      .digest("hex")
  );
}

export function describeApprovedCardVersion(
  card: KnowledgeCard,
  options: {
    legacyBaseline: boolean;
    recordedAt: string;
    actor?: CardVersionActor;
    reason?: string;
  }
): ApprovedCardVersion {
  const published = getApprovedVersion(card);
  if (!published) throw new Error("Для карточки нет утверждённой версии");
  const snapshot = { ...cardContent(published), status: "approved" as const };
  delete snapshot.freshness;
  if (published.reviewedAt) snapshot.reviewedAt = published.reviewedAt;
  if (published.reviewedBy) snapshot.reviewedBy = published.reviewedBy;
  return {
    id: getCardVersionId(published),
    cardId: published.id,
    snapshot,
    recordedAt: options.recordedAt,
    actorId: options.actor?.id ?? "",
    actorName: options.actor?.name ?? published.reviewedBy ?? "",
    reason:
      options.reason?.trim() ||
      published.changeReason?.trim() ||
      (options.legacyBaseline
        ? "Начальный снимок доступной истории"
        : "Утверждена карточка"),
    legacyBaseline: options.legacyBaseline,
    ...(isRoadmapIndicator(published) &&
      published.indicatorConfirmations && {
        indicatorConfirmations: published.indicatorConfirmations,
      }),
  };
}

export async function getApprovedCardVersion(
  id: string
): Promise<ApprovedCardVersion | null> {
  if ((await getReadableStorageMode()) !== "dynamodb") return null;
  const { Item } = await docClient.send(
    new GetCommand({
      TableName: TableName.KNOWLEDGE_CARD_VERSIONS,
      Key: { id },
      ConsistentRead: true,
    })
  );
  return (Item as ApprovedCardVersion | undefined) ?? null;
}

export async function getApprovedCardVersions(
  cardId: string
): Promise<ApprovedCardVersion[]> {
  if ((await getReadableStorageMode()) !== "dynamodb") return [];
  const versions: ApprovedCardVersion[] = [];
  let cursor: ScanCommandOutput["LastEvaluatedKey"];
  do {
    const page: ScanCommandOutput = await docClient.send(
      new ScanCommand({
        TableName: TableName.KNOWLEDGE_CARD_VERSIONS,
        ConsistentRead: true,
        FilterExpression: "cardId = :card",
        ExpressionAttributeValues: { ":card": cardId },
        ExclusiveStartKey: cursor,
      })
    );
    versions.push(...((page.Items ?? []) as ApprovedCardVersion[]));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return versions.sort(
    (first, second) =>
      second.recordedAt.localeCompare(first.recordedAt) ||
      first.id.localeCompare(second.id)
  );
}

export function insertCardVersion(version: ApprovedCardVersion) {
  return {
    TableName: TableName.KNOWLEDGE_CARD_VERSIONS,
    Item: version,
    ConditionExpression: "attribute_not_exists(id)",
  };
}

export async function ensureApprovedCardVersion(
  card: KnowledgeCard,
  actor?: CardVersionActor,
  reason?: string
): Promise<ApprovedCardVersion> {
  const mode = await getReadableStorageMode();
  const version = describeApprovedCardVersion(card, {
    legacyBaseline: true,
    recordedAt: mode === "dynamodb" ? new Date().toISOString() : "",
    actor,
    reason,
  });
  // Demo/export shows the current card with a stable link, with no claim of persistent history.
  if (mode !== "dynamodb") return version;
  const existing = await getApprovedCardVersion(version.id);
  if (existing) return existing;
  await getWritableStorageMode();
  try {
    await docClient.send(new PutCommand(insertCardVersion(version)));
    return version;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      const concurrent = await getApprovedCardVersion(version.id);
      if (concurrent) return concurrent;
    }
    throw error;
  }
}
