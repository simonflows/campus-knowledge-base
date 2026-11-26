// QA only. Attach to a private Docker network and do not publish port 8443.
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tables = Object.freeze([
  "account-identities",
  "account-rate-limits",
  "account-sessions",
  "editorial-documents",
  "editorial-revisions",
  "information-requests",
  "knowledge-articles",
  "knowledge-card-types",
  "knowledge-card-versions",
  "knowledge-cards",
  "workflow-records",
]);
const tableNames = new Set(tables);
const bodyLimit = 1024 * 1024;
const timeout = 15_000;
const service = "DynamoDB_20120810.";
const fieldList = (text) => text.split(" ");
const expression = "ExpressionAttributeNames ExpressionAttributeValues";
const conditional = `ConditionExpression ${expression} ReturnValuesOnConditionCheckFailure`;
const capacity = "ReturnConsumedCapacity";
const writeResult = `${capacity} ReturnValues ReturnItemCollectionMetrics`;
const selection =
  "ConsistentRead ProjectionExpression ExpressionAttributeNames AttributesToGet";
const scan = `${selection} ExpressionAttributeValues Limit IndexName ExclusiveStartKey FilterExpression Select`;
const specifications = {
  DescribeTable: "TableName",
  GetItem: `TableName Key ${selection} ${capacity}`,
  Scan: `TableName ${scan} ${capacity} Segment TotalSegments`,
  Query: `TableName ${scan} ${capacity} KeyConditionExpression ScanIndexForward`,
  PutItem: `TableName Item ${conditional} ${writeResult}`,
  UpdateItem: `TableName Key UpdateExpression ${conditional} ${writeResult}`,
  DeleteItem: `TableName Key ${conditional} ${writeResult}`,
};
const required = {
  DescribeTable: [],
  GetItem: ["Key"],
  Scan: [],
  Query: ["KeyConditionExpression"],
  PutItem: ["Item"],
  UpdateItem: ["Key", "UpdateExpression"],
  DeleteItem: ["Key"],
};
const batch = new Set(["BatchGetItem", "BatchWriteItem"]);
const transactions = new Set(["TransactGetItems", "TransactWriteItems"]);
const commandNames = new Set([
  ...Object.keys(specifications),
  ...batch,
  ...transactions,
]);

class RelayError extends Error {
  constructor(code = "ValidationException", status = 400) {
    super("QA storage request rejected");
    this.name = code;
    this.status = status;
  }
}

function requireValid(condition) {
  if (!condition) throw new RelayError();
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value, accepted, mandatory = []) {
  requireValid(object(value));
  const allowed = fieldList(accepted);
  requireValid(Object.keys(value).every((name) => allowed.includes(name)));
  requireValid(mandatory.every((name) => Object.hasOwn(value, name)));
  return value;
}

function array(value, min, max) {
  requireValid(
    Array.isArray(value) && value.length >= min && value.length <= max
  );
  return value;
}

function binary(value) {
  requireValid(typeof value === "string");
  const buffer = Buffer.from(value, "base64");
  requireValid(buffer.toString("base64") === value);
  return buffer;
}

function numberText(value) {
  requireValid(
    typeof value === "string" &&
      /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(value)
  );
  return value;
}

function attributes(value, depth = 0) {
  requireValid(object(value) && depth <= 32);
  return Object.fromEntries(
    Object.entries(value).map(([key, attribute]) => {
      requireValid(
        key.length > 0 &&
          object(attribute) &&
          Object.keys(attribute).length === 1
      );
      const [[type, data]] = Object.entries(attribute);
      let normalized;
      switch (type) {
        case "S":
          requireValid(typeof data === "string");
          normalized = data;
          break;
        case "N":
          normalized = numberText(data);
          break;
        case "B":
          normalized = binary(data);
          break;
        case "BOOL":
          requireValid(typeof data === "boolean");
          normalized = data;
          break;
        case "NULL":
          requireValid(data === true);
          normalized = true;
          break;
        case "M":
          normalized = attributes(data, depth + 1);
          break;
        case "L":
          normalized = array(data, 0, bodyLimit).map(
            (item) => attributes({ item }, depth + 1).item
          );
          break;
        case "SS":
          normalized = array(data, 1, bodyLimit);
          requireValid(normalized.every((item) => typeof item === "string"));
          break;
        case "NS":
          normalized = array(data, 1, bodyLimit).map(numberText);
          break;
        case "BS":
          normalized = array(data, 1, bodyLimit).map(binary);
          break;
        default:
          throw new RelayError();
      }
      return [key, { [type]: normalized }];
    })
  );
}

const booleans = new Set(["ConsistentRead", "ScanIndexForward"]);
const integers = new Set(["Limit", "Segment", "TotalSegments"]);
const attributeMaps = new Set([
  "Key",
  "Item",
  "ExclusiveStartKey",
  "ExpressionAttributeValues",
]);
const enums = {
  Select: [
    "ALL_ATTRIBUTES",
    "ALL_PROJECTED_ATTRIBUTES",
    "SPECIFIC_ATTRIBUTES",
    "COUNT",
  ],
  ReturnConsumedCapacity: ["INDEXES", "TOTAL", "NONE"],
  ReturnItemCollectionMetrics: ["SIZE", "NONE"],
  ReturnValues: ["NONE", "ALL_OLD", "UPDATED_OLD", "ALL_NEW", "UPDATED_NEW"],
  ReturnValuesOnConditionCheckFailure: ["NONE", "ALL_OLD"],
};

function normalize(input) {
  return Object.fromEntries(
    Object.entries(input).map(([name, value]) => {
      if (attributeMaps.has(name)) {
        const normalized = attributes(value);
        requireValid(Object.keys(normalized).length > 0);
        if (["Key", "Item", "ExclusiveStartKey"].includes(name)) {
          requireValid(
            typeof normalized.id?.S === "string" &&
              Buffer.byteLength(normalized.id.S, "utf8") > 0 &&
              Buffer.byteLength(normalized.id.S, "utf8") <= 2048
          );
          if (name !== "Item")
            requireValid(Object.keys(normalized).length === 1);
        } else {
          requireValid(
            Object.keys(normalized).every((key) => /^:[A-Za-z0-9_]+$/.test(key))
          );
        }
        return [name, normalized];
      }
      if (name === "ExpressionAttributeNames") {
        requireValid(
          object(value) &&
            Object.keys(value).length > 0 &&
            Object.entries(value).every(
              ([key, item]) =>
                /^#[A-Za-z0-9_]+$/.test(key) &&
                typeof item === "string" &&
                item.length
            )
        );
      } else if (name === "AttributesToGet") {
        requireValid(
          array(value, 1, bodyLimit).every(
            (item) => typeof item === "string" && item.length
          )
        );
      } else if (booleans.has(name)) {
        requireValid(typeof value === "boolean");
      } else if (integers.has(name)) {
        requireValid(
          Number.isInteger(value) &&
            value >= (name === "Segment" ? 0 : 1) &&
            value <= 2147483647
        );
      } else if (Object.hasOwn(enums, name)) {
        requireValid(enums[name].includes(value));
      } else if (name === "ClientRequestToken") {
        requireValid(
          typeof value === "string" && value.length > 0 && value.length <= 36
        );
      } else {
        requireValid(typeof value === "string" && value.length > 0);
      }
      return [name, value];
    })
  );
}

export function createQaRelayScope(env = process.env) {
  const prefix = env.CAMPUS_RELEASE_QA_PREFIX;
  requireValid(
    env.CAMPUS_RELEASE_STORAGE_TEST === "yes" &&
      typeof prefix === "string" &&
      /^qa095-[a-z0-9-]{8,45}-$/.test(prefix)
  );
  return Object.freeze({
    qualify(name) {
      requireValid(tableNames.has(name));
      return prefix + name;
    },
    original(name) {
      requireValid(typeof name === "string" && name.startsWith(prefix));
      const alias = name.slice(prefix.length);
      requireValid(tableNames.has(alias));
      return alias;
    },
  });
}

function tableInput(scope, value, accepted, mandatory) {
  const input = fields(value, accepted, ["TableName", ...mandatory]);
  return { ...normalize(input), TableName: scope.qualify(input.TableName) };
}

function oneAction(item, names) {
  requireValid(object(item));
  const keys = Object.keys(item);
  requireValid(keys.length === 1 && names.includes(keys[0]));
  return keys[0];
}

function translate(scope, operation, value) {
  if (Object.hasOwn(specifications, operation)) {
    const input = tableInput(
      scope,
      value,
      specifications[operation],
      required[operation]
    );
    if (
      operation === "Scan" &&
      (input.Segment !== undefined || input.TotalSegments !== undefined)
    ) {
      requireValid(
        input.Segment !== undefined &&
          input.TotalSegments !== undefined &&
          input.Segment < input.TotalSegments
      );
    }
    return input;
  }
  if (batch.has(operation)) {
    const writing = operation === "BatchWriteItem";
    const { RequestItems, ...options } = fields(
      value,
      writing
        ? `RequestItems ${capacity} ReturnItemCollectionMetrics`
        : `RequestItems ${capacity}`,
      ["RequestItems"]
    );
    requireValid(object(RequestItems) && Object.keys(RequestItems).length > 0);
    let size = 0;
    const entries = Object.entries(RequestItems).map(([name, items]) => {
      const scoped = scope.qualify(name);
      if (writing) {
        const writes = array(items, 1, 25);
        size += writes.length;
        return [
          scoped,
          writes.map((item) => {
            const action = oneAction(item, ["PutRequest", "DeleteRequest"]);
            const field = action === "PutRequest" ? "Item" : "Key";
            return {
              [action]: normalize(fields(item[action], field, [field])),
            };
          }),
        ];
      }
      const { Keys, ...opts } = fields(items, `Keys ${selection}`, ["Keys"]);
      const keys = array(Keys, 1, 100);
      size += keys.length;
      return [
        scoped,
        { ...normalize(opts), Keys: keys.map((Key) => normalize({ Key }).Key) },
      ];
    });
    requireValid(size <= (writing ? 25 : 100));
    return { ...normalize(options), RequestItems: Object.fromEntries(entries) };
  }
  if (transactions.has(operation)) {
    const writing = operation === "TransactWriteItems";
    const { TransactItems, ...options } = fields(
      value,
      writing
        ? `TransactItems ${capacity} ReturnItemCollectionMetrics ClientRequestToken`
        : `TransactItems ${capacity}`,
      ["TransactItems"]
    );
    const actions = {
      Get: [
        "TableName Key ProjectionExpression ExpressionAttributeNames",
        ["Key"],
      ],
      Put: [`TableName Item ${conditional}`, ["Item"]],
      Update: [
        `TableName Key UpdateExpression ${conditional}`,
        ["Key", "UpdateExpression"],
      ],
      Delete: [`TableName Key ${conditional}`, ["Key"]],
      ConditionCheck: [
        `TableName Key ${conditional}`,
        ["Key", "ConditionExpression"],
      ],
    };
    return {
      ...normalize(options),
      TransactItems: array(TransactItems, 1, 25).map((item) => {
        const action = oneAction(
          item,
          writing ? ["Put", "Update", "Delete", "ConditionCheck"] : ["Get"]
        );
        const [accepted, mandatory] = actions[action];
        return {
          [action]: tableInput(scope, item[action], accepted, mandatory),
        };
      }),
    };
  }
  throw new RelayError();
}

function listTables(scope, input) {
  fields(input, "ExclusiveStartTableName Limit");
  const start = Object.hasOwn(input, "ExclusiveStartTableName")
    ? tables.indexOf(input.ExclusiveStartTableName)
    : -1;
  if (Object.hasOwn(input, "ExclusiveStartTableName"))
    scope.qualify(input.ExclusiveStartTableName);
  const limit = Object.hasOwn(input, "Limit") ? input.Limit : 100;
  requireValid(Number.isInteger(limit) && limit >= 1 && limit <= 100);
  const TableNames = tables.slice(start + 1, start + 1 + limit);
  return {
    TableNames,
    ...(start + 1 + limit < tables.length && {
      LastEvaluatedTableName: TableNames.at(-1),
    }),
  };
}

function jsonWire(value) {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(jsonWire);
  if (object(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, jsonWire(child)])
    );
  return value;
}

function projectResponse(scope, operation, input, result) {
  if (operation === "DescribeTable") {
    const { TableStatus, KeySchema, AttributeDefinitions, TableName } =
      result.Table;
    if (TableName !== input.TableName)
      throw new RelayError("InternalServerError", 502);
    const alias = scope.original(TableName);
    return {
      Table: {
        TableName: alias,
        TableArn: "arn:aws:dynamodb:qa:000000000000:table/" + alias,
        TableStatus,
        KeySchema,
        AttributeDefinitions,
      },
    };
  }
  const output = {};
  for (const name of [
    "Item",
    "Items",
    "Attributes",
    "Count",
    "ScannedCount",
    "LastEvaluatedKey",
  ]) {
    if (result[name] !== undefined) output[name] = result[name];
  }
  const aliases = (value) =>
    Object.fromEntries(
      Object.entries(value).map(([name, data]) => [scope.original(name), data])
    );
  if (result.Responses !== undefined) {
    output.Responses =
      operation === "BatchGetItem"
        ? aliases(result.Responses)
        : result.Responses;
  }
  for (const name of ["UnprocessedKeys", "UnprocessedItems"]) {
    if (result[name] !== undefined) output[name] = aliases(result[name]);
  }
  // Capacity and collection metrics are unnecessary for app QA and may contain
  // physical names. Raw SDK metadata and request identifiers stay at the relay.
  return jsonWire(output);
}

const backendErrors = new Set([
  "ResourceNotFoundException",
  "ValidationException",
  "ConditionalCheckFailedException",
  "TransactionCanceledException",
  "TransactionConflictException",
  "TransactionInProgressException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "ThrottlingException",
  "IdempotentParameterMismatchException",
  "ItemCollectionSizeLimitExceededException",
  "AccessDeniedException",
  "UnrecognizedClientException",
]);
const cancellationCodes = new Set([
  "None",
  "ConditionalCheckFailed",
  "ItemCollectionSizeLimitExceeded",
  "TransactionConflict",
  "ProvisionedThroughputExceeded",
  "ThrottlingError",
  "ValidationError",
]);

function errorResponse(error) {
  const safe = error instanceof RelayError || backendErrors.has(error?.name);
  const name = safe ? error.name : "InternalServerError";
  return {
    status: error instanceof RelayError ? error.status : safe ? 400 : 502,
    body: {
      __type: "com.amazonaws.dynamodb.v20120810#" + name,
      message: "QA storage request failed",
      ...(name === "TransactionCanceledException" &&
        Array.isArray(error.CancellationReasons) && {
          CancellationReasons: error.CancellationReasons.slice(0, 25).map(
            (reason) => ({
              Code: cancellationCodes.has(reason?.Code)
                ? reason.Code
                : "ValidationError",
            })
          ),
        }),
    },
  };
}

export async function relayDynamoRequest(scope, target, value, send) {
  try {
    requireValid(typeof target === "string" && target.startsWith(service));
    const operation = target.slice(service.length);
    if (operation === "ListTables")
      return { status: 200, body: listTables(scope, value) };
    requireValid(commandNames.has(operation));
    const input = translate(scope, operation, value);
    const result = await send(operation, input, AbortSignal.timeout(timeout));
    return {
      status: 200,
      body: projectResponse(scope, operation, input, result),
    };
  } catch (error) {
    return errorResponse(error);
  }
}

export function readQaRelayBody(request) {
  const length = request.headers["content-length"];
  if (length !== undefined) {
    requireValid(typeof length === "string" && /^\d+$/.test(length));
    if (Number(length) > bodyLimit)
      throw new RelayError("ValidationException", 413);
  }
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(
      () => fail(new RelayError("ValidationException", 408)),
      timeout
    );
    function cleanup() {
      clearTimeout(timer);
      request.removeListener("data", data);
      request.removeListener("end", end);
      request.removeListener("aborted", fail);
      request.removeListener("error", fail);
    }
    function fail(error) {
      cleanup();
      request.pause();
      reject(error);
    }
    function data(chunk) {
      size += chunk.length;
      if (size > bodyLimit) fail(new RelayError("ValidationException", 413));
      else chunks.push(chunk);
    }
    function end() {
      cleanup();
      try {
        resolveBody(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks)
            )
          )
        );
      } catch {
        reject(new RelayError());
      }
    }
    request
      .on("data", data)
      .once("end", end)
      .once("aborted", fail)
      .once("error", fail);
  });
}

function start(env) {
  const scope = createQaRelayScope(env);
  const endpoint = new URL(env.DOCUMENT_API_ENDPOINT ?? "");
  requireValid(
    endpoint.protocol === "https:" &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.hash
  );
  requireValid(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
  // A bind-mounted script can live outside /app. Resolve the installed SDK from
  // the image's working directory without copying any backend settings.
  const require = createRequire(resolve(process.cwd(), "package.json"));
  const sdk = require("@aws-sdk/client-dynamodb");
  const backend = new sdk.DynamoDBClient({
    endpoint: endpoint.href,
    region: env.DOCUMENT_API_REGION ?? "ru-central1",
    maxAttempts: 1,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
  const send = (operation, input, abortSignal) =>
    backend.send(new sdk[operation + "Command"](input), { abortSignal });

  const key = readFileSync(env.CAMPUS_QA_TLS_KEY_PATH ?? "/run/qa-tls.key");
  const cert = readFileSync(env.CAMPUS_QA_TLS_CERT_PATH ?? "/run/qa-tls.crt");
  const server = createServer(
    {
      key,
      cert,
      minVersion: "TLSv1.2",
      requestTimeout: timeout,
      headersTimeout: 5_000,
      keepAliveTimeout: 2_000,
      maxHeaderSize: 16_384,
    },
    async (request, response) => {
      request.on("error", () => {});
      let result;
      try {
        requireValid(request.method === "POST" && request.url === "/");
        requireValid(
          !request.headers["content-encoding"] ||
            request.headers["content-encoding"] === "identity"
        );
        requireValid(
          request.headers["content-type"]?.split(";")[0] ===
            "application/x-amz-json-1.0"
        );
        // This is a synthetic credential identifier check, not an authentication
        // boundary. The private QA network and exact table map bound access.
        if (
          !request.headers.authorization?.startsWith(
            "AWS4-HMAC-SHA256 Credential=campusLocalTest/"
          ) ||
          request.headers["x-amz-security-token"]
        ) {
          throw new RelayError("UnrecognizedClientException");
        }
        result = await relayDynamoRequest(
          scope,
          request.headers["x-amz-target"],
          await readQaRelayBody(request),
          send
        );
      } catch (error) {
        result = errorResponse(error);
      }
      if (response.destroyed) return;
      if (result.status !== 200) response.setHeader("Connection", "close");
      response.writeHead(result.status, {
        "Content-Type": "application/x-amz-json-1.0",
      });
      response.end(JSON.stringify(result.body));
    }
  );
  server.on("error", () => {
    backend.destroy();
    console.error("QA relay failed");
    process.exitCode = 1;
  });
  server.on("close", () => backend.destroy());
  server.listen(8443, "0.0.0.0");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    start(process.env);
  } catch {
    console.error("QA relay configuration rejected");
    process.exitCode = 1;
  }
}
