import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  CreateTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  ListTablesCommand,
  UpdateTimeToLiveCommand,
  type TimeToLiveDescription,
} from "@aws-sdk/client-dynamodb";
import { TABLE_NAMES, TABLE_SCHEMAS, TableName } from "../lib/schema";

function fixture(context: TestContext, existing: string[] = TABLE_NAMES) {
  const client = new DynamoDBClient({
    endpoint: "http://127.0.0.1:1", region: "ru-central1", maxAttempts: 1,
    credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
  });
  context.after(() => client.destroy());
  const tableNames = new Set(existing);
  const ttl = new Map<string, TimeToLiveDescription>();
  const calls: Array<string> = [];
  const logs: string[] = [];
  const onUpdate: { call?: (command: UpdateTimeToLiveCommand) => unknown } = {};
  context.mock.method(client, "send", async (command: unknown) => {
    if (command instanceof ListTablesCommand) return { TableNames: [...tableNames] };
    if (command instanceof CreateTableCommand) {
      const name = command.input.TableName!;
      calls.push(`create:${name}`);
      assert.ok(!tableNames.has(name));
      tableNames.add(name);
      return {};
    }
    if (command instanceof DescribeTableCommand) {
      const name = command.input.TableName!;
      calls.push(`active:${name}`);
      assert.ok(tableNames.has(name));
      return { Table: { TableName: name, TableStatus: "ACTIVE" } };
    }
    if (command instanceof DescribeTimeToLiveCommand) {
      const name = command.input.TableName!;
      assert.ok(calls.includes(`active:${name}`));
      calls.push(`ttl:${name}`);
      return { TimeToLiveDescription: ttl.get(name) ?? { TimeToLiveStatus: "DISABLED" } };
    }
    if (command instanceof UpdateTimeToLiveCommand) {
      const name = command.input.TableName!;
      calls.push(`update:${name}`);
      assert.deepEqual(command.input.TimeToLiveSpecification, { AttributeName: "expiresAt", Enabled: true });
      if (onUpdate.call) return onUpdate.call(command);
      ttl.set(name, { TimeToLiveStatus: "ENABLING", AttributeName: "expiresAt" });
      return { TimeToLiveSpecification: command.input.TimeToLiveSpecification };
    }
    return assert.fail("Unexpected synthetic migration command");
  });
  return {
    calls, ttl, logs, onUpdate,
    async run() {
      const { migrate } = await import("./migrate");
      await migrate(client, line => logs.push(line));
    },
  };
}

test("TTL metadata marks sessions and rate counters only", () => {
  const usesTtl = TABLE_NAMES.filter(name => TABLE_SCHEMAS[name].ttlAttribute);
  assert.deepEqual(usesTtl, [TableName.ACCOUNT_SESSIONS, TableName.ACCOUNT_RATE_LIMITS]);
  for (const name of usesTtl) assert.equal(TABLE_SCHEMAS[name].ttlAttribute, "expiresAt");
});

test("migration sets TTL for a new table and an existing table exactly once", async context => {
  const db = fixture(context, TABLE_NAMES.filter(name => name !== TableName.ACCOUNT_SESSIONS));
  await db.run();
  assert.deepEqual(db.calls, [
    "create:account-sessions", "active:account-sessions", "ttl:account-sessions", "update:account-sessions",
    "active:account-rate-limits", "ttl:account-rate-limits", "update:account-rate-limits",
  ]);
  assert.ok(db.logs.some(line => line.includes("TTL") && line.includes("запрошено")));
  db.calls.length = 0;
  db.ttl.set(TableName.ACCOUNT_SESSIONS, { TimeToLiveStatus: "ENABLED", AttributeName: "expiresAt" });
  await db.run();
  assert.deepEqual(db.calls, [
    "active:account-sessions", "ttl:account-sessions", "active:account-rate-limits", "ttl:account-rate-limits",
  ]);
});

test("migration reports incompatible or ambiguous TTL instead of changing it", async context => {
  const db = fixture(context);
  for (const [description, expected] of [
    [{ TimeToLiveStatus: "ENABLED", AttributeName: "otherField" }, /account-sessions.*otherField.*expiresAt/u],
    [{ TimeToLiveStatus: "ENABLING" }, /account-sessions.*expiresAt/u],
    [{ TimeToLiveStatus: "DISABLING", AttributeName: "expiresAt" }, /account-sessions.*DISABLING/u],
    [{}, /account-sessions.*TTL/u],
  ] as const) {
    db.ttl.set(TableName.ACCOUNT_SESSIONS, description);
    await assert.rejects(db.run(), expected);
  }
  assert.ok(!db.calls.some(call => call.startsWith("update:")));
});

test("migration propagates unsupported TTL and rejects an unconfirmed enable receipt", async context => {
  const db = fixture(context);
  const unsupported = Object.assign(new Error("Synthetic TTL unsupported"), { name: "UnknownOperationException" });
  db.onUpdate.call = () => { throw unsupported; };
  await assert.rejects(db.run(), unsupported);
  db.onUpdate.call = () => ({ TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: false } });
  await assert.rejects(db.run(), /account-sessions.*TTL/u);
  assert.ok(!db.logs.some(line => line.includes("Миграции завершены")));
});
