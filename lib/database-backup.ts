import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import {
  CreateTableCommand,
  DescribeTableCommand,
  type DynamoDBClient,
  ListTablesCommand,
  PutItemCommand,
  ResourceNotFoundException,
  ScanCommand,
  type AttributeValue,
  type TableDescription,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { z } from "zod";
import { TABLE_NAMES, TABLE_SCHEMAS, type TableName } from "./schema";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ITEM_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 100_000;
const MAX_PAGES = MAX_ITEMS + 1;
const PRE_095_EXCLUSIONS = new Set(["knowledge-card-versions", "workflow-records"]);
const PREFIX_PATTERN = /^qa095-[a-z0-9][a-z0-9-]{0,60}-$/;
const COMMAND_TIMEOUT = 15_000;
const numericPattern = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,4}))?$/;

type ErrorCode =
  | "configuration"
  | "source-read"
  | "source-schema"
  | "integrity"
  | "archive-limit"
  | "archive-read"
  | "archive-write"
  | "unsafe-target"
  | "target-not-empty"
  | "target-read"
  | "target-write"
  | "target-verification";

export class DatabaseBackupError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

type ArchiveScope = "current" | "pre-0.9.5";
type ArchiveValue =
  | { S: string }
  | { N: string }
  | { B: string }
  | { BOOL: boolean }
  | { NULL: true }
  | { SS: string[] }
  | { NS: string[] }
  | { BS: string[] }
  | { M: ArchiveItem }
  | { L: ArchiveValue[] };
type ArchiveItem = { [attribute: string]: ArchiveValue };

const sha256Pattern = /^[0-9a-f]{64}$/;
const digestSchema = z.string().regex(sha256Pattern);
const keySchema = z.strictObject({
  AttributeName: z.string().min(1),
  KeyType: z.enum(["HASH", "RANGE"]),
});
const attributeDefinition = z.strictObject({
  AttributeName: z.string().min(1),
  AttributeType: z.enum(["S", "N", "B"]),
});
const indexSchema = z.strictObject({
  IndexName: z.string().min(1),
  KeySchema: z.array(keySchema).min(1).max(2),
  Projection: z.strictObject({
    ProjectionType: z.enum(["ALL", "KEYS_ONLY", "INCLUDE"]),
    NonKeyAttributes: z.array(z.string().min(1)).max(100).optional(),
  }),
});
const archivedTableSchema = z.strictObject({
  keys: z.array(keySchema).min(1).max(2),
  attributes: z.array(attributeDefinition).min(1).max(100),
  indexes: z.array(indexSchema).max(20),
});
type ArchivedTableSchema = z.infer<typeof archivedTableSchema>;

const archiveEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  createdAt: z.iso.datetime({ precision: 3 }),
  scope: z.enum(["current", "pre-0.9.5"]),
  sourceSha256: digestSchema,
  tables: z.array(
    z.strictObject({
      name: z.string().min(1).max(255),
      schema: archivedTableSchema,
      count: z.number().int().min(0).max(MAX_ITEMS),
      items: z.array(z.unknown()).max(MAX_ITEMS),
      sha256: digestSchema,
    }),
  ).max(TABLE_NAMES.length),
  sha256: digestSchema,
});

type ArchivedTable = {
  name: TableName;
  schema: ArchivedTableSchema;
  count: number;
  items: ArchiveItem[];
  sha256: string;
};
type ArchiveBody = Omit<z.infer<typeof archiveEnvelopeSchema>, "tables" | "sha256"> & {
  tables: ArchivedTable[];
};
export type DatabaseArchive = ArchiveBody & { sha256: string };
type DatabaseConnection = { client: DynamoDBClient; endpoint: string };
type RestoreTarget = { prefix?: string; disasterRecovery?: boolean };
type TargetTable = { table: ArchivedTable; name: string };

function commandOptions() {
  return { abortSignal: AbortSignal.timeout(COMMAND_TIMEOUT) };
}

function order(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalJson(value: unknown) {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (!child || typeof child !== "object" || Array.isArray(child)) return child;
    return Object.fromEntries(
      Object.entries(child).sort(([left], [right]) => order(left, right)),
    );
  });
}

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function checksum(value: unknown) {
  return hash(canonicalJson(value));
}

export function validateDatabaseEndpoint(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new DatabaseBackupError("configuration");
  }
  const loopback = ["127.0.0.1", "127.0.0.2", "127.0.0.3", "[::1]", "localhost"];
  if (
    (url.protocol !== "https:" && (url.protocol !== "http:" || !loopback.includes(url.hostname))) ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new DatabaseBackupError("configuration");
  }
  return url.href.replace(/\/+$/, "");
}

function tableNames(scope: ArchiveScope) {
  return TABLE_NAMES.filter((name) => scope === "current" || !PRE_095_EXCLUSIONS.has(name)).sort();
}

function canonicalSchema(shape: ArchivedTableSchema): ArchivedTableSchema {
  return {
    keys: [...shape.keys].sort((a, b) => order(a.KeyType, b.KeyType)),
    attributes: [...shape.attributes].sort((a, b) => order(a.AttributeName, b.AttributeName)),
    indexes: shape.indexes.map((index) => ({
      IndexName: index.IndexName,
      KeySchema: [...index.KeySchema].sort((a, b) => order(a.KeyType, b.KeyType)),
      Projection: {
        ProjectionType: index.Projection.ProjectionType,
        ...(index.Projection.NonKeyAttributes?.length
          ? { NonKeyAttributes: [...index.Projection.NonKeyAttributes].sort() }
          : {}),
      },
    })).sort((a, b) => order(a.IndexName, b.IndexName)),
  };
}

function expectedSchema(name: TableName) {
  const expected = TABLE_SCHEMAS[name];
  return canonicalSchema(archivedTableSchema.parse({
    keys: expected.keySchema,
    attributes: expected.attributeDefinitions,
    indexes: expected.globalSecondaryIndexes ?? [],
  }));
}

function observedSchema(table: TableDescription | undefined) {
  if (
    table?.TableStatus !== "ACTIVE" ||
    table.LocalSecondaryIndexes?.length ||
    table.StreamSpecification?.StreamEnabled
  ) {
    throw new DatabaseBackupError("source-schema");
  }
  const parsed = archivedTableSchema.safeParse({
    keys: table.KeySchema,
    attributes: table.AttributeDefinitions,
    indexes: (table.GlobalSecondaryIndexes ?? []).map((index) => ({
      IndexName: index.IndexName,
      KeySchema: index.KeySchema,
      Projection: index.Projection,
    })),
  });
  if (!parsed.success) throw new DatabaseBackupError("source-schema");
  return canonicalSchema(parsed.data);
}

function invalid(): never {
  throw new DatabaseBackupError("integrity");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return value as Record<string, unknown>;
}

function normalizeNumber(value: unknown): string {
  if (typeof value !== "string" || value.length > 180) invalid();
  const match = numericPattern.exec(value);
  if (!match) invalid();
  const [, sign, whole, fraction = "", exponent = "0"] = match;
  const raw = whole + fraction;
  if (!raw.length) invalid();
  const leadingZeros = raw.length - raw.replace(/^0+/, "").length;
  const significant = raw.slice(leadingZeros).replace(/0+$/, "");
  if (!significant) return "0";
  const point = whole.length + Number(exponent) - leadingZeros;
  if (significant.length > 38 || point < -129 || point > 126) invalid();
  const prefix = sign === "-" ? "-" : "";
  if (point <= 0) return prefix + "0." + "0".repeat(-point) + significant;
  if (point >= significant.length) {
    return prefix + significant + "0".repeat(point - significant.length);
  }
  return prefix + significant.slice(0, point) + "." + significant.slice(point);
}

function getString(value: unknown): string {
  if (typeof value !== "string") invalid();
  return value;
}

function encodeBinary(value: unknown, fromDatabase: boolean): string {
  if (fromDatabase && value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (fromDatabase || typeof value !== "string") invalid();
  if (Buffer.from(value, "base64").toString("base64") !== value) invalid();
  return value;
}

function normalizeSet(value: unknown, encode: (element: unknown) => string) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) invalid();
  const values = value.map(encode).sort();
  if (new Set(values).size !== values.length) invalid();
  return values;
}

function encodeItem(value: unknown, fromDatabase: boolean, depth = 0): ArchiveItem {
  if (depth > 32) invalid();
  return Object.fromEntries(Object.entries(record(value)).map(([key, attribute]) => {
    if (!key || Buffer.byteLength(key, "utf8") > 65_535) invalid();
    return [key, encodeValue(attribute, fromDatabase, depth)];
  }));
}

function encodeValue(value: unknown, fromDatabase: boolean, depth: number): ArchiveValue {
  if (depth > 32) invalid();
  const fields = Object.entries(record(value));
  if (fields.length !== 1) invalid();
  const [type, data] = fields[0];
  switch (type) {
    case "S": return { S: getString(data) };
    case "N": return { N: normalizeNumber(data) };
    case "B": return { B: encodeBinary(data, fromDatabase) };
    case "SS": return { SS: normalizeSet(data, getString) };
    case "NS": return { NS: normalizeSet(data, normalizeNumber) };
    case "BS": return { BS: normalizeSet(data, (element) => encodeBinary(element, fromDatabase)) };
    case "M": return { M: encodeItem(data, fromDatabase, depth + 1) };
    case "L":
      if (!Array.isArray(data) || data.length > MAX_ITEMS) invalid();
      return { L: data.map((element) => encodeValue(element, fromDatabase, depth + 1)) };
    case "BOOL":
      if (typeof data !== "boolean") invalid();
      return { BOOL: data };
    case "NULL":
      if (data !== true) invalid();
      return { NULL: true };
    default: return invalid();
  }
}

function decodeItem(item: ArchiveItem): Record<string, AttributeValue> {
  return Object.fromEntries(
    Object.entries(item).map(([name, value]) => [name, decodeValue(value)]),
  );
}

function decodeValue(value: ArchiveValue): AttributeValue {
  if ("B" in value) return { B: Buffer.from(value.B, "base64") };
  if ("BS" in value) return { BS: value.BS.map((part) => Buffer.from(part, "base64")) };
  if ("M" in value) return { M: decodeItem(value.M) };
  if ("L" in value) return { L: value.L.map(decodeValue) };
  return value;
}

function rowId(item: ArchiveItem) {
  if (
    !Object.hasOwn(item, "id") || !("S" in item.id) ||
    !item.id.S || Buffer.byteLength(item.id.S, "utf8") > 2048
  ) {
    invalid();
  }
  return item.id.S;
}

function checkTableItems(items: ArchiveItem[]) {
  let previous: string | undefined;
  for (const item of items) {
    const id = rowId(item);
    if (previous !== undefined && order(previous, id) >= 0) invalid();
    previous = id;
  }
}

function addBudget(budget: { rows: number; bytes: number }, item: ArchiveItem) {
  const bytes = Buffer.byteLength(canonicalJson(item), "utf8");
  budget.rows++;
  budget.bytes += bytes + 1;
  if (budget.rows > MAX_ITEMS || budget.bytes > MAX_ARCHIVE_BYTES || bytes > MAX_ITEM_BYTES) {
    throw new DatabaseBackupError("archive-limit");
  }
}

export function verifyDatabaseArchive(input: unknown): DatabaseArchive {
  const result = archiveEnvelopeSchema.safeParse(input);
  if (!result.success) invalid();
  const { tables: rawTables, sha256, ...metadata } = result.data;
  const expectedNames = tableNames(metadata.scope);
  if (rawTables.length !== expectedNames.length) invalid();
  const budget = { rows: 0, bytes: 0 };
  const tables = rawTables.map((table, index): ArchivedTable => {
    const name = expectedNames[index];
    if (
      table.name !== name || table.count !== table.items.length ||
      checksum(table.schema) !== checksum(expectedSchema(name))
    ) invalid();
    const items = table.items.map((rawItem) => {
      const item = encodeItem(rawItem, false);
      addBudget(budget, item);
      return item;
    });
    checkTableItems(items);
    const body = { name, schema: table.schema, count: table.count, items };
    if (checksum(body) !== table.sha256) invalid();
    return { ...body, sha256: table.sha256 };
  });
  const body = { ...metadata, tables };
  if (checksum(body) !== sha256) invalid();
  return { ...body, sha256 };
}

async function describe(client: DynamoDBClient, name: string) {
  try {
    const output = await client.send(new DescribeTableCommand({ TableName: name }), commandOptions());
    return output.Table;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return undefined;
    throw error;
  }
}

async function scan(
  client: DynamoDBClient,
  name: string,
  budget: { rows: number; bytes: number },
) {
  const items: ArchiveItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: Record<string, AttributeValue> | undefined;
  do {
    const response = await client.send(new ScanCommand({
      TableName: name,
      ConsistentRead: true,
      ExclusiveStartKey: cursor,
    }), commandOptions());
    for (const found of response.Items ?? []) {
      const item = encodeItem(found, true);
      addBudget(budget, item);
      items.push(item);
    }
    cursor = response.LastEvaluatedKey;
    if (!cursor || Object.keys(cursor).length === 0) break;
    const id = rowId(encodeItem(cursor, true));
    if (seenCursors.has(id) || seenCursors.size >= MAX_PAGES) invalid();
    seenCursors.add(id);
  } while (true);
  items.sort((a, b) => order(rowId(a), rowId(b)));
  checkTableItems(items);
  return items;
}

export async function captureDatabase({
  client,
  endpoint,
  scope = "current",
  timestamp = new Date(),
}: DatabaseConnection & { scope?: ArchiveScope; timestamp?: Date }): Promise<DatabaseArchive> {
  const sourceSha256 = hash(validateDatabaseEndpoint(endpoint));
  const tables: ArchivedTable[] = [];
  const budget = { rows: 0, bytes: 0 };
  try {
    if (scope === "pre-0.9.5") {
      for (const name of PRE_095_EXCLUSIONS) {
        if (await describe(client, name)) throw new DatabaseBackupError("source-schema");
      }
    }
    for (const name of tableNames(scope)) {
      const schema = observedSchema(await describe(client, name));
      if (checksum(schema) !== checksum(expectedSchema(name))) {
        throw new DatabaseBackupError("source-schema");
      }
      const items = await scan(client, name, budget);
      const body = { name, schema, count: items.length, items };
      tables.push({ ...body, sha256: checksum(body) });
    }
  } catch (error) {
    if (error instanceof DatabaseBackupError) throw error;
    throw new DatabaseBackupError("source-read");
  }
  const body: ArchiveBody = { version: 1, createdAt: timestamp.toISOString(), scope, sourceSha256, tables };
  return { ...body, sha256: checksum(body) };
}

async function preflightTarget(client: DynamoDBClient, prefix: string, tables: TargetTable[]) {
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.send(new ListTablesCommand({
      Limit: 100,
      ExclusiveStartTableName: cursor,
    }), commandOptions());
    if (!Array.isArray(page.TableNames)) throw new DatabaseBackupError("target-read");
    if (page.TableNames.some((name) => name.startsWith(prefix))) {
      throw new DatabaseBackupError("target-not-empty");
    }
    cursor = page.LastEvaluatedTableName;
    if (!cursor) break;
    if (seen.has(cursor) || seen.size >= MAX_PAGES) throw new DatabaseBackupError("target-read");
    seen.add(cursor);
  } while (true);

  for (const { name } of tables) {
    if (await describe(client, name)) throw new DatabaseBackupError("target-not-empty");
  }
}

async function populateTarget(client: DynamoDBClient, tables: TargetTable[]) {
  for (const { table, name } of tables) {
    await client.send(new CreateTableCommand({
      TableName: name,
      KeySchema: table.schema.keys,
      AttributeDefinitions: table.schema.attributes,
      ...(table.schema.indexes.length ? { GlobalSecondaryIndexes: table.schema.indexes } : {}),
      BillingMode: "PAY_PER_REQUEST",
    }), commandOptions());
    await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: name });
  }
  for (const { table, name } of tables) {
    for (const item of table.items) {
      await client.send(new PutItemCommand({
        TableName: name,
        Item: decodeItem(item),
        ConditionExpression: "attribute_not_exists(#id)",
        ExpressionAttributeNames: { "#id": "id" },
      }), commandOptions());
    }
  }
}

export async function restoreDatabase({
  client, endpoint, target, archive: input,
}: DatabaseConnection & { target: RestoreTarget; archive: unknown }) {
  const archive = verifyDatabaseArchive(input);
  const targetSha256 = hash(validateDatabaseEndpoint(endpoint));
  const prefix = target.prefix ?? "";
  const explicitPrefix = PREFIX_PATTERN.test(prefix) && target.disasterRecovery !== true;
  const separateDatabase = target.disasterRecovery === true && target.prefix === undefined
    && targetSha256 !== archive.sourceSha256;
  if (!explicitPrefix && !separateDatabase) throw new DatabaseBackupError("unsafe-target");
  const tables = archive.tables.map((table) => ({ table, name: prefix + table.name }));

  try {
    await preflightTarget(client, prefix, tables);
  } catch (error) {
    if (error instanceof DatabaseBackupError) throw error;
    throw new DatabaseBackupError("target-read");
  }
  try {
    await populateTarget(client, tables);
  } catch {
    throw new DatabaseBackupError("target-write");
  }
  try {
    const budget = { rows: 0, bytes: 0 };
    for (const { table, name } of tables) {
      const schema = observedSchema(await describe(client, name));
      const items = await scan(client, name, budget);
      const measured = { name: table.name, schema, count: items.length, items };
      if (checksum(measured) !== table.sha256) throw new DatabaseBackupError("target-verification");
    }
  } catch {
    throw new DatabaseBackupError("target-verification");
  }
  return archive;
}

export async function writeDatabaseArchive(path: string, input: unknown) {
  const archive = verifyDatabaseArchive(input);
  const content = canonicalJson(archive) + "\n";
  if (Buffer.byteLength(content, "utf8") > MAX_ARCHIVE_BYTES) {
    throw new DatabaseBackupError("archive-limit");
  }
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
  } catch {
    throw new DatabaseBackupError("archive-write");
  }
}

export async function readDatabaseArchive(path: string): Promise<DatabaseArchive> {
  let content: string;
  try {
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new DatabaseBackupError("archive-read");
      if (info.size > MAX_ARCHIVE_BYTES) throw new DatabaseBackupError("archive-limit");
      const data: Uint8Array[] = [];
      for await (const chunk of file.createReadStream({ autoClose: false, end: MAX_ARCHIVE_BYTES })) {
        data.push(chunk);
      }
      const bytes = Buffer.concat(data);
      if (bytes.length > MAX_ARCHIVE_BYTES) throw new DatabaseBackupError("archive-limit");
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof DatabaseBackupError) throw error;
    throw new DatabaseBackupError("archive-read");
  }
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch {
    return invalid();
  }
  const archive = verifyDatabaseArchive(input);
  if (canonicalJson(archive) + "\n" !== content) invalid();
  return archive;
}
