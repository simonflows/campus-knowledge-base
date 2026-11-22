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
import { POST as factCheck } from "../app/api/fact-check/route";
import { POST as analytics } from "../app/api/analytics/route";
import { POST as assistant } from "../app/api/assistant/route";
import { SESSION_COOKIE, signSessionToken } from "../lib/auth-server";
import { docClient, resetDbAvailableCache } from "../lib/db";
import { knowledgeSeedCards, type KnowledgeCard } from "../lib/knowledge";
import { TableName } from "../lib/schema";

const origin = "https://grounded-096.invalid";
const text = "Робот KUKA действует на площадке МИДиС.";
function sample() {
  const base = knowledgeSeedCards.find(card => card.type === "laboratory");
  assert.ok(base);
  return { ...structuredClone(base), title: "Центр МИДиС — KUKA", referenceDescription: text, equipment: ["Робот-манипулятор KUKA"], owners: ["PRIVATE OWNER"], status: "approved" } as KnowledgeCard;
}
function setup(context: TestContext, mode: "facts" | "chat" | "forged" | "stale") {
  let cards = [sample()];
  const settings = {
    USE_DATABASE: "true", DOCUMENT_API_ENDPOINT: origin, CAMPUS_PUBLIC_ORIGIN: origin,
    CAMPUS_DEMO_LOGIN: "false", CAMPUS_LOCAL_DEMO: "false", SESSION_SECRET: randomBytes(32).toString("hex"),
    CAMPUS_PILOT_ACCOUNTS: JSON.stringify([
      { login: mode, name: "QA сотрудник", profile: "demo-pr-midis", keyHash: "a".repeat(64) },
      { login: "guest", name: "QA гость", profile: "demo-guest", keyHash: "b".repeat(64) },
    ]),
    YANDEX_AI_STUDIO_API_KEY: "synthetic", YANDEX_AI_STUDIO_FOLDER_ID: "synthetic",
    YANDEX_AI_STUDIO_MODEL_URI: "gpt://synthetic/aliceai-llm-flash",
  };
  Object.assign(process.env, settings);
  resetDbAvailableCache();
  context.mock.method(docClient, "send", async (command: unknown) => {
    if (command instanceof ListTablesCommand) return {};
    if (command instanceof ScanCommand && command.input.TableName === TableName.KNOWLEDGE_CARDS) return { Items: structuredClone(cards) };
    if (command instanceof ScanCommand && command.input.TableName === TableName.KNOWLEDGE_CARD_TYPES) return { Items: [] };
    assert.fail("Unexpected DB request; tests must not write");
  });
  const provider = context.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://ai.api.cloud.yandex.net/v1/chat/completions");
    const body = JSON.parse(String(options.body));
    const data = JSON.parse(body.messages[1].content);
    assert.ok(!JSON.stringify(data.sources).includes("PRIVATE OWNER"));
    const source = data.sources[0];
    const fact = source.facts.find((fact: { field: string }) => fact.field === "referenceDescription");
    const quote = { sourceId: mode === "forged" ? "foreign" : source.id, factId: fact.id, quote: fact.text };
    const output = data.claims
      ? { claims: data.claims.map((claim: { id: number }) => ({ id: claim.id, verdict: "supported", explanation: "Совпадает с описанием карточки.", correction: "", evidence: [quote] })) }
      : { quotes: [quote], service: null, clarify: false };
    if (mode === "stale") cards = [{ ...cards[0], referenceDescription: "Карточка обновлена после запроса." }];
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }] });
  });
  context.after(() => { for (const name of Object.keys(settings)) delete process.env[name]; resetDbAvailableCache(); });
  return { provider };
}
function run(route: typeof factCheck | typeof analytics | typeof assistant, body: unknown, login?: string) {
  const request = new NextRequest(origin + "/api/test", { method: "POST", headers: {
    origin, "content-type": "application/json", ...(login ? { cookie: `${SESSION_COOKIE}=${signSessionToken("pilot-" + login)}` } : {}),
  }, body: JSON.stringify(body) });
  const store = createRequestStoreForAPI(request, request.nextUrl, { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined, undefined);
  return workAsyncStorage.run({} as NonNullable<ReturnType<typeof workAsyncStorage.getStore>>, () => workUnitAsyncStorage.run(store, () => route(request)));
}

test("working fact-check uses card evidence; invalid AI is rejected without losing the ordinary result", async context => {
  const { provider } = setup(context, "facts");
  const response = await run(factCheck, { text, useAi: true }, "facts");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ai.status, "ready");
  assert.ok(result.findings.some((finding: { method?: string }) => finding.method === "ai"));
  assert.ok(result.ai.claims[0].evidence[0].href.includes("version=cv-"));
  assert.equal(provider.mock.callCount(), 1);
});
test("a forged provider source never creates a green AI finding", async context => {
  setup(context, "forged");
  const result = await (await run(factCheck, { text, useAi: true }, "forged")).json();
  assert.equal(result.ai.status, "failed");
  assert.ok(!result.findings.some((finding: { method?: string }) => finding.method === "ai"));
});
test("a source changed during AI execution is rechecked with current canon", async context => {
  setup(context, "stale");
  const result = await (await run(factCheck, { text, useAi: true }, "stale")).json();
  assert.equal(result.ai.status, "failed");
  assert.equal(result.ai.reason, "sources-changed");
});
test("analytics requires a staff identity and keeps guest access read-only", async context => {
  const { provider } = setup(context, "chat");
  assert.equal((await run(analytics, { query: "KUKA" })).status, 401);
  assert.equal((await run(analytics, { query: "KUKA" }, "guest")).status, 403);
  assert.equal(provider.mock.callCount(), 0);
});
