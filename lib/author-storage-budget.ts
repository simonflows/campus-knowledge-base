import { GetCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { SessionUser } from "./auth";
import { docClient } from "./db";
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

function storageUpdate(id: string, bytes: number, limit: number, create = false) {
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

export function authorStorageWrites(user: SessionUser, writes: Writes, create = false) {
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

export function authorStorageFailure(codes: readonly (string | undefined)[], offset: number) {
  if (codes.slice(0, offset).includes("ConditionalCheckFailed")) return null;
  if (codes[offset] === "ConditionalCheckFailed") return storageLimit("author");
  if (codes[offset + 1] === "ConditionalCheckFailed") return storageLimit("site");
  return null;
}

function exceedsRemaining(value: unknown, remaining: number | undefined) {
  if (value === undefined || remaining === undefined) return false;
  if (typeof value !== "number") throw new Error("Invalid author storage counter");
  return value > remaining;
}

export async function readAuthorStorageFailure(storage: ReturnType<typeof authorStorageWrites>, abortSignal: AbortSignal) {
  const blocked = await Promise.all(storage.map(async ({ Update }) => {
    const { TableName, Key, ExpressionAttributeValues: limits } = Update;
    const { Item } = await docClient.send(new GetCommand({
      TableName, Key, ConsistentRead: true,
      ProjectionExpression: "#bytes, #drafts", ExpressionAttributeNames: { "#bytes": "bytes", "#drafts": "drafts" },
    }), { abortSignal });
    return exceedsRemaining(Item?.bytes, limits[":bytesRemaining"]) ||
      exceedsRemaining(Item?.drafts, limits[":draftsRemaining"]);
  }));
  if (blocked[0]) return storageLimit("author");
  if (blocked[1]) return storageLimit("site");
  return null;
}
