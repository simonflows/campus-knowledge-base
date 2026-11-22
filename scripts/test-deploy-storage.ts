import assert from "node:assert/strict";
import test from "node:test";
import type { TableDescription } from "@aws-sdk/client-dynamodb";
import { checkDeployStorage, isRuntimeStorageReady } from "../lib/deploy-storage";
import { docClient } from "../lib/db";
import { TABLE_NAMES, TABLE_SCHEMAS, TableName } from "../lib/schema";

function readyTable(name: TableName): TableDescription {
  const { keySchema, attributeDefinitions } = TABLE_SCHEMAS[name];
  return {
    TableName: name,
    TableStatus: "ACTIVE",
    KeySchema: keySchema,
    AttributeDefinitions: attributeDefinitions,
  };
}

test("200 simultaneous readiness calls share one complete probe and sequential calls recheck storage", async () => {
  const globalState = globalThis as unknown as { _dbAvailable?: boolean | null; _dbAvailableCheckedAt?: number };
  const before = { available: globalState._dbAvailable, checkedAt: globalState._dbAvailableCheckedAt, endpoint: process.env.DOCUMENT_API_ENDPOINT, use: process.env.USE_DATABASE };
  const originalSend = docClient.send;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  let unavailable = false;
  let releaseFailure: (() => void) | undefined;
  const pending: Promise<boolean>[] = [];
  try {
    process.env.DOCUMENT_API_ENDPOINT = "http://127.0.0.1:8000";
    process.env.USE_DATABASE = "true";
    globalState._dbAvailable = true;
    globalState._dbAvailableCheckedAt = Date.now();
    docClient.send = (async (command: { input: { TableName: TableName } }, options: { abortSignal: AbortSignal }) => {
      calls++;
      assert.ok(TABLE_NAMES.includes(command.input.TableName));
      assert.deepEqual(command.input, { TableName: command.input.TableName, Key: { id: "__campus_readiness__" }, ProjectionExpression: "id", ConsistentRead: true });
      assert.ok(options.abortSignal instanceof AbortSignal);
      await gate;
      if (unavailable) throw new Error("synthetic unavailable");
      return {};
    }) as unknown as typeof docClient.send;
    pending.push(...Array.from({ length: 200 }, () => isRuntimeStorageReady()));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, TABLE_NAMES.length, "one read per table, not one full probe per caller");
    finish();
    assert.ok((await Promise.all(pending)).every(Boolean));
    assert.equal(await isRuntimeStorageReady(), true);
    assert.equal(calls, TABLE_NAMES.length * 2, "a completed success is not cached");
    unavailable = true;
    assert.equal(await isRuntimeStorageReady(), false);
    assert.equal(calls, TABLE_NAMES.length * 3);
    unavailable = false;
    assert.equal(await isRuntimeStorageReady(), true);
    assert.equal(calls, TABLE_NAMES.length * 4, "a completed failure is not cached");
    let failedBatchCalls = 0;
    const siblings = new Promise<void>(resolve => { releaseFailure = resolve; });
    docClient.send = (async () => {
      if (++failedBatchCalls === 1) throw new Error("synthetic missing table");
      await siblings;
      return {};
    }) as typeof docClient.send;
    let settled = false;
    const firstFailure = isRuntimeStorageReady().then(result => { settled = true; return result; });
    pending.push(firstFailure);
    await new Promise(resolve => setImmediate(resolve));
    const overlappingFailure = isRuntimeStorageReady();
    pending.push(overlappingFailure);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, "one failed read cannot release the flight while siblings remain active");
    assert.equal(failedBatchCalls, TABLE_NAMES.length);
    releaseFailure!();
    assert.deepEqual(await Promise.all([firstFailure, overlappingFailure]), [false, false]);
    let synchronousCalls = 0;
    let synchronousSettled = false;
    const synchronousSiblings = new Promise<void>(resolve => { releaseFailure = resolve; });
    docClient.send = (() => {
      if (++synchronousCalls === 4) throw new Error("synthetic synchronous middleware failure");
      return synchronousSiblings.then(() => ({}));
    }) as typeof docClient.send;
    const synchronousFailure = isRuntimeStorageReady().then(result => { synchronousSettled = true; return result; });
    pending.push(synchronousFailure);
    await new Promise(resolve => setImmediate(resolve));
    const synchronousOverlap = isRuntimeStorageReady();
    pending.push(synchronousOverlap);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(synchronousCalls, TABLE_NAMES.length);
    assert.equal(synchronousSettled, false, "a synchronous send error must wait for the other reads too");
    releaseFailure!();
    assert.deepEqual(await Promise.all([synchronousFailure, synchronousOverlap]), [false, false]);
  } finally {
    finish();
    releaseFailure?.();
    await Promise.allSettled(pending);
    docClient.send = originalSend;
    globalState._dbAvailable = before.available;
    globalState._dbAvailableCheckedAt = before.checkedAt;
    for (const [key, value] of [["DOCUMENT_API_ENDPOINT", before.endpoint], ["USE_DATABASE", before.use]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});

test("Readiness verifies every required table", async () => {
  const calls: TableName[] = [];
  const result = await checkDeployStorage(async (name) => {
    calls.push(name);
    return readyTable(name);
  });
  assert.deepEqual(calls, TABLE_NAMES);
  assert.deepEqual(result, []);
});

test("Readiness stops a release with absent, inactive or incompatible tables", async () => {
  const [missing, inactive, wrongKey, wrongType, unreachable] = TABLE_NAMES;
  const result = await checkDeployStorage(async (name) => {
    if (name === missing) {
      throw Object.assign(new Error("sensitive details excluded"), {
        name: "ResourceNotFoundException",
      });
    }
    if (name === unreachable) throw new Error("sensitive details excluded");
    const table = readyTable(name);
    if (name === inactive) table.TableStatus = "CREATING";
    if (name === wrongKey)
      table.KeySchema = [{ AttributeName: "foreign", KeyType: "HASH" }];
    if (name === wrongType)
      table.AttributeDefinitions = [
        { AttributeName: "id", AttributeType: "N" },
      ];
    return table;
  });
  assert.deepEqual(result, [
    { table: missing, problem: "missing" },
    { table: inactive, problem: "inactive" },
    { table: wrongKey, problem: "key-schema" },
    { table: wrongType, problem: "key-schema" },
    { table: unreachable, problem: "unavailable" },
  ]);
});
