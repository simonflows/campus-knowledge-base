import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  DynamoDBClient,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import {
  createQaRelayScope,
  readQaRelayBody,
  relayDynamoRequest,
} from "../deploy/qa-ydb-relay.mjs";
import * as schema from "../lib/schema.ts";

const prefix = "qa095-relay-isolation-";
const env = {
  CAMPUS_RELEASE_STORAGE_TEST: "yes",
  CAMPUS_RELEASE_QA_PREFIX: prefix,
};
const scope = createQaRelayScope(env);
const target = (operation) => "DynamoDB_20120810." + operation;
const key = { id: { S: "synthetic" } };
const { TABLE_NAMES } = schema.default ?? schema;

test("an explicit mode and valid isolated prefix are required", () => {
  assert.throws(() =>
    createQaRelayScope({ ...env, CAMPUS_RELEASE_STORAGE_TEST: "no" })
  );
  assert.throws(() =>
    createQaRelayScope({ ...env, CAMPUS_RELEASE_QA_PREFIX: "knowledge-cards" })
  );
  assert.throws(() =>
    createQaRelayScope({ ...env, CAMPUS_RELEASE_QA_PREFIX: "qa095-too-" })
  );
});

test("ListTables lists the eight original aliases and performs no backend calls", async () => {
  const fail = () => assert.fail("ListTables must stay on the frontend");
  const result = await relayDynamoRequest(
    scope,
    target("ListTables"),
    {},
    fail
  );
  const aliases = [...TABLE_NAMES].sort();
  assert.equal(result.status, 200);
  assert.equal(aliases.length, 8);
  assert.deepEqual(result.body.TableNames, aliases);
  for (const name of aliases) {
    assert.equal(scope.qualify(name), prefix + name);
    assert.equal(scope.original(prefix + name), name);
  }
  const first = await relayDynamoRequest(
    scope,
    target("ListTables"),
    { Limit: 1 },
    fail
  );
  assert.deepEqual(first.body, {
    TableNames: [aliases[0]],
    LastEvaluatedTableName: aliases[0],
  });
});

test("DescribeTable prefixes the backend and projects a frontend-only table description", async () => {
  const result = await relayDynamoRequest(
    scope,
    target("DescribeTable"),
    { TableName: "knowledge-cards" },
    async (operation, input) => {
      assert.equal(operation, "DescribeTable");
      assert.deepEqual(input, { TableName: prefix + "knowledge-cards" });
      return {
        Table: {
          TableName: input.TableName,
          TableArn:
            "arn:aws:dynamodb:ru-central1:private:table/" + input.TableName,
          TableId: "backend-private-id",
          TableStatus: "ACTIVE",
          KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
          AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
        },
      };
    }
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.Table.TableName, "knowledge-cards");
  assert.match(result.body.Table.TableArn, /:table\/knowledge-cards$/);
  assert.doesNotMatch(JSON.stringify(result.body), /qa095-|private/);
});

test("unscoped and malformed nested operations are refused before transport", async () => {
  const fail = () => assert.fail("Invalid request reached the backend");
  for (const [operation, input] of [
    ["GetItem", { TableName: prefix + "knowledge-cards", Key: key }],
    ["DescribeTable", { TableName: "unknown-table" }],
    ["DescribeTable", { TableName: "articles" }],
    ["GetItem", { TableName: "knowledge-cards", Key: {} }],
    [
      "GetItem",
      { TableName: "knowledge-cards", Key: { other: { S: "invalid key" } } },
    ],
    [
      "UpdateItem",
      {
        TableName: "knowledge-articles",
        Key: key,
        UpdateExpression: "SET title = :value",
        ExpressionAttributeValues: { value: { S: "invalid alias" } },
      },
    ],
    ["Scan", { TableName: "knowledge-articles", Segment: 1 }],
    [
      "BatchGetItem",
      {
        RequestItems: {
          "knowledge-articles": { Keys: [key] },
          unknown: { Keys: [key] },
        },
      },
    ],
    [
      "BatchWriteItem",
      {
        RequestItems: {
          "knowledge-articles": [
            { PutRequest: { Item: key }, DeleteRequest: { Key: key } },
          ],
        },
      },
    ],
    [
      "BatchWriteItem",
      {
        RequestItems: {
          "knowledge-articles": [{ DeleteRequest: { Key: {} } }],
        },
      },
    ],
    [
      "TransactWriteItems",
      {
        TransactItems: [
          {
            Put: { TableName: "knowledge-articles", Item: key },
            Delete: { TableName: "knowledge-articles", Key: key },
          },
        ],
      },
    ],
    [
      "TransactWriteItems",
      {
        TransactItems: [
          { Put: { TableName: "knowledge-articles", Item: key } },
          { Delete: { TableName: "unknown", Key: key } },
        ],
      },
    ],
    [
      "TransactGetItems",
      {
        TransactItems: [
          { Get: { TableName: "knowledge-articles", Key: key } },
          { Get: { TableName: "unknown", Key: key } },
        ],
      },
    ],
    ["DeleteTable", { TableName: "knowledge-articles" }],
    ["ExecuteStatement", { Statement: "unsupported" }],
  ]) {
    const result = await relayDynamoRequest(
      scope,
      target(operation),
      input,
      fail
    );
    assert.equal(result.status, 400, operation);
    assert.match(result.body.__type, /#ValidationException$/);
  }
});

test("Batch requests map only table selectors and map retry results back to aliases", async () => {
  const value = {
    ...key,
    TableName: { S: "content, not a selector" },
    bytes: { B: "AQI=" },
  };
  const get = await relayDynamoRequest(
    scope,
    target("BatchGetItem"),
    {
      RequestItems: {
        "knowledge-articles": { Keys: [key], ConsistentRead: true },
      },
    },
    async (operation, input, signal) => {
      assert.equal(operation, "BatchGetItem");
      assert.ok(signal instanceof AbortSignal);
      assert.deepEqual(input, {
        RequestItems: {
          [prefix + "knowledge-articles"]: {
            Keys: [key],
            ConsistentRead: true,
          },
        },
      });
      return {
        Responses: {
          [prefix + "knowledge-articles"]: [
            { ...value, bytes: { B: new Uint8Array([1, 2]) } },
          ],
        },
        UnprocessedKeys: input.RequestItems,
        $metadata: { requestId: "backend-private-id" },
      };
    }
  );
  assert.deepEqual(get.body, {
    Responses: { "knowledge-articles": [value] },
    UnprocessedKeys: {
      "knowledge-articles": { Keys: [key], ConsistentRead: true },
    },
  });

  const write = await relayDynamoRequest(
    scope,
    target("BatchWriteItem"),
    {
      RequestItems: {
        "knowledge-articles": [{ PutRequest: { Item: value } }],
        "knowledge-cards": [{ DeleteRequest: { Key: key } }],
      },
    },
    async (operation, input) => {
      assert.equal(operation, "BatchWriteItem");
      assert.deepEqual(
        input.RequestItems[prefix + "knowledge-articles"][0].PutRequest.Item,
        {
          ...value,
          bytes: { B: Buffer.from([1, 2]) },
        }
      );
      return {
        UnprocessedItems: {
          [prefix + "knowledge-cards"]:
            input.RequestItems[prefix + "knowledge-cards"],
        },
      };
    }
  );
  assert.deepEqual(write.body, {
    UnprocessedItems: { "knowledge-cards": [{ DeleteRequest: { Key: key } }] },
  });
});

test("transaction guards and parameters survive qualified table mapping", async () => {
  const change = {
    TableName: "knowledge-cards",
    Key: key,
    UpdateExpression: "SET #title = :title",
    ConditionExpression: "attribute_exists(id)",
    ExpressionAttributeNames: { "#title": "title" },
    ExpressionAttributeValues: { ":title": { S: "Synthetic" } },
  };
  const write = await relayDynamoRequest(
    scope,
    target("TransactWriteItems"),
    {
      TransactItems: [
        { Update: change },
        { Put: { TableName: "knowledge-card-versions", Item: key } },
      ],
      ClientRequestToken: "synthetic-transaction",
    },
    async (operation, input) => {
      assert.equal(operation, "TransactWriteItems");
      assert.equal(input.ClientRequestToken, "synthetic-transaction");
      assert.deepEqual(input.TransactItems, [
        { Update: { ...change, TableName: prefix + "knowledge-cards" } },
        { Put: { TableName: prefix + "knowledge-card-versions", Item: key } },
      ]);
      return {};
    }
  );
  assert.equal(write.status, 200);
  const read = await relayDynamoRequest(
    scope,
    target("TransactGetItems"),
    {
      TransactItems: [
        { Get: { TableName: "knowledge-card-versions", Key: key } },
      ],
    },
    async (operation, input) => {
      assert.equal(operation, "TransactGetItems");
      assert.deepEqual(input.TransactItems, [
        { Get: { TableName: prefix + "knowledge-card-versions", Key: key } },
      ]);
      return { Responses: [{ Item: key }] };
    }
  );
  assert.deepEqual(read.body, { Responses: [{ Item: key }] });
});

test("only machine-readable cancellation codes pass through backend errors", async () => {
  const result = await relayDynamoRequest(
    scope,
    target("TransactWriteItems"),
    {
      TransactItems: [{ Put: { TableName: "knowledge-articles", Item: key } }],
    },
    async () => {
      throw Object.assign(new Error("backend-private-message"), {
        name: "TransactionCanceledException",
        CancellationReasons: [
          {
            Code: "ConditionalCheckFailed",
            Item: { private: { S: "backend-private-record" } },
            Message: "backend-private-message",
          },
          {
            Code: "unexpected-provider-value",
            Message: "backend-private-message",
          },
        ],
      });
    }
  );
  assert.equal(result.status, 400);
  assert.match(result.body.__type, /#TransactionCanceledException$/);
  assert.deepEqual(result.body.CancellationReasons, [
    { Code: "ConditionalCheckFailed" },
    { Code: "ValidationError" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(result.body),
    /backend-private|unexpected-provider-value/
  );
});

test("body parsing imposes a 1 MiB bound on declared and streamed payload sizes", async () => {
  const stream = (parts, headers = {}) =>
    Object.assign(Readable.from(parts), { headers });
  assert.deepEqual(
    await readQaRelayBody(stream([Buffer.from('{"ready":true}')])),
    { ready: true }
  );
  assert.throws(
    () => readQaRelayBody(stream([], { "content-length": "1048577" })),
    { status: 413 }
  );
  await assert.rejects(
    readQaRelayBody(stream([Buffer.alloc(1024 * 1024), Buffer.from("x")])),
    { status: 413 }
  );
  await assert.rejects(readQaRelayBody(stream([Buffer.from([0xff])])), {
    name: "ValidationException",
  });
});

test("the actual DynamoDB SDK accepts the relay's transaction error on its JSON wire protocol", async () => {
  const client = new DynamoDBClient({
    endpoint: "https://qa-relay.invalid:8443",
    region: "ru-central1",
    credentials: {
      accessKeyId: "campusLocalTest",
      secretAccessKey: "localTestOnly",
    },
    maxAttempts: 1,
    requestHandler: {
      async handle(request) {
        assert.equal(request.method, "POST");
        assert.equal(request.path, "/");
        assert.equal(
          request.headers["content-type"],
          "application/x-amz-json-1.0"
        );
        assert.match(
          request.headers.authorization,
          /^AWS4-HMAC-SHA256 Credential=campusLocalTest\//
        );
        const result = await relayDynamoRequest(
          scope,
          request.headers["x-amz-target"],
          JSON.parse(request.body),
          async (operation, input) => {
            assert.equal(operation, "TransactWriteItems");
            assert.equal(
              input.TransactItems[0].Put.TableName,
              prefix + "knowledge-articles"
            );
            throw Object.assign(new Error("private backend text"), {
              name: "TransactionCanceledException",
              CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
            });
          }
        );
        return {
          response: {
            statusCode: result.status,
            headers: { "content-type": "application/x-amz-json-1.0" },
            body: Readable.from([Buffer.from(JSON.stringify(result.body))]),
          },
        };
      },
      destroy() {},
    },
  });
  try {
    await assert.rejects(
      client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            { Put: { TableName: "knowledge-articles", Item: key } },
          ],
        })
      ),
      {
        name: "TransactionCanceledException",
        message: "QA storage request failed",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
      }
    );
  } finally {
    client.destroy();
  }
});
