import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { NextRequest } from "next/server";
import { POST as startLogin } from "../app/api/auth/yandex/start/route";
import { GET as completeLogin } from "../app/api/auth/yandex/callback/route";
import { DELETE as logout } from "../app/api/auth/session/route";
import { canCreateCard, canUseStaffWorkflow } from "../lib/auth";
import { SESSION_COOKIE, resolveSessionUserFromToken } from "../lib/auth-server";
import { docClient } from "../lib/db";
import { TableName } from "../lib/schema";
import { createYandexFlow, exchangeYandexCode, readYandexFlow, YANDEX_OAUTH_COOKIE, yandexOAuthConfig } from "../lib/yandex-oauth";

const origin = "https://canon.example.test";
const clientId = "fixture-yandex";
const clientSecret = "fixture-client-key";
const providerCode = "synthetic-code";
const accessToken = "synthetic-access";
const refreshToken = "synthetic-refresh";
const queryProfile = "https://login.yandex.ru/info?format=json";
const queryToken = "https://oauth.yandex.ru/token";
const rowName = "Тестовый автор";

function configure() {
  process.env.CAMPUS_DEMO_LOGIN = "false";
  process.env.CAMPUS_LOCAL_DEMO = "false";
  process.env.USE_DATABASE = "true";
  process.env.CAMPUS_EMAIL_ACCOUNTS_ENABLED = "false";
  process.env.CAMPUS_YANDEX_OAUTH_ENABLED = "true";
  process.env.CAMPUS_PUBLIC_ORIGIN = origin;
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  process.env.YANDEX_OAUTH_CLIENT_ID = clientId;
  process.env.YANDEX_OAUTH_CLIENT_SECRET = clientSecret;
  delete process.env.BASE_PATH;
}

function fakeDb(context: TestContext) {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  let unavailable = false;
  let calls = 0;
  context.mock.method(docClient, "send", async (command: unknown) => {
    calls++;
    if (unavailable) throw new Error("Synthetic DB outage");
    if (command instanceof GetCommand) return { Item: structuredClone(table(command.input.TableName!).get(command.input.Key!.id)) };
    if (command instanceof PutCommand) {
      const rows = table(command.input.TableName!);
      const id = command.input.Item!.id;
      const current = rows.get(id);
      if (command.input.ConditionExpression === "attribute_not_exists(id)" ? current : current?.revision !== command.input.ExpressionAttributeValues?.[":revision"]) {
        throw Object.assign(new Error("Synthetic row conflict"), { name: "ConditionalCheckFailedException" });
      }
      rows.set(id, structuredClone(command.input.Item!));
      return {};
    }
    if (command instanceof DeleteCommand) {
      table(command.input.TableName!).delete(command.input.Key!.id);
      return {};
    }
    assert.ok(command instanceof TransactWriteCommand);
    const writes = command.input.TransactItems!.map(item => item.Update!);
    if (writes.some(write => Number(table(write.TableName!).get(write.Key!.id)?.attempts ?? 0) >= write.ExpressionAttributeValues![":limit"])) {
      throw Object.assign(new Error("Synthetic rate or replay"), {
        name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
      });
    }
    for (const write of writes) {
      const rows = table(write.TableName!);
      const id = write.Key!.id;
      rows.set(id, { id, attempts: Number(rows.get(id)?.attempts ?? 0) + 1, expiresAt: write.ExpressionAttributeValues![":expiresAt"] });
    }
    return {};
  });
  return { table, count: () => calls, fail: () => { unavailable = true; } };
}

async function start(next = "/editor", requestOrigin = origin) {
  return startLogin(new NextRequest(origin + "/api/auth/yandex/start?next=" + encodeURIComponent(next), {
    method: "POST", headers: { Origin: requestOrigin },
  }));
}

function callback(state: string | null, cookie?: string, code = providerCode) {
  const url = new URL("http://internal.example.test/api/auth/yandex/callback");
  url.searchParams.set("state", state ?? "");
  url.searchParams.set("code", code);
  return new NextRequest(url, { headers: { ...(cookie ? { Cookie: YANDEX_OAUTH_COOKIE + "=" + cookie } : {}), Host: "untrusted.example.test" } });
}

function stateOf(response: Response) {
  return new URL(response.headers.get("Location")!).searchParams.get("state");
}

test("Yandex OAuth flow signs the PKCE verifier, returns only to an allowed path and expires", () => {
  configure();
  const config = yandexOAuthConfig()!;
  const started = createYandexFlow(config, "//untrusted.example.test", "browser-session", 1000);
  const state = started.authorizationUrl.searchParams.get("state");
  const flow = readYandexFlow(config, started.cookie, state, "browser-session", 1000)!;
  assert.equal(flow.next, "/knowledge");
  assert.equal(started.authorizationUrl.origin, "https://oauth.yandex.ru");
  assert.equal(started.authorizationUrl.searchParams.get("scope"), "login:info login:email");
  assert.equal(started.authorizationUrl.searchParams.get("redirect_uri"), origin + "/api/auth/yandex/callback");
  assert.equal(started.authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(started.authorizationUrl.searchParams.get("code_challenge"),
    createHash("sha256").update(flow.verifier).digest("base64url"));
  assert.equal(started.authorizationUrl.searchParams.has("code_verifier"), false);
  assert.equal(readYandexFlow(config, started.cookie, state, "different-browser-session", 1000), null);
  assert.equal(readYandexFlow(config, started.cookie, state, "browser-session", flow.expiresAt), null);
  assert.equal(readYandexFlow({ ...config, clientId: "different-client" }, started.cookie, state, "browser-session", 1000), null);
});

test("real OAuth route handlers reject cross-browser callbacks and replays before exchanging Yandex credentials", async context => {
  configure();
  const db = fakeDb(context);
  let codeChallenge = "";
  const provider = context.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    if (url === queryToken) {
      assert.equal(init.method, "POST");
      const form = init.body as URLSearchParams;
      assert.equal(form.get("code"), providerCode);
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("redirect_uri"), origin + "/api/auth/yandex/callback");
      assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), codeChallenge);
      const headers = new Headers(init.headers);
      assert.equal(headers.get("Authorization"), "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64"));
      return Response.json({ access_token: accessToken, refresh_token: refreshToken });
    }
    assert.equal(url, queryProfile);
    assert.equal(new Headers(init.headers).get("Authorization"), "OAuth " + accessToken);
    return Response.json({ id: "fixture-yandex-user", client_id: clientId, display_name: rowName, default_email: "contact@example.test" });
  });

  assert.equal((await start("/editor", "https://untrusted.example.test")).status, 403);
  const started = await start("/requests");
  assert.equal(started.status, 303);
  const attributes = started.headers.get("set-cookie")?.split(";").slice(1).map(attribute => attribute.trim().toLowerCase()) ?? [];
  for (const attribute of ["path=/", "httponly", "secure", "samesite=lax", "max-age=480"]) assert.ok(attributes.includes(attribute));
  assert.ok(!attributes.some(attribute => attribute.startsWith("domain=")));
  assert.equal(started.headers.get("Referrer-Policy"), "no-referrer");
  const cookie = started.cookies.get(YANDEX_OAUTH_COOKIE)!.value;
  const state = stateOf(started);
  codeChallenge = new URL(started.headers.get("Location")!).searchParams.get("code_challenge")!;
  const changed = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A");
  for (const invalid of [callback(state), callback(state, changed), callback("a".repeat(43), cookie)]) {
    const response = await completeLogin(invalid);
    assert.equal(response.headers.get("Location"), origin + "/login?oauth=invalid");
    assert.equal(response.cookies.get(YANDEX_OAUTH_COOKIE)?.maxAge, 0);
  }
  assert.equal(provider.mock.callCount(), 0);
  assert.equal(db.count(), 0);

  const results = await Promise.all([completeLogin(callback(state, cookie)), completeLogin(callback(state, cookie))]);
  const success = results.find(response => response.cookies.has(SESSION_COOKIE))!;
  assert.equal(success.status, 303);
  assert.equal(success.headers.get("Location"), origin + "/knowledge");
  assert.equal(success.cookies.get(YANDEX_OAUTH_COOKIE)?.maxAge, 0);
  assert.equal(success.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(success.headers.get("Cache-Control"), "private, no-store");
  assert.equal(results.filter(response => response.cookies.has(SESSION_COOKIE)).length, 1);
  assert.equal(provider.mock.callCount(), 2);

  const session = success.cookies.get(SESSION_COOKIE)!.value;
  const user = await resolveSessionUserFromToken(session);
  assert.equal(user?.role, "author");
  assert.equal(user?.name, rowName);
  assert.equal(canCreateCard(user), false);
  assert.equal(canUseStaffWorkflow(user), false);
  const rows = JSON.stringify([TableName.ACCOUNT_IDENTITIES, TableName.ACCOUNT_SESSIONS, TableName.ACCOUNT_RATE_LIMITS]
    .flatMap(table => [...db.table(table).values()]));
  for (const privateValue of [providerCode, accessToken, refreshToken, cookie, session, "fixture-yandex-user"]) assert.equal(rows.includes(privateValue), false);

  const replayed = await completeLogin(callback(state, cookie));
  assert.equal(replayed.headers.get("Location"), origin + "/login?oauth=invalid");
  assert.equal(provider.mock.callCount(), 2);
  assert.equal((await logout(new NextRequest(origin + "/api/auth/session", {
    method: "DELETE", headers: { Origin: origin, Cookie: SESSION_COOKIE + "=" + session },
  }))).status, 200);
  assert.equal(await resolveSessionUserFromToken(session), null);
});

test("provider and database outages fail closed without exposing a callback or token", async context => {
  configure();
  const db = fakeDb(context);
  const provider = context.mock.method(globalThis, "fetch", async () => new Response(accessToken, { status: 502 }));
  const started = await start();
  const failed = await completeLogin(callback(stateOf(started), started.cookies.get(YANDEX_OAUTH_COOKIE)!.value));
  assert.equal(failed.status, 503);
  assert.equal(failed.cookies.get(YANDEX_OAUTH_COOKIE)?.maxAge, 0);
  assert.equal(failed.cookies.has(SESSION_COOKIE), false);
  assert.equal((await failed.text()).includes(accessToken), false);
  assert.equal(db.table(TableName.ACCOUNT_IDENTITIES).size, 0);

  db.fail();
  const newFlow = await start();
  const unavailable = await completeLogin(callback(stateOf(newFlow), newFlow.cookies.get(YANDEX_OAUTH_COOKIE)!.value));
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.cookies.has(SESSION_COOKIE), false);
  assert.equal(provider.mock.callCount(), 1);
});

test("provider responses must match this OAuth client and stay within the response size limit", async () => {
  configure();
  const config = yandexOAuthConfig()!;
  const wrongClient: typeof fetch = async input => String(input) === queryToken
    ? Response.json({ access_token: accessToken })
    : Response.json({ id: "other-client-user", client_id: "different-client", display_name: rowName });
  await assert.rejects(exchangeYandexCode(config, providerCode, "v".repeat(43), wrongClient), { status: 503 });
  const oversized: typeof fetch = async () => Response.json({ access_token: "v".repeat(17000) });
  await assert.rejects(exchangeYandexCode(config, providerCode, "v".repeat(43), oversized), { status: 503 });
  const expired: typeof fetch = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
  await assert.rejects(exchangeYandexCode(config, providerCode, "v".repeat(43), expired), { status: 400 });
});
