import assert from "node:assert/strict";
import test from "node:test";
import type { TableDescription } from "@aws-sdk/client-dynamodb";
import { checkDeployStorage } from "../lib/deploy-storage";
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
