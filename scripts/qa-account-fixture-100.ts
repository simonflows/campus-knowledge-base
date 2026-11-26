import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CreateTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import { TABLE_NAMES, TABLE_SCHEMAS, type TableName } from "../lib/schema";

const service = "DynamoDB_20120810.";
const restorePattern = /^(qa095-account100-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-)([a-z-]+)$/u;
const known = (name: unknown): name is TableName => typeof name === "string" && TABLE_NAMES.some(table => table === name);

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error("Fixture request rejected");
}

function record(input: unknown): Record<string, unknown> {
  requireValid(input && typeof input === "object" && !Array.isArray(input));
  return input as Record<string, unknown>;
}

function exact(input: Record<string, unknown>, fields: string[]) {
  requireValid(Object.keys(input).every(name => fields.includes(name)));
}

// This loopback-only fixture never forwards a caller's physical table name.
async function main() {
  const prefix = process.env.CAMPUS_ACCOUNT_FIXTURE_PREFIX;
  requireValid(prefix && /^qa095-account100-[a-f0-9]{16}-$/u.test(prefix));
  requireValid(process.env.CAMPUS_RELEASE_STORAGE_TEST === "yes");
  const endpoint = new URL(process.env.DOCUMENT_API_ENDPOINT ?? "");
  requireValid(endpoint.origin === "https://docapi.serverless.yandexcloud.net" &&
    !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  requireValid(accessKeyId && secretAccessKey);

  const { readQaRelayBody, relayDynamoRequest } = await import(pathToFileURL(resolve("deploy/qa-ydb-relay.mjs")).href);
  const sdk = await import("@aws-sdk/client-dynamodb");
  const backend = new DynamoDBClient({
    endpoint: endpoint.href, region: process.env.DOCUMENT_API_REGION ?? "ru-central1", maxAttempts: 1,
    credentials: { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN },
  });
  const created = new Set<string>();
  let restorePrefix: string | undefined;
  const baseName = (alias: unknown): TableName => {
    if (known(alias)) return alias;
    const parsed = typeof alias === "string" ? restorePattern.exec(alias) : null;
    requireValid(parsed && known(parsed[2]) && (!restorePrefix || parsed[1] === restorePrefix));
    restorePrefix ??= parsed[1];
    return parsed[2];
  };
  const scope = Object.freeze({
    qualify(alias: unknown) {
      baseName(alias);
      return prefix + alias;
    },
    original(name: unknown) {
      requireValid(typeof name === "string" && name.startsWith(prefix));
      const alias = name.slice(prefix.length);
      baseName(alias);
      return alias;
    },
  });
  const send = (operation: string, input: never, abortSignal: AbortSignal) => {
    const command = sdk[`${operation}Command` as keyof typeof sdk];
    requireValid(typeof command === "function");
    // Operation and input are validated by the shared relay before dispatch.
    const Command = command as typeof CreateTableCommand;
    return backend.send(new Command(input), { abortSignal });
  };

  async function handle(target: string, body: unknown) {
    requireValid(target.startsWith(service));
    const action = target.slice(service.length);
    const input = record(body);
    if (action === "ListTables") {
      exact(input, ["Limit", "ExclusiveStartTableName"]);
      const limit = input.Limit ?? 100;
      requireValid(typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= 100);
      const names = [...created].sort();
      const after = input.ExclusiveStartTableName;
      requireValid(after === undefined || (typeof after === "string" && created.has(after)));
      const start = typeof after === "string" ? names.indexOf(after) + 1 : 0;
      const slice = names.slice(start, start + limit);
      return { status: 200, body: { TableNames: slice,
        ...(start + slice.length < names.length ? { LastEvaluatedTableName: slice.at(-1) } : {}),
      } };
    }

    const options = { abortSignal: AbortSignal.timeout(15_000) };
    if (action === "CreateTable") {
      exact(input, ["TableName", "KeySchema", "AttributeDefinitions", "BillingMode"]);
      const schema = TABLE_SCHEMAS[baseName(input.TableName)];
      const TableName = scope.qualify(input.TableName);
      requireValid(typeof input.TableName === "string" && !created.has(input.TableName) && created.size < TABLE_NAMES.length * 2);
      requireValid(input.BillingMode === "PAY_PER_REQUEST" &&
        JSON.stringify(input.KeySchema) === JSON.stringify(schema.keySchema) &&
        JSON.stringify(input.AttributeDefinitions) === JSON.stringify(schema.attributeDefinitions));
      await backend.send(new CreateTableCommand({ TableName, KeySchema: schema.keySchema,
        AttributeDefinitions: schema.attributeDefinitions, BillingMode: "PAY_PER_REQUEST" }), options);
      created.add(input.TableName);
      return { status: 200, body: {} };
    }
    if (action === "DescribeTimeToLive") {
      exact(input, ["TableName"]);
      const { TimeToLiveDescription } = await backend.send(new DescribeTimeToLiveCommand({ TableName: scope.qualify(input.TableName) }), options);
      return { status: 200, body: { TimeToLiveDescription } };
    }
    if (action === "UpdateTimeToLive") {
      exact(input, ["TableName", "TimeToLiveSpecification"]);
      requireValid(known(input.TableName) && created.has(input.TableName));
      const ttl = TABLE_SCHEMAS[input.TableName].ttlAttribute;
      const specification = record(input.TimeToLiveSpecification);
      exact(specification, ["AttributeName", "Enabled"]);
      requireValid(ttl && specification.AttributeName === ttl && specification.Enabled === true);
      const { TimeToLiveSpecification } = await backend.send(new UpdateTimeToLiveCommand({
        TableName: scope.qualify(input.TableName), TimeToLiveSpecification: { AttributeName: ttl, Enabled: true },
      }), options);
      return { status: 200, body: { TimeToLiveSpecification } };
    }
    return relayDynamoRequest(scope, target, input, send);
  }

  const server = createServer({ requestTimeout: 20_000, headersTimeout: 5_000, maxHeaderSize: 16_384 }, async (request, response) => {
    request.on("error", () => {});
    let result;
    try {
      const target = request.headers["x-amz-target"];
      requireValid(request.method === "POST" && request.url === "/" && typeof target === "string" &&
        request.headers["content-type"]?.split(";")[0] === "application/x-amz-json-1.0" &&
        (!request.headers["content-encoding"] || request.headers["content-encoding"] === "identity") &&
        request.headers.authorization?.startsWith("AWS4-HMAC-SHA256 Credential=campusLocalTest/") &&
        !request.headers["x-amz-security-token"]);
      result = await handle(target, await readQaRelayBody(request));
    } catch (error) {
      const allowed = ["ResourceNotFoundException", "ResourceInUseException", "ValidationException", "AccessDeniedException"];
      const name = error instanceof Error && allowed.includes(error.name) ? error.name : "ValidationException";
      result = { status: 400, body: { __type: `com.amazonaws.dynamodb.v20120810#${name}`, message: "Isolated fixture request failed" } };
    }
    if (response.destroyed) return;
    response.writeHead(result.status, { "Content-Type": "application/x-amz-json-1.0" });
    response.end(JSON.stringify(result.body));
  });
  server.on("close", () => backend.destroy());
  server.on("error", () => { backend.destroy(); process.exitCode = 1; });
  server.listen(8080, "127.0.0.2");
}

void main().catch(() => {
  console.error("Isolated account fixture configuration rejected");
  process.exitCode = 1;
});
