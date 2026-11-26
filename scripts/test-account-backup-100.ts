import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  PutItemCommand,
  ResourceNotFoundException,
  ScanCommand,
  type AttributeValue,
  type ScanCommandInput,
} from "@aws-sdk/client-dynamodb";
import { captureDatabase, restoreDatabase, verifyDatabaseArchive } from "../lib/database-backup";
import { TABLE_NAMES, TableName } from "../lib/schema";

const endpoint = "http://127.0.0.1:1";
const targetPrefix = "qa095-account-backup-";
const createdAt = "2026-11-26T09:00:00.500Z";
const cutoff = Date.parse(createdAt) / 1000;
const ttlTables = [TableName.ACCOUNT_SESSIONS, TableName.ACCOUNT_RATE_LIMITS];
type Item = Record<string, AttributeValue>;

function fixture(context: TestContext) {
  const client = new DynamoDBClient({
    endpoint, region: "ru-central1", maxAttempts: 1,
    credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
  });
  context.after(() => client.destroy());
  const permanent = { id: { S: "storage-counter" }, value: { N: "15" } };
  const expired = { id: { S: "expired" }, expiresAt: { N: String(cutoff - 1) } };
  const data = new Map<string, Item[]>(TABLE_NAMES.map(name => [name, [expired]]));
  for (const name of ttlTables) data.set(name, [
    expired,
    { id: { S: "at-cutoff" }, expiresAt: { N: String(cutoff) } },
    { id: { S: "active" }, expiresAt: { N: String(cutoff + 0.001) } },
    permanent,
    { id: { S: "malformed-null" }, expiresAt: { NULL: true } },
    { id: { S: "malformed-string" }, expiresAt: { S: String(cutoff - 1) } },
  ]);
  const scans: ScanCommandInput[] = [];
  const controls = { onScan: () => {}, repeatFilteredCursor: false };

  context.mock.method(client, "send", async (command: unknown) => {
    if (command instanceof ListTablesCommand) return { TableNames: [...data.keys()] };
    if (command instanceof DescribeTableCommand) {
      const name = command.input.TableName!;
      if (!data.has(name)) throw new ResourceNotFoundException({ message: "Fixture target is empty", $metadata: {} });
      return { Table: {
        TableName: name, TableStatus: "ACTIVE",
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      } };
    }
    if (command instanceof ScanCommand) {
      const input = command.input;
      scans.push(input);
      controls.onScan();
      const rows = data.get(input.TableName!);
      assert.ok(rows);
      if (controls.repeatFilteredCursor && input.FilterExpression)
        return { Items: [], LastEvaluatedKey: { id: { S: "same-key" } } };

      const previous = input.ExclusiveStartKey?.id?.S;
      const start = previous ? rows.findIndex(row => row.id.S === previous) + 1 : 0;
      const scanned = rows.slice(start, start + 1);
      const items = input.FilterExpression ? scanned.filter((row) => {
        assert.equal(input.FilterExpression, "NOT (attribute_type(#expiresAt, :numberType) AND #expiresAt <= :cutoff)");
        assert.deepEqual(input.ExpressionAttributeNames, { "#expiresAt": "expiresAt" });
        assert.deepEqual(input.ExpressionAttributeValues, { ":numberType": { S: "N" }, ":cutoff": { N: String(cutoff) } });
        return row.expiresAt?.N === undefined || Number(row.expiresAt.N) > cutoff;
      }) : scanned;
      return { Items: items, LastEvaluatedKey: rows.length > start + 1 ? { id: rows[start].id } : undefined };
    }
    if (command instanceof CreateTableCommand) {
      const name = command.input.TableName!;
      assert.ok(name.startsWith(targetPrefix));
      assert.ok(!data.has(name));
      data.set(name, []);
      return {};
    }
    if (command instanceof PutItemCommand) {
      const name = command.input.TableName!;
      assert.ok(name.startsWith(targetPrefix));
      assert.equal(command.input.ConditionExpression, "attribute_not_exists(#id)");
      data.get(name)!.push(command.input.Item!);
      return {};
    }
    return assert.fail("Unexpected synthetic backup operation");
  });
  return { client, data, scans, controls };
}

test("the snapshot omits only expired numeric TTL rows and freezes its cutoff across pages", async context => {
  const fixtureDb = fixture(context);
  const timestamp = new Date(createdAt);
  fixtureDb.controls.onScan = () => timestamp.setUTCDate(27);
  const archive = await captureDatabase({ client: fixtureDb.client, endpoint, timestamp });
  const verified = verifyDatabaseArchive(archive);
  assert.equal(verified.tables.length, 11);
  for (const table of verified.tables) {
    const expected = ttlTables.some(name => name === table.name)
      ? ["active", "malformed-null", "malformed-string", "storage-counter"] : ["expired"];
    assert.deepEqual(table.items.map(item => item.id), expected.map(S => ({ S })), table.name);
    assert.equal(table.count, expected.length);
  }
  assert.equal(verified.createdAt, createdAt);
  assert.equal(fixtureDb.scans.filter(scan => scan.FilterExpression).length, 12);
  assert.ok(fixtureDb.scans.every(scan => scan.ConsistentRead));
});

test("restore writes and verifies exactly the captured rows in an isolated namespace", async context => {
  const db = fixture(context);
  const archive = await captureDatabase({ client: db.client, endpoint, timestamp: new Date(createdAt) });
  const result = await restoreDatabase({ client: db.client, endpoint, target: { prefix: targetPrefix }, archive });
  assert.equal(result.sha256, archive.sha256);
  for (const name of ttlTables) {
    assert.equal(db.data.get(name)?.length, 6);
    assert.equal(db.data.get(targetPrefix + name)?.length, 4);
    assert.ok(!db.scans.some(scan => scan.TableName === targetPrefix + name && scan.FilterExpression));
  }
  for (const name of TABLE_NAMES.filter(name => !ttlTables.some(ttlTable => ttlTable === name))) {
    assert.deepEqual(db.data.get(targetPrefix + name), db.data.get(name));
  }
});

test("a repeated cursor on empty filtered pages terminates with an integrity error", async context => {
  const db = fixture(context);
  db.controls.repeatFilteredCursor = true;
  await assert.rejects(captureDatabase({ client: db.client, endpoint, timestamp: new Date(createdAt) }), { code: "integrity" });
  const filtered = db.scans.filter(scan => scan.FilterExpression);
  assert.equal(filtered.length, 2);
  assert.ok(filtered.every(scan => scan.TableName === TableName.ACCOUNT_RATE_LIMITS));
  assert.equal(filtered[1].ExclusiveStartKey?.id?.S, "same-key");
});
