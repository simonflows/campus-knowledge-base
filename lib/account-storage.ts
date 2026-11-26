import { DeleteCommand, GetCommand, PutCommand, ScanCommand, TransactWriteCommand, type ScanCommandOutput, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { docClient } from "./db";
import { TableName } from "./schema";
import { accountUser, type AccountIdentity, type AccountProvider, type AccountRateBucket, type AccountSession, type AccountStore } from "./account-service";
import { staffGrantSchema } from "./account-validation";

const proofSchema = z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: z.number(), sentAt: z.number() });
const accountDirectorySchema = z.object({
  userId: z.string().startsWith("author-"),
  name: z.string().min(1).max(120),
  grant: staffGrantSchema,
});
const identitySchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  userId: z.string().startsWith("author-"),
  email: z.string().optional(),
  authProvider: z.literal("yandex").optional(),
  activatedAt: z.number().optional(),
  revision: z.number().int().nonnegative(),
  sessionEpoch: z.number().int().nonnegative(),
  expiresAt: z.number().optional(),
  name: z.string().optional(),
  passwordHash: z.string().optional(),
  verifiedAt: z.number().optional(),
  verification: proofSchema.optional(),
  passwordReset: proofSchema.optional(),
  grant: staffGrantSchema.optional(),
  grantSetBy: z.string().optional(),
  grantSetAt: z.number().optional(),
});
const sessionSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  identityId: z.string().regex(/^[0-9a-f]{64}$/),
  sessionEpoch: z.number().int().nonnegative(),
  expiresAt: z.number(),
});

const timeout = () => ({ abortSignal: AbortSignal.timeout(3500) });
const conditionFailed = (error: unknown) => error instanceof Error && error.name === "ConditionalCheckFailedException";

function rateUpdate({ id, limit, expiresAt }: AccountRateBucket) {
  return {
    Update: {
      TableName: TableName.ACCOUNT_RATE_LIMITS,
      Key: { id },
      ConditionExpression: "attribute_not_exists(#attempts) OR #attempts < :limit",
      UpdateExpression: "SET #attempts = if_not_exists(#attempts, :zero) + :one, expiresAt = :expiresAt",
      ExpressionAttributeNames: { "#attempts": "attempts" },
      ExpressionAttributeValues: { ":limit": limit, ":zero": 0, ":one": 1, ":expiresAt": expiresAt },
    },
  };
}

async function writeConditionally(input: TransactWriteCommandInput) {
  for (let attempt = 0; ; attempt++) {
    try {
      await docClient.send(new TransactWriteCommand(input), timeout());
      return true;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TransactionCanceledException" ||
        !("CancellationReasons" in error) || !Array.isArray(error.CancellationReasons)) throw error;
      const codes = error.CancellationReasons.map(reason => reason.Code);
      if (codes.includes("ConditionalCheckFailed")) return false;
      // A documented cancellation cannot have committed any item.
      if (attempt > 0 || !codes.includes("TransactionConflict")) throw error;
    }
  }
}

export const dynamoAccountStore: AccountStore = {
  async readIdentity(id) {
    const { Item } = await docClient.send(new GetCommand({
      TableName: TableName.ACCOUNT_IDENTITIES,
      Key: { id },
      ConsistentRead: true,
    }), timeout());
    return Item ? identitySchema.parse(Item) : undefined;
  },

  async findIdentityId(userId) {
    let cursor: ScanCommandOutput["LastEvaluatedKey"];
    let id: string | undefined;
    do {
      const page: ScanCommandOutput = await docClient.send(new ScanCommand({
        TableName: TableName.ACCOUNT_IDENTITIES,
        ConsistentRead: true,
        FilterExpression: "userId = :userId",
        ProjectionExpression: "id",
        ExpressionAttributeValues: { ":userId": userId },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }), timeout());
      for (const item of page.Items ?? []) {
        if (id) throw new Error("Duplicate public account identifier");
        id = z.string().regex(/^[0-9a-f]{64}$/).parse(item.id);
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return id;
  },

  async putIdentity(account: AccountIdentity, previousRevision: number | null, mailBudget?: AccountRateBucket) {
    const put = {
      TableName: TableName.ACCOUNT_IDENTITIES,
      Item: account,
      ...(previousRevision == null ? { ConditionExpression: "attribute_not_exists(id)" } : {
        ConditionExpression: "#revision = :revision",
        ExpressionAttributeNames: { "#revision": "revision" },
        ExpressionAttributeValues: { ":revision": previousRevision },
      }),
    };
    if (mailBudget) return writeConditionally({ TransactItems: [{ Put: put }, rateUpdate(mailBudget)] });
    try {
      await docClient.send(new PutCommand(put), timeout());
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  },

  async readSession(id) {
    const { Item } = await docClient.send(new GetCommand({
      TableName: TableName.ACCOUNT_SESSIONS,
      Key: { id },
      ConsistentRead: true,
    }), timeout());
    return Item ? sessionSchema.parse(Item) : undefined;
  },

  async putSession(session: AccountSession) {
    await docClient.send(new PutCommand({ TableName: TableName.ACCOUNT_SESSIONS, Item: session,
      ConditionExpression: "attribute_not_exists(id)",
    }), timeout());
  },

  async deleteSession(id) {
    await docClient.send(new DeleteCommand({ TableName: TableName.ACCOUNT_SESSIONS, Key: { id } }), timeout());
  },

  consumeRate(buckets) {
    return writeConditionally({ TransactItems: buckets.map(rateUpdate) });
  },
};

export async function listAccountStaff(providers: readonly AccountProvider[] = ["password", "yandex"]) {
  const predicates = [];
  if (providers.includes("password")) predicates.push("(attribute_not_exists(#provider) AND attribute_exists(verifiedAt))");
  const yandex = providers.includes("yandex");
  if (yandex) predicates.push("(#provider = :yandex AND attribute_exists(activatedAt))");
  if (!predicates.length) return [];
  const people: ReturnType<typeof accountUser>[] = [];
  let cursor: ScanCommandOutput["LastEvaluatedKey"];
  do {
    const page: ScanCommandOutput = await docClient.send(new ScanCommand({
      TableName: TableName.ACCOUNT_IDENTITIES,
      ConsistentRead: true,
      FilterExpression: "(" + predicates.join(" OR ") + ") AND attribute_exists(#grant) AND #grant.#role <> :author",
      ProjectionExpression: "userId, #name, #grant",
      ExpressionAttributeNames: { "#name": "name", "#grant": "grant", "#role": "role", "#provider": "authProvider" },
      ExpressionAttributeValues: { ":author": "author", ...(yandex ? { ":yandex": "yandex" } : {}) },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }), timeout());
    for (const record of page.Items ?? []) people.push(accountUser(accountDirectorySchema.parse(record)));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return people;
}
