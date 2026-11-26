import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import {
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createAccountService } from "../lib/account-service";
import { dynamoAccountStore } from "../lib/account-storage";
import { getDemoAccount, toSessionUser, type SessionUser } from "../lib/auth";
import { captureDatabase, restoreDatabase, verifyDatabaseArchive } from "../lib/database-backup";
import { docClient } from "../lib/db";
import { createEditorial, getEditorialWithRevisions, mutateEditorial } from "../lib/editorial-models";
import { createEditorialSchema } from "../lib/editorial";
import { TABLE_NAMES, TableName } from "../lib/schema";
import { createYandexFlow, exchangeYandexCode, readYandexFlow } from "../lib/yandex-oauth";
import { requireFixtureDatabase } from "./qa-fixture";

const ttlTables = [TableName.ACCOUNT_SESSIONS, TableName.ACCOUNT_RATE_LIMITS];
const storageSiteKey = "storage:author:site";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function readRow(table: string, id: string) {
  return docClient.send(new GetCommand({ TableName: table, Key: { id }, ConsistentRead: true }), {
    abortSignal: AbortSignal.timeout(15_000),
  }).then(({ Item }) => Item);
}

async function putNew(table: TableName, item: Record<string, unknown>) {
  await docClient.send(new PutCommand({
    TableName: table, Item: item, ConditionExpression: "attribute_not_exists(id)",
  }), { abortSignal: AbortSignal.timeout(15_000) });
}

async function verifyTtl(client: DynamoDBClient) {
  for (const name of [TableName.ACCOUNT_IDENTITIES, ...ttlTables]) {
    const { TimeToLiveDescription: ttl } = await client.send(
      new DescribeTimeToLiveCommand({ TableName: name }), { abortSignal: AbortSignal.timeout(15_000) },
    );
    assert.ok(ttl, `${name} must report its TTL state`);
    if (name === TableName.ACCOUNT_IDENTITIES) {
      assert.equal(ttl.TimeToLiveStatus, "DISABLED");
    } else if (ttl.TimeToLiveStatus === "DISABLED" && process.env.CAMPUS_QA_EXPECT_TTL !== "yes") {
      continue;
    } else {
      assert.ok(ttl.TimeToLiveStatus === "ENABLED" || ttl.TimeToLiveStatus === "ENABLING", `${name} TTL migration has not been accepted`);
      assert.equal(ttl.AttributeName, "expiresAt");
    }
  }
}

async function verifyRateTransaction(context: TestContext, id: string, now: number) {
  const sealed = { id: `${id}:sealed`, limit: 1, expiresAt: now + 3600 };
  const other = { id: `${id}:other`, limit: 3, expiresAt: now + 3600 };
  const table = TableName.ACCOUNT_RATE_LIMITS;
  assert.equal(await dynamoAccountStore.consumeRate([sealed]), true);

  // Check the real Document API failure shape consumed by the account and editorial models.
  await assert.rejects(docClient.send(new TransactWriteCommand({ TransactItems: [
    { Put: { TableName: table, Item: { ...sealed, attempts: 2 }, ConditionExpression: "attribute_not_exists(id)" } },
    { Put: { TableName: table, Item: { ...other, attempts: 1 }, ConditionExpression: "attribute_not_exists(id)" } },
  ] }), { abortSignal: AbortSignal.timeout(15_000) }), reason => {
    assert.ok(reason instanceof TransactionCanceledException);
    if (reason.CancellationReasons?.length) {
      assert.equal(reason.CancellationReasons[0]?.Code, "ConditionalCheckFailed");
      assert.equal(reason.CancellationReasons[1]?.Code, "None");
      context.diagnostic("Document API included positional CancellationReasons");
    } else {
      context.diagnostic("Document API omitted positional CancellationReasons");
    }
    return true;
  });
  assert.equal(await dynamoAccountStore.consumeRate([sealed, other]), false);
  assert.equal((await readRow(table, sealed.id))?.attempts, 1);
  assert.equal(await readRow(table, other.id), undefined);
}

async function verifyOAuth(id: string, now: number) {
  const createService = () => createAccountService(dynamoAccountStore, () => now, async () => {
    assert.fail("This fixture does not send email");
  });
  const first = createService();
  const second = createService();
  const config = {
    clientId: "fixture-oauth", clientSecret: randomBytes(16).toString("hex"), signingSecret: randomBytes(32).toString("hex"),
    basePath: "", origin: "https://account-fixture.invalid", redirectUri: "https://account-fixture.invalid/api/auth/yandex/callback",
  };
  const { authorizationUrl, cookie } = createYandexFlow(config, "/editor", "", now);
  const flow = readYandexFlow(config, cookie, authorizationUrl.searchParams.get("state"), "", now);
  assert.ok(flow);
  assert.deepEqual((await Promise.all([
    first.consumeYandexFlow(flow.state, flow.expiresAt),
    second.consumeYandexFlow(flow.state, flow.expiresAt),
  ])).sort(), [false, true]);
  assert.equal(await createService().consumeYandexFlow(flow.state, flow.expiresAt), false);

  const profile = await exchangeYandexCode(config, "test-authorization-code", flow.verifier, async (url) => {
    if (String(url) === "https://oauth.yandex.ru/token") return Response.json({ access_token: "fixture-access-token" });
    assert.equal(String(url), "https://login.yandex.ru/info?format=json");
    return Response.json({ id, client_id: config.clientId, real_name: "Автор QA" });
  });
  const [left, right] = await Promise.all([first.loginYandex(profile), second.loginYandex(profile)]);
  assert.equal(left.user.id, right.user.id);
  assert.equal((await second.resolveSession(left.token, ["yandex"]))?.id, left.user.id);
  assert.equal(await second.resolveSession(left.token, ["password"]), null);
  await second.logout(left.token);
  assert.equal(await readRow(TableName.ACCOUNT_SESSIONS, hash(left.token)), undefined);
  assert.equal(await first.resolveSession(left.token), null);
  assert.equal((await first.resolveSession(right.token))?.role, "author");

  const coordinator = toSessionUser(getDemoAccount("demo-admin")!);
  const selected = await first.findForGrant(coordinator, right.user.id);
  const results = await Promise.allSettled([
    first.grantRoleById(coordinator, selected.id, selected.revision, { role: "university_pr", universityId: "midis" }),
    second.grantRoleById(coordinator, selected.id, selected.revision, { role: "university_owner", universityId: "midis" }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected")?.reason.status, 409);
  assert.equal(await first.resolveSession(right.token), null);

  const author = await second.loginYandex({ subject: `${id}-author`, name: "Автор черновика QA" });
  const active = await first.resolveSession(author.token, ["yandex"]);
  assert.ok(active && active.role === "author");
  return active;
}

async function verifyAuthorStorage(user: SessionUser) {
  const key = `storage:author:user:${user.id}`;
  const table = TableName.ACCOUNT_RATE_LIMITS;
  const initialSite = await readRow(table, storageSiteKey);
  const original = await createEditorial(user, createEditorialSchema.parse({ content: { title: "Черновик QA" } }));
  const firstBudget = await readRow(table, key);
  assert.equal(firstBudget?.drafts, 1);
  assert.ok(typeof firstBudget?.bytes === "number" && firstBudget.bytes > 0);
  assert.equal(firstBudget.expiresAt, undefined);
  assert.equal((await readRow(table, storageSiteKey))?.bytes, (initialSite?.bytes ?? 0) + firstBudget.bytes);

  const outcomes = await Promise.allSettled(["Редакция А", "Редакция Б"].map(lead => mutateEditorial(original.id, user, {
    action: "save", version: original.version, content: { ...original.content, lead },
  })));
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.find(result => result.status === "rejected")?.reason.status, 409);
  const afterEdit = await getEditorialWithRevisions(original.id, user);
  assert.equal(afterEdit.document.version, original.version + 1);
  assert.equal(afterEdit.revisions.length, 2);
  const authorBudget = await readRow(table, key);
  const siteBudget = await readRow(table, storageSiteKey);
  assert.ok(typeof authorBudget?.bytes === "number" && authorBudget.bytes > firstBudget.bytes);
  assert.equal(siteBudget?.bytes, (initialSite?.bytes ?? 0) + authorBudget.bytes);

  // Saturate only this synthetic author's own counter; leave the shared site's balance untouched.
  await docClient.send(new PutCommand({
    TableName: table, Item: { ...authorBudget, bytes: 4 * 1024 * 1024 },
    ConditionExpression: "#bytes = :observed", ExpressionAttributeNames: { "#bytes": "bytes" },
    ExpressionAttributeValues: { ":observed": authorBudget.bytes },
  }), { abortSignal: AbortSignal.timeout(15_000) });
  await assert.rejects(mutateEditorial(original.id, user, { action: "save", version: afterEdit.document.version,
    content: { ...afterEdit.document.content, lead: "Редакция сверх квоты" },
  }), { status: 429 });
  const preserved = await getEditorialWithRevisions(original.id, user);
  assert.equal(preserved.document.version, afterEdit.document.version);
  assert.equal(preserved.revisions.length, afterEdit.revisions.length);
  assert.equal((await readRow(table, storageSiteKey))?.bytes, siteBudget?.bytes);
  assert.equal((await readRow(table, key))?.bytes, 4 * 1024 * 1024);
}

async function verifyArchive(client: DynamoDBClient, endpoint: string, id: string, now: number, sessionId: string, storageKey: string) {
  // Move the synthetic snapshot past the test expiration times while the fixture rows still have wall-clock TTL left.
  const cutoff = now + 3600;
  const timestamp = new Date(cutoff * 1000);
  const baseline = await captureDatabase({ client, endpoint, timestamp });
  const originalCounter = await readRow(TableName.ACCOUNT_RATE_LIMITS, storageKey);
  assert.ok(typeof originalCounter?.bytes === "number" && originalCounter.bytes > 0);
  assert.equal(originalCounter.expiresAt, undefined);
  const activeSession = await readRow(TableName.ACCOUNT_SESSIONS, sessionId);
  assert.ok(activeSession && activeSession.expiresAt > cutoff);
  const expiredSession = hash(id + ":expired-session");
  const expiredRate = `${id}:expired-rate`;
  const cutoffRate = `${id}:at-cutoff`;
  const activeRate = `${id}:active-rate`;
  const malformedRate = `${id}:malformed-rate`;
  await putNew(TableName.ACCOUNT_SESSIONS, { ...activeSession, id: expiredSession, expiresAt: cutoff - 1 });
  await putNew(TableName.ACCOUNT_RATE_LIMITS, { id: expiredRate, attempts: 1, expiresAt: cutoff - 1 });
  await putNew(TableName.ACCOUNT_RATE_LIMITS, { id: cutoffRate, attempts: 1, expiresAt: cutoff });
  await putNew(TableName.ACCOUNT_RATE_LIMITS, { id: activeRate, attempts: 1, expiresAt: cutoff + 1 });
  const { Table: rates } = await client.send(new DescribeTableCommand({ TableName: TableName.ACCOUNT_RATE_LIMITS }), {
    abortSignal: AbortSignal.timeout(15_000),
  });
  // YDB exposes its TTL column as a typed attribute; DynamoDB Local keeps the field schemaless.
  const typedTtl = Boolean(rates?.AttributeDefinitions?.some(attribute => attribute.AttributeName === "expiresAt" && attribute.AttributeType === "N"));
  const insertMalformed = () => putNew(TableName.ACCOUNT_RATE_LIMITS, { id: malformedRate, attempts: 1, expiresAt: String(cutoff - 1) });
  if (typedTtl) await assert.rejects(insertMalformed(), { name: "ValidationException" });
  else await insertMalformed();

  const archive = verifyDatabaseArchive(await captureDatabase({ client, endpoint, timestamp }));
  assert.equal(archive.createdAt, timestamp.toISOString());
  assert.equal(archive.tables.length, 11);
  assert.deepEqual(archive.tables.map(table => table.name), [...TABLE_NAMES].sort());
  for (const table of archive.tables) {
    if (ttlTables.some(name => name === table.name)) continue;
    assert.equal(table.sha256, baseline.tables.find(previous => previous.name === table.name)?.sha256, table.name);
  }
  const rows = (name: TableName) => archive.tables.find(table => table.name === name)!.items;
  const includes = (name: TableName, id: string) => rows(name).some(row => "S" in row.id && row.id.S === id);
  assert.equal(includes(TableName.ACCOUNT_SESSIONS, sessionId), true);
  assert.equal(includes(TableName.ACCOUNT_SESSIONS, expiredSession), false);
  assert.equal(includes(TableName.ACCOUNT_RATE_LIMITS, expiredRate), false);
  assert.equal(includes(TableName.ACCOUNT_RATE_LIMITS, cutoffRate), false);
  assert.equal(includes(TableName.ACCOUNT_RATE_LIMITS, activeRate), true);
  assert.equal(includes(TableName.ACCOUNT_RATE_LIMITS, malformedRate), !typedTtl);
  assert.equal(includes(TableName.ACCOUNT_RATE_LIMITS, storageKey), true);
  assert.equal(includes(TableName.ACCOUNT_RATE_LIMITS, storageSiteKey), true);
  assert.equal((await readRow(TableName.ACCOUNT_SESSIONS, expiredSession))?.expiresAt, cutoff - 1);

  const prefix = `qa095-account100-${randomUUID()}-`;
  const restored = await restoreDatabase({ client, endpoint, target: { prefix }, archive });
  assert.equal(restored.sha256, archive.sha256);
  assert.equal((await readRow(prefix + TableName.ACCOUNT_SESSIONS, sessionId))?.expiresAt, activeSession.expiresAt);
  assert.ok(!await readRow(prefix + TableName.ACCOUNT_SESSIONS, expiredSession));
  assert.ok(!await readRow(prefix + TableName.ACCOUNT_RATE_LIMITS, expiredRate));
  assert.equal((await readRow(prefix + TableName.ACCOUNT_RATE_LIMITS, activeRate))?.expiresAt, cutoff + 1);
  assert.equal((await readRow(prefix + TableName.ACCOUNT_RATE_LIMITS, malformedRate))?.expiresAt, typedTtl ? undefined : String(cutoff - 1));
  const permanent = await readRow(prefix + TableName.ACCOUNT_RATE_LIMITS, storageKey);
  assert.equal(permanent?.bytes, originalCounter.bytes);
  assert.equal(permanent?.expiresAt, undefined);
}

const skip = process.env.CAMPUS_QA_DISPOSABLE !== "yes" || !process.env.CAMPUS_QA_MARKER
  ? "Requires an isolated database with CAMPUS_QA_DISPOSABLE=yes and CAMPUS_QA_MARKER"
  : false;

async function markedFixture(context: TestContext) {
  await requireFixtureDatabase();
  assert.notEqual(process.env.CAMPUS_LOCAL_DEMO, "true", "Use the disposable DynamoDB fixture for this test");
  assert.notEqual(process.env.OUTPUT_MODE, "export", "Use the disposable DynamoDB fixture for this test");
  const endpoint = "http://127.0.0.1:8000";
  const client = new DynamoDBClient({ endpoint, region: process.env.DOCUMENT_API_REGION ?? "ru-central1", maxAttempts: 1,
    credentials: { accessKeyId: "campusLocalTest", secretAccessKey: "localTestOnly" },
  });
  context.after(() => client.destroy());
  const id = `qa-account100-${randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  return { client, endpoint, id, now };
}

test("a marked Document API applies TTL and recovers conditional transaction outcomes", { skip }, async context => {
  const { client, id, now } = await markedFixture(context);
  await verifyTtl(client);
  await verifyRateTransaction(context, id, now);
});

test("a marked Document API integrates OAuth and atomic author storage limits", { skip }, async context => {
  const { id, now } = await markedFixture(context);
  const author = await verifyOAuth(id, now);
  await verifyAuthorStorage(author);
});

// Run after the other fixture writers stop, so both snapshots have a stable source.
test("a marked Document API snapshots and restores all eleven tables in an isolated prefix", { skip }, async context => {
  const { client, endpoint, id, now } = await markedFixture(context);
  const account = createAccountService(dynamoAccountStore, () => now, async () => assert.fail("This fixture does not send email"));
  const author = await account.loginYandex({ subject: `${id}-archive`, name: "Автор для проверки архива QA" });
  await createEditorial(author.user, createEditorialSchema.parse({ content: { title: "Черновик для проверки архива" } }));
  await verifyArchive(client, endpoint, id, now, hash(author.token), `storage:author:user:${author.user.id}`);
});
