import { installPilotFixture } from "./pilot-fixture";
import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { NextRequest } from "next/server";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { POST as assistant } from "../app/api/assistant/route";
import { POST as factCheck } from "../app/api/fact-check/route";
import { SESSION_COOKIE, signSessionToken } from "../lib/auth-server";
import { docClient, resetDbAvailableCache } from "../lib/db";
import { knowledgeSeedCards } from "../lib/knowledge";

const origin = "https://source-fallback-fixture.invalid";
function fixture(context: TestContext) {
  const settings = {
    NODE_ENV: "test",
    USE_DATABASE: "true",
    DOCUMENT_API_ENDPOINT: origin,
    CAMPUS_PUBLIC_ORIGIN: origin,
    CAMPUS_DEMO_LOGIN: "true",
    CAMPUS_LOCAL_DEMO: "false",
    SESSION_SECRET: "",
    CAMPUS_PILOT_ACCOUNTS: "",
    YANDEX_AI_STUDIO_API_KEY: "",
    ALIBABA_DASHSCOPE_API_KEY: "",
  };
  Object.assign(process.env, settings);
  context.after(() => {
    for (const name of Object.keys(settings)) delete process.env[name];
  });
  const people = installPilotFixture();
  resetDbAvailableCache();
  context.after(resetDbAvailableCache);
  const old = structuredClone(
    knowledgeSeedCards.find((card) => card.type === "campus")!
  );
  old.campusMetrics[0].value = "150 000 кв. м";
  const current = structuredClone(old);
  current.campusMetrics[0].value = "160 000 кв. м";
  let scans = 0;
  context.mock.method(globalThis, "fetch", () =>
    assert.fail("This fixture must not call a provider")
  );
  context.mock.method(docClient, "send", async (command: unknown) => {
    if (command instanceof ListTablesCommand) return {};
    assert.ok(
      command instanceof ScanCommand &&
        command.input.TableName === "knowledge-cards"
    );
    return { Items: [++scans === 1 ? old : current] };
  });
  function run(
    handler: (request: NextRequest) => Promise<Response>,
    path: string,
    body: unknown,
    signed = false
  ) {
    const request = new NextRequest(origin + path, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(signed
          ? {
              cookie: `${SESSION_COOKIE}=${signSessionToken(people.account("demo-pr-midis").id)}`,
            }
          : {}),
      },
      body: JSON.stringify(body),
    });
    const store = createRequestStoreForAPI(
      request,
      request.nextUrl,
      { tags: [], expirationsByCacheKind: new Map() },
      undefined,
      undefined,
      undefined
    );
    return workAsyncStorage.run(
      {} as NonNullable<ReturnType<typeof workAsyncStorage.getStore>>,
      () => workUnitAsyncStorage.run(store, () => handler(request))
    );
  }
  return { run, scans: () => scans };
}

test("non-ready assistant fallback citations must still match the current source", async (context) => {
  const f = fixture(context);
  const response = await f.run(assistant, "/api/assistant", {
    message: "Какова общая площадь кампуса?",
  });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.equal(f.scans(), 2);
  assert.equal(answer.status, "failed");
  assert.deepEqual(answer.citations, []);
  assert.match(answer.message, /Карточки изменились/u);
});

test("unavailable semantic provider cannot return obsolete ordinary green findings", async (context) => {
  const f = fixture(context);
  const response = await f.run(
    factCheck,
    "/api/fact-check",
    { text: "Общая площадь объектов кампуса — 150 000 кв. м.", useAi: true },
    true
  );
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(f.scans(), 2);
  assert.equal(result.ai.reason, "sources-changed");
  assert.ok(result.summary.red > 0);
});
