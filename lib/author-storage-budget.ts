import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { SessionUser } from "./auth";
import { EditorialError } from "./editorial";
import { TableName } from "./schema";

const AUTHOR_BYTES = 4 * 1024 * 1024;
const SITE_BYTES = 24 * 1024 * 1024;
const AUTHOR_DRAFTS = 16;
const DELETE_RESERVE = 4 * 1024;
const MIN_ROW_BYTES = 1024;
const SITE_KEY = "storage:author:site";

type Writes = NonNullable<TransactWriteCommandInput["TransactItems"]>;

function archiveBytes(item: Record<string, unknown>) {
  let values = 0;
  const json = JSON.stringify(item, (_key, value: unknown) => {
    values++;
    return value;
  });
  // The backup writes typed attributes and key/value pairs. Allow room for
  // those wrappers, alongside a minimum charge that also bounds the row count.
  return Math.max(MIN_ROW_BYTES, Buffer.byteLength(json, "utf8") + 24 * values);
}

function storageLimit(kind: "author" | "site" | "item") {
  const message = kind === "item" ? "Материал слишком велик для сохранения." :
    kind === "author" ? "Достигнут лимит хранения черновиков автора." :
    "Достигнут общий лимит хранения личных черновиков.";
  return new EditorialError(message + " Скопируйте текущий текст. Сохранённую редакцию можно скачать в Word.", kind === "item" ? 413 : 429);
}

function storageUpdate(id: string, bytes: number, limit: number, create = false): Writes[number] {
  return {
    Update: {
      TableName: TableName.ACCOUNT_RATE_LIMITS,
      Key: { id },
      ConditionExpression: "(attribute_not_exists(#bytes) OR #bytes <= :bytesRemaining)" +
        (create ? " AND (attribute_not_exists(#drafts) OR #drafts <= :draftsRemaining)" : ""),
      UpdateExpression: "SET #bytes = if_not_exists(#bytes, :zero) + :bytes" +
        (create ? ", #drafts = if_not_exists(#drafts, :zero) + :drafts" : ""),
      ExpressionAttributeNames: { "#bytes": "bytes", ...(create ? { "#drafts": "drafts" } : {}) },
      ExpressionAttributeValues: {
        ":bytes": bytes,
        ":bytesRemaining": limit - bytes,
        ":zero": 0,
        ...(create ? { ":drafts": 1, ":draftsRemaining": AUTHOR_DRAFTS - 1 } : {}),
      },
    },
  };
}

export function authorStorageWrites(user: SessionUser, writes: Writes, create = false): Writes {
  if (user.role !== "author") return [];
  // Reserve the small additional tombstone and its audit row in advance, so
  // deletion remains available at the limit while retaining the whole history.
  const bytes = writes.reduce((total, write) => total + (write.Put?.Item ? archiveBytes(write.Put.Item) : 0),
    create ? DELETE_RESERVE : 0);
  if (bytes > AUTHOR_BYTES) throw storageLimit("item");
  return [
    storageUpdate("storage:author:user:" + user.id, bytes, AUTHOR_BYTES, create),
    storageUpdate(SITE_KEY, bytes, SITE_BYTES),
  ];
}

export function authorStorageFailure(error: unknown, offset: number, charged: boolean) {
  if (!charged || !(error instanceof TransactionCanceledException)) return null;
  const reasons = error.CancellationReasons;
  if (reasons?.slice(0, offset).some(reason => reason.Code === "ConditionalCheckFailed")) return null;
  if (reasons?.[offset]?.Code === "ConditionalCheckFailed") return storageLimit("author");
  if (reasons?.[offset + 1]?.Code === "ConditionalCheckFailed") return storageLimit("site");
  return null;
}
