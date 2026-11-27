import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { NextRequest } from "next/server";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store";
import { POST as requestCardEdit } from "../app/api/knowledge/cards/[id]/edit-requests/route";
import { GET as listInformationRequests, POST as createInformationRequest } from "../app/api/requests/route";
import { GET as readInformationRequest, PATCH as updateInformationRequest } from "../app/api/requests/[id]/route";
import { GET as listWorkflows } from "../app/api/workflows/route";
import { POST as accountPost } from "../app/api/auth/account/route";
import { DELETE as logout, GET as currentSession, POST as login } from "../app/api/auth/session/route";
import { SESSION_COOKIE, resolveSessionUserFromToken } from "../lib/auth-server";
import { createAccountService, type AccountMessage } from "../lib/account-service";
import { dynamoAccountStore } from "../lib/account-storage";
import { docClient } from "../lib/db";
import { TableName } from "../lib/schema";

const fakeSender = "public-test@example.test";
const fakeOrigin = "https://canon.example.test";
const password = "A fixture password for a protected account";

function inRequestContext<T>(request: NextRequest, handler: () => T): T {
  const requestStore = createRequestStoreForAPI(
    request, request.nextUrl, { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined, undefined,
  );
  return workAsyncStorage.run(
    {} as NonNullable<ReturnType<typeof workAsyncStorage.getStore>>,
    () => workUnitAsyncStorage.run(requestStore, handler),
  );
}

function request(path: string, body: unknown, cookie?: string) {
  return new NextRequest(fakeOrigin + "/api/auth/" + path, {
    method: body == null ? "DELETE" : "POST",
    body: body == null ? undefined : JSON.stringify(body),
    headers: {
      Origin: fakeOrigin,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: SESSION_COOKIE + "=" + cookie } : {}),
    },
  });
}

test("auth routes use DynamoDB CAS and require a signed, revocable host cookie", async (context) => {
  // Keep all failed logins in the same five-minute rate window, even at a wall-clock boundary.
  const stableNow = Math.floor(Date.now() / 300_000) * 300_000 + 30_000;
  context.mock.method(Date, "now", () => stableNow);
  process.env.CAMPUS_EMAIL_ACCOUNTS_ENABLED = "true";
  process.env.CAMPUS_PUBLIC_ORIGIN = fakeOrigin;
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  process.env.CAMPUS_DEMO_LOGIN = "false";
  process.env.CAMPUS_LOCAL_DEMO = "false";
  process.env.USE_DATABASE = "true";
  process.env.DOCUMENT_API_ENDPOINT = "https://db.example.test";
  delete process.env.CAMPUS_EMAIL_PROVIDER;

  const accounts = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const counts = new Map<string, number>();
  const messages: AccountMessage[] = [];
  const original = docClient.send;
  let storageUnavailable = false;
  let reads = 0;
  let reserveCount = 0;
  let nextTransactionConflicts = false;

  const rows = (table: string | undefined) => {
    if (table === TableName.ACCOUNT_IDENTITIES) return accounts;
    if (table === TableName.ACCOUNT_SESSIONS) return sessions;
    throw new Error("Unexpected table");
  };
  docClient.send = (async (command: unknown) => {
    if (storageUnavailable) throw new Error("Fixture contact failed");
    if (command instanceof ListTablesCommand) return {};
    if (command instanceof GetCommand) {
      reads++;
      assert.equal(command.input.ConsistentRead, true);
      return { Item: rows(command.input.TableName).get(command.input.Key!.id) };
    }
    if (command instanceof PutCommand) {
      const table = rows(command.input.TableName);
      const { Item, ConditionExpression, ExpressionAttributeValues } = command.input;
      const current = table.get(Item!.id);
      assert.ok(ConditionExpression);
      if (ConditionExpression === "attribute_not_exists(id)" ? current : current?.revision !== ExpressionAttributeValues?.[":revision"])
        throw Object.assign(new Error("Fixture condition failed"), { name: "ConditionalCheckFailedException" });
      table.set(Item!.id, structuredClone(Item!));
      return {};
    }
    if (command instanceof DeleteCommand) {
      rows(command.input.TableName).delete(command.input.Key!.id);
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      reserveCount++;
      if (nextTransactionConflicts) {
        nextTransactionConflicts = false;
        throw Object.assign(new Error("Fixture transaction contention"), {
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "TransactionConflict" }],
        });
      }
      const items = command.input.TransactItems!;
      const updates = items.flatMap(item => item.Update ? [item.Update] : []);
      const puts = items.flatMap(item => item.Put ? [item.Put] : []);
      assert.equal(items.length, puts.length + updates.length);
      if (puts.length) {
        assert.equal(puts.length, 1);
        assert.equal(updates.length, 1);
        assert.equal(puts[0].TableName, TableName.ACCOUNT_IDENTITIES);
        assert.match(updates[0].Key!.id, /^mail-day:/);
        assert.equal(updates[0].ExpressionAttributeValues![":limit"], 150);
        const put = puts[0];
        const current = accounts.get(put.Item!.id);
        if (put.ConditionExpression === "attribute_not_exists(id)" ? current : current?.revision !== put.ExpressionAttributeValues?.[":revision"]) {
          throw Object.assign(new Error("Fixture identity revision changed"), {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
          });
        }
      } else {
        assert.ok(updates.length >= 2);
        assert.ok(updates.every(update => !String(update.Key!.id).startsWith("mail-day:")));
      }
      for (const update of updates) {
        assert.equal(update.TableName, TableName.ACCOUNT_RATE_LIMITS);
        assert.match(update.ConditionExpression!, /#attempts < :limit/);
        if ((counts.get(update.Key!.id) ?? 0) >= update.ExpressionAttributeValues![":limit"])
          throw Object.assign(new Error("Fixture quota exceeded"), {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
          });
      }
      for (const update of updates) counts.set(update.Key!.id, (counts.get(update.Key!.id) ?? 0) + 1);
      for (const put of puts) accounts.set(put.Item!.id, structuredClone(put.Item!));
      return {};
    }
    throw new Error("Unexpected fixture command");
  }) as typeof docClient.send;

  try {
    const unavailable = await accountPost(request("account", { action: "signup", email: fakeSender }));
    assert.equal(unavailable.status, 503);
    assert.equal(reserveCount, 0);

    const fixtureService = createAccountService(dynamoAccountStore, () => Math.floor(Date.now() / 1000),
      async (message) => { messages.push(message); });
    await fixtureService.startSignup(fakeSender);
    assert.equal(messages.length, 1);
    assert.equal(await fixtureService.login(fakeSender, password).catch(error => error.status), 401);
    const redeem = { action: "verify", token: messages[0].token, password, name: "Тестовый автор" };
    assert.equal((await accountPost(request("account", redeem))).status, 200);
    assert.equal((await accountPost(request("account", redeem))).status, 400);

    const loginBody = { method: "email", email: fakeSender, password };
    nextTransactionConflicts = true;
    const opened = await login(request("session", loginBody));
    assert.equal(opened.status, 200);
    const header = opened.headers.get("set-cookie")!;
    assert.match(header, /__Host-vibecraft-session=v3\./);
    assert.match(header, /Path=\//i);
    assert.match(header, /Secure/i);
    assert.match(header, /HttpOnly/i);
    assert.doesNotMatch(header, /Domain=/i);
    const cookie = opened.cookies.get(SESSION_COOKIE)!.value;
    const user = await resolveSessionUserFromToken(cookie);
    assert.equal(user?.role, "author");
    const editRequest = new NextRequest(fakeOrigin + "/api/knowledge/cards/fixture/edit-requests", {
      method: "POST",
      body: JSON.stringify({ message: "Попытка запроса внешнего автора" }),
      headers: { Origin: fakeOrigin, "content-type": "application/json", cookie: SESSION_COOKIE + "=" + cookie },
    });
    const context = { params: Promise.resolve({ id: "fixture" }) };
    assert.equal((await inRequestContext(editRequest, () => requestCardEdit(editRequest, context))).status, 403);
    assert.equal((await inRequestContext(editRequest, listInformationRequests)).status, 403);
    assert.equal((await inRequestContext(editRequest, listWorkflows)).status, 403);

    const observedReads = reads;
    assert.equal(await resolveSessionUserFromToken(cookie.slice(0, -1) + (cookie.endsWith("0") ? "1" : "0")), null);
    assert.equal(reads, observedReads);

    storageUnavailable = true;
    assert.equal((await inRequestContext(editRequest, currentSession)).status, 503);
    const requestHeaders = { Origin: fakeOrigin, "content-type": "application/json", cookie: SESSION_COOKIE + "=" + cookie };
    const requestEndpoint = fakeOrigin + "/api/requests";
    const createRequest = new NextRequest(requestEndpoint, { method: "POST", headers: requestHeaders, body: "{}" });
    const patchRequest = new NextRequest(requestEndpoint + "/fixture", { method: "PATCH", headers: requestHeaders, body: "{}" });
    for (const [request, handler] of [
      [createRequest, listInformationRequests],
      [createRequest, () => createInformationRequest(createRequest)],
      [patchRequest, () => readInformationRequest(patchRequest, context)],
      [patchRequest, () => updateInformationRequest(patchRequest, context)],
    ] as const) {
      const failure = await inRequestContext(request, handler);
      assert.equal(failure.status, 503);
      assert.match(failure.headers.get("Cache-Control") ?? "", /no-store/i);
    }
    assert.equal((await login(request("session", loginBody))).status, 503);
    assert.equal((await logout(request("session", null, cookie))).status, 503);
    await assert.rejects(resolveSessionUserFromToken(cookie), { status: 503 });

    storageUnavailable = false;
    assert.equal((await logout(request("session", null, cookie))).status, 200);
    assert.equal(await resolveSessionUserFromToken(cookie), null);
    for (let index = 0; index < 10; index++) {
      assert.equal((await login(request("session", { ...loginBody, password: "incorrect" }))).status, 401);
    }
    assert.equal((await login(request("session", loginBody))).status, 429);
  } finally {
    docClient.send = original;
  }
});
