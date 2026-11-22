import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { NextRequest } from "next/server";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store";
import { POST as analytics } from "../app/api/analytics/route";
import { POST as factCheck } from "../app/api/fact-check/route";
import { isCurrentFlashRequest } from "../components/flash-assist-hint";
import { SESSION_COOKIE, signSessionToken } from "../lib/auth-server";
import { docClient, resetDbAvailableCache } from "../lib/db";
import { knowledgeSeedCards } from "../lib/knowledge";
import { TableName } from "../lib/schema";

const origin = "https://integrated-flash.invalid";
const query = "Покажи проекты МИДиС по лечению и восстановлению";
const sourceText = "Лаборатория открывается осенью. В испытаниях участвовали специалисты вуза.";
const proposed = "Покажи проекты МИДиС в сфере медицины";
const fixtureAccounts = [
  "query", "facts", "bad-uni", "fake-total", "drop-criteria", "verdict",
  "unavailable", "blocked", "long", "concurrent", "malformed", "outage",
];

function fixture(context: TestContext, response: ((body: unknown) => Response | Promise<Response>) | undefined = undefined) {
  const settings = {
    USE_DATABASE: "true", DOCUMENT_API_ENDPOINT: origin, OUTPUT_MODE: "fixture",
    CAMPUS_LOCAL_DEMO: "false", CAMPUS_DEMO_LOGIN: "false", CAMPUS_PUBLIC_ORIGIN: origin,
    SESSION_SECRET: randomBytes(32).toString("hex"),
    CAMPUS_PILOT_ACCOUNTS: JSON.stringify(
      [...fixtureAccounts.map((login) => ({ login, profile: "demo-pr-midis" })),
        { login: "guest", profile: "demo-guest" }].map((user, index) => ({
          ...user, name: "Синтетический сотрудник", keyHash: index.toString(16).padStart(64, "0"),
        })),
    ),
    YANDEX_AI_STUDIO_API_KEY: "synthetic",
    YANDEX_AI_STUDIO_FOLDER_ID: "synthetic",
    YANDEX_AI_STUDIO_MODEL_URI: "gpt://synthetic/aliceai-llm-flash",
  };
  Object.assign(process.env, settings);
  resetDbAvailableCache();
  const db = context.mock.method(docClient, "send", async (command: unknown) => {
    if (command instanceof ListTablesCommand) return {};
    if (command instanceof ScanCommand) {
      if (command.input.TableName === TableName.KNOWLEDGE_CARDS) return { Items: knowledgeSeedCards };
      if (command.input.TableName === TableName.KNOWLEDGE_CARD_TYPES) return { Items: [] };
    }
    assert.fail("Unexpected database request");
  });
  if (response === undefined) delete process.env.YANDEX_AI_STUDIO_API_KEY;
  const provider = context.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://ai.api.cloud.yandex.net/v1/chat/completions");
    assert.equal(new Headers(options.headers).get("x-data-logging-enabled"), "false");
    assert.ok(response);
    return response(JSON.parse(String(options.body)));
  });
  context.after(() => {
    for (const key of Object.keys(settings)) delete process.env[key];
    resetDbAvailableCache();
  });
  return { provider, db };
}

function answer(output: unknown) {
  const content = typeof output === "string" ? output : JSON.stringify(output);
  return Response.json({ choices: [{ finish_reason: "stop", message: { content } }] });
}

function run(
  route: typeof analytics | typeof factCheck, input: unknown, login?: string, requestOrigin = origin,
) {
  const request = new NextRequest(origin + "/api/test", {
    method: "POST",
    headers: {
      origin: requestOrigin, "content-type": "application/json",
      ...(login && { cookie: `${SESSION_COOKIE}=${signSessionToken("pilot-" + login)}` }),
    },
    body: JSON.stringify(input),
  });
  const requestStore = createRequestStoreForAPI(
    request, request.nextUrl, { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined, undefined,
  );
  return workAsyncStorage.run(
    {} as NonNullable<ReturnType<typeof workAsyncStorage.getStore>>,
    () => workUnitAsyncStorage.run(requestStore, () => route(request)),
  );
}

test("normal submissions and rewrites stay local unless the user opts in for a check or a report", async (context) => {
  const { provider } = fixture(context, () => assert.fail("Unexpected provider request"));
  for (const flashAssist of [undefined, false]) {
    assert.equal((await run(analytics, { query, flashAssist })).status, 200);
    assert.equal((await run(factCheck, { text: sourceText, flashAssist })).status, 200);
  }
  assert.equal((await run(factCheck, { text: sourceText, mode: "rewrite", flashAssist: true })).status, 200);
  assert.equal((await run(analytics, { query, flashAssist: "true" })).status, 400);
  assert.equal(provider.mock.callCount(), 0);
});

test("staff opt-in adds a proposal or source quotes without changing the deterministic result", async (context) => {
  const responses = [{ query: proposed }, { ids: [2] }];
  const { provider } = fixture(context, (body) => {
    assert.match(JSON.stringify(body), /данные/i);
    return answer(responses.shift());
  });
  const originalReport = await (await run(analytics, { query })).json();
  const assistedReport = await run(analytics, { query, flashAssist: true }, "query");
  assert.equal(assistedReport.status, 200);
  const { flashAssist: suggestion, ...report } = await assistedReport.json();
  assert.deepEqual(report, originalReport);
  assert.equal(suggestion.suggestion.query, proposed);
  assert.ok(suggestion.suggestion.filters.some((filter: { key: string }) => filter.key === "industry"));
  const ordinary = await (await run(factCheck, { text: sourceText })).json();
  const checked = await run(factCheck, { text: sourceText, flashAssist: true }, "facts");
  assert.equal(checked.status, 200);
  const { flashAssist: hint, ...facts } = await checked.json();
  assert.deepEqual(facts, ordinary);
  assert.deepEqual(hint, { status: "ready", fragments: ["В испытаниях участвовали специалисты вуза."] });
  assert.equal(provider.mock.callCount(), 2);
});

test("guest, anonymous and cross-origin opt-in are rejected before paid calls or database access", async (context) => {
  const { provider, db } = fixture(context, () => assert.fail("Unexpected provider request"));
  assert.equal((await run(analytics, { query, flashAssist: true })).status, 401);
  assert.equal((await run(factCheck, { text: sourceText, flashAssist: true }, "guest")).status, 403);
  assert.equal((await run(analytics, { query, flashAssist: true }, "blocked", "https://other.invalid")).status, 403);
  assert.equal(provider.mock.callCount(), 0);
  assert.equal(db.mock.callCount(), 0);
});

test("unsafe analytics or fact outputs cannot manufacture a location, count or verdict", async (context) => {
  const replies = [
    { query: "Покажи проекты гарвардского университета в сфере медицины" },
    { query: "Покажи 99 проектов МИДиС" },
    { query: "Покажи проекты в сфере медицины" },
    { ids: [2], verdict: "подтверждено" },
  ];
  fixture(context, () => answer(replies.shift()));
  const { flashAssist: fabricated } = await (await run(analytics, { query: "Покажи разработки для лечения", flashAssist: true }, "bad-uni")).json();
  assert.deepEqual(fabricated, { status: "ready", suggestion: null });
  const { flashAssist: amount } = await (await run(analytics, { query, flashAssist: true }, "fake-total")).json();
  assert.deepEqual(amount, { status: "failed" });
  const { flashAssist: dropped } = await (await run(analytics, { query, flashAssist: true }, "drop-criteria")).json();
  assert.deepEqual(dropped, { status: "ready", suggestion: null });
  const { flashAssist: verdict } = await (await run(factCheck, { text: sourceText, flashAssist: true }, "verdict")).json();
  assert.deepEqual(verdict, { status: "failed" });
});

test("long text and a missing provider still return the usual report without sending data", async (context) => {
  const { provider } = fixture(context);
  const long = await run(factCheck, { text: "Проверяемый фрагмент. ".repeat(300), flashAssist: true }, "long");
  assert.equal(long.status, 200);
  assert.equal((await long.json()).flashAssist.status, "too-long");
  const status = await run(analytics, { query, flashAssist: true }, "unavailable");
  assert.equal(status.status, 200);
  const result = await status.json();
  assert.equal(result.flashAssist.status, "unavailable");
  assert.ok(result.summary);
  assert.equal(provider.mock.callCount(), 0);
});

test("a provider outage or malformed JSON leaves the authoritative output intact", async (context) => {
  const replies = [answer("не JSON"), new Response(null, { status: 503 })];
  const { provider } = fixture(context, () => replies.shift()!);
  const original = await (await run(factCheck, { text: sourceText })).json();
  for (const login of ["malformed", "outage"]) {
    const response = await run(factCheck, { text: sourceText, flashAssist: true }, login);
    assert.equal(response.status, 200);
    const { flashAssist, ...checked } = await response.json();
    assert.deepEqual(checked, original);
    assert.deepEqual(flashAssist, { status: "failed" });
  }
  assert.equal(provider.mock.callCount(), 2);
});

test("a second submission for the same account uses the local report while the first call is in flight", async (context) => {
  const entered = Promise.withResolvers<void>();
  const paused = Promise.withResolvers<Response>();
  const { provider } = fixture(context, () => {
    entered.resolve();
    return paused.promise;
  });
  const first = run(analytics, { query, flashAssist: true }, "concurrent");
  await entered.promise;
  try {
    const second = await run(analytics, { query, flashAssist: true }, "concurrent");
    assert.equal(second.status, 200);
    const data = await second.json();
    assert.deepEqual(data.flashAssist, { status: "busy" });
    assert.ok(data.summary);
    assert.equal(provider.mock.callCount(), 1);
  } finally {
    paused.resolve(answer({ query: proposed }));
    await first;
  }
});

test("a request superseded during JSON parsing cannot replace a newer result", () => {
  const previous = new AbortController();
  const current = new AbortController();
  assert.equal(isCurrentFlashRequest(previous, current), false);
  assert.equal(isCurrentFlashRequest(current, current), true);
  current.abort();
  assert.equal(isCurrentFlashRequest(current, current), false);
});
