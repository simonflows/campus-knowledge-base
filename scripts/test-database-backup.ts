import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateTableCommand,
  DescribeTableCommand,
  type DynamoDBClient,
  ListTablesCommand,
  PutItemCommand,
  ResourceInUseException,
  ResourceNotFoundException,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  captureDatabase,
  readDatabaseArchive,
  restoreDatabase,
  verifyDatabaseArchive,
  writeDatabaseArchive,
} from "../lib/database-backup";
import { TABLE_NAMES } from "../lib/schema";

const sourceEndpoint = "http://127.0.0.1:8000";
const recoveryEndpoint = "http://127.0.0.2:8000";
const targetPrefix = "qa095-backup-test-";
const oldTableNames = new Set(["knowledge-card-versions", "workflow-records"]);
const timestamp = new Date("2026-11-22T11:00:00.000Z");
type Item = Record<string, AttributeValue>;

function database() {
  const data = new Map<string, Item[]>();
  const reads: { table: string; consistent?: boolean; after?: string }[] = [];
  const writes: string[] = [];
  const client = {
    async send(command: unknown) {
      if (command instanceof ListTablesCommand) {
        const tables = [...data.keys()].sort();
        const start = command.input.ExclusiveStartTableName
          ? tables.indexOf(command.input.ExclusiveStartTableName) + 1
          : 0;
        return {
          TableNames: tables.slice(start, start + 1),
          LastEvaluatedTableName: tables.length > start + 1 ? tables[start] : undefined,
        };
      }
      if (command instanceof DescribeTableCommand) {
        const name = command.input.TableName!;
        if (!data.has(name)) {
          throw new ResourceNotFoundException({ message: "fixture missing", $metadata: {} });
        }
        return {
          Table: {
            TableName: name,
            TableStatus: "ACTIVE",
            KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
            AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
          },
        };
      }
      if (command instanceof ScanCommand) {
        const name = command.input.TableName!;
        const rows = data.get(name)!;
        const after = command.input.ExclusiveStartKey?.id?.S;
        reads.push({ table: name, consistent: command.input.ConsistentRead, after });
        const start = after ? rows.findIndex((row) => row.id.S === after) + 1 : 0;
        return {
          Items: rows.slice(start, start + 1),
          LastEvaluatedKey: rows.length > start + 1 ? { id: rows[start].id } : undefined,
        };
      }
      if (command instanceof CreateTableCommand) {
        const name = command.input.TableName!;
        writes.push("create");
        if (data.has(name)) {
          throw new ResourceInUseException({ message: "fixture exists", $metadata: {} });
        }
        data.set(name, []);
        return {};
      }
      if (command instanceof PutItemCommand) {
        writes.push("put");
        assert.equal(command.input.ConditionExpression, "attribute_not_exists(#id)");
        assert.deepEqual(command.input.ExpressionAttributeNames, { "#id": "id" });
        data.get(command.input.TableName!)!.push(command.input.Item!);
        return {};
      }
      throw new Error("Unexpected transport command");
    },
  } as unknown as DynamoDBClient;
  return { client, data, reads, writes };
}

function source() {
  const db = database();
  for (const name of TABLE_NAMES) db.data.set(name, []);
  db.data.set("knowledge-cards", [
    { id: { S: "second" }, flag: { BOOL: true } },
    {
      id: { S: "first" },
      payload: { M: { number: { N: "9007199254740993" }, bytes: { B: Uint8Array.of(0, 42, 255) } } },
      tags: { SS: ["z", "a"] },
    },
  ]);
  return db;
}

test("snapshot covers every project table and preserves typed values across Scan pages", async () => {
  const db = source();
  const archive = await captureDatabase({ client: db.client, endpoint: sourceEndpoint, timestamp });
  assert.deepEqual(archive.tables.map((table: { name: string }) => table.name), [...TABLE_NAMES].sort());
  assert.equal(archive.createdAt, "2026-11-22T11:00:00.000Z");
  const table = archive.tables.find((table: { name: string }) => table.name === "knowledge-cards");
  assert.ok(table);
  assert.equal(table.count, 2);
  assert.deepEqual(table.items, [
    {
      id: { S: "first" },
      payload: { M: { number: { N: "9007199254740993" }, bytes: { B: "ACr/" } } },
      tags: { SS: ["a", "z"] },
    },
    { id: { S: "second" }, flag: { BOOL: true } },
  ]);
  assert.equal(db.reads.filter((read) => read.table === "knowledge-cards").length, 2);
  assert(db.reads.every((read) => read.consistent === true));
  assert(!JSON.stringify(archive).includes(sourceEndpoint));
});

test("snapshot fails on a missing project table and supports the exact pre-migration table set", async () => {
  const db = source();
  for (const name of oldTableNames) db.data.delete(name);
  db.data.delete("knowledge-cards");
  await assert.rejects(captureDatabase({ client: db.client, endpoint: sourceEndpoint }), { code: "source-schema" });
  db.data.set("knowledge-cards", []);
  const archive = await captureDatabase({ client: db.client, endpoint: sourceEndpoint, scope: "pre-0.9.5" });
  assert.deepEqual(archive.tables.map((table: { name: string }) => table.name), [...db.data.keys()].sort());
  if (TABLE_NAMES.some((name) => oldTableNames.has(name))) {
    await assert.rejects(captureDatabase({ client: db.client, endpoint: sourceEndpoint }), { code: "source-schema" });
  }
});

test("verification rejects altered records, table counts and archive metadata", async () => {
  const arch = await captureDatabase({ client: source().client, endpoint: sourceEndpoint });
  const altered = structuredClone(arch);
  const changed = altered.tables.find((table) => table.name === "knowledge-cards");
  assert.ok(changed);
  changed.items[0].id = { S: "other" };
  assert.throws(() => verifyDatabaseArchive(altered), { code: "integrity" });
  const wrongCount = structuredClone(arch);
  wrongCount.tables[0].count++;
  assert.throws(() => verifyDatabaseArchive(wrongCount), { code: "integrity" });
  const wrongTimestamp = { ...arch, createdAt: timestamp.toISOString() };
  assert.throws(() => verifyDatabaseArchive(wrongTimestamp), { code: "integrity" });
});

test("restore preflights every target, refuses occupied prefixes, and verifies the restored contents", async () => {
  const sameDatabase = source();
  const archive = await captureDatabase({ client: sameDatabase.client, endpoint: sourceEndpoint });
  const options = {
    client: sameDatabase.client,
    endpoint: sourceEndpoint,
    target: { prefix: targetPrefix },
    archive,
  };
  sameDatabase.data.set(targetPrefix + "not-a-project-table", []);
  await assert.rejects(restoreDatabase(options), { code: "target-not-empty" });
  assert.deepEqual(sameDatabase.writes, []);
  sameDatabase.data.delete(targetPrefix + "not-a-project-table");
  await restoreDatabase(options);
  assert.equal(sameDatabase.data.get(targetPrefix + "knowledge-cards")?.length, 2);
  assert.equal(sameDatabase.data.get("knowledge-cards")?.length, 2);
  assert.equal(sameDatabase.writes.filter((write) => write === "create").length, TABLE_NAMES.length);
  const earlierWrites = sameDatabase.writes.length;
  await assert.rejects(restoreDatabase(options), { code: "target-not-empty" });
  assert.equal(sameDatabase.writes.length, earlierWrites);
});

test("unprefixed recovery requires explicit authorization and a different empty database", async () => {
  const archive = await captureDatabase({ client: source().client, endpoint: sourceEndpoint });
  const dest = database();
  const options = { client: dest.client, endpoint: recoveryEndpoint, archive };
  await assert.rejects(restoreDatabase({ ...options, target: {} }), { code: "unsafe-target" });
  await assert.rejects(
    restoreDatabase({ ...options, endpoint: sourceEndpoint + "/", target: { disasterRecovery: true } }),
    { code: "unsafe-target" },
  );
  dest.data.set("unrelated-table", []);
  await assert.rejects(
    restoreDatabase({ ...options, target: { disasterRecovery: true } }),
    { code: "target-not-empty" },
  );
  assert.deepEqual(dest.writes, []);
  dest.data.clear();
  await restoreDatabase({ ...options, target: { disasterRecovery: true } });
  assert.equal(dest.data.get("knowledge-cards")?.length, 2);
});

test("archive storage is exclusive and restricts the mode on POSIX", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kanon-backup-test-"));
  try {
    const file = join(directory, "archive.json");
    const archive = await captureDatabase({ client: source().client, endpoint: sourceEndpoint });
    await writeDatabaseArchive(file, archive);
    const before = await readFile(file);
    await assert.rejects(writeDatabaseArchive(file, archive), { code: "archive-write" });
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readDatabaseArchive(file), archive);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI requires a stopped-writers acknowledgement and verifies without a database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kanon-backup-cli-"));
  try {
    const file = join(directory, "archive.json");
    const archive = await captureDatabase({ client: source().client, endpoint: sourceEndpoint });
    await writeDatabaseArchive(file, archive);
    const run = (...args: string[]) => spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/database-backup.ts", ...args],
      { encoding: "utf8", timeout: 10000 },
    );
    const refusal = run("snapshot", file);
    assert.equal(refusal.status, 1, "the CLI must refuse snapshot without the acknowledgement");
    assert.deepEqual(JSON.parse(refusal.stderr), { status: "error", code: "usage" });
    const verified = run("verify", file);
    assert.equal(verified.status, 0, "local verification must not require a connection");
    const result = JSON.parse(verified.stdout);
    assert.equal(result.sha256, archive.sha256);
    assert.equal(result.entries, 2);
    assert(!verified.stdout.includes("9007199254740993"));
    assert(!verified.stdout.includes(sourceEndpoint));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
