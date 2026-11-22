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
import candidates from "../data/pilot-0.9.5-candidates.json";
import verification from "../data/pilot-0.9.5-verification.json";
import { POST as factCheck } from "../app/api/fact-check/route";
import { POST as analytics } from "../app/api/analytics/route";
import { POST as assistant } from "../app/api/assistant/route";
import { SESSION_COOKIE, signSessionToken } from "../lib/auth-server";
import { FACT_CHECK_PRESETS } from "../lib/audit-canon-registry";
import { docClient, resetDbAvailableCache } from "../lib/db";
import { knowledgeSeedCards, type KnowledgeCard } from "../lib/knowledge";
import { TableName } from "../lib/schema";

const origin = "https://grounded-096.invalid";
const text = "Робот KUKA действует на площадке МИДиС.";
const kukaDraft = FACT_CHECK_PRESETS.find(({ id }) => id === "preset-midis-kuka")!.text;
const rewrittenKuka = "Робот-манипулятор KUKA помогает создавать скульптуры по цифровым моделям в Центре промышленного дизайна МИДиС.";
const planKuka = "В 2024 году институт объявил о намерении создать отдельную лабораторию промышленного и архитектурного дизайна в кампусе с участием компании «Голос».";
const pilotIds = new Set(verification.approvedIds);
const pilotCards = candidates.cards
  .filter(({ card }) => pilotIds.has(card.id))
  .map(({ card }) => ({ ...card, status: "approved" })) as KnowledgeCard[];

function sample() {
  const base = knowledgeSeedCards.find(card => card.type === "laboratory");
  assert.ok(base);
  return { ...structuredClone(base), title: "Центр МИДиС — KUKA", referenceDescription: text, equipment: ["Робот-манипулятор KUKA"], owners: ["PRIVATE OWNER"], status: "approved" } as KnowledgeCard;
}
function setup(
  context: TestContext,
  mode: string,
  initialCards = [sample()],
  rewriteReply?: (data: Record<string, unknown>, source: { id: string; facts: { field: string; id: string; text: string }[] }) => unknown
) {
  let cards = initialCards;
  let storageOffline = false;
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
    if (command instanceof ScanCommand && command.input.TableName === TableName.KNOWLEDGE_CARDS) {
      if (storageOffline) throw new Error("Synthetic storage outage during rewrite");
      return { Items: structuredClone(cards) };
    }
    if (command instanceof ScanCommand && command.input.TableName === TableName.KNOWLEDGE_CARD_TYPES) return { Items: [] };
    assert.fail("Unexpected DB request; tests must not write");
  });
  const provider = context.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://ai.api.cloud.yandex.net/v1/chat/completions");
    const body = JSON.parse(String(options.body));
    const data = JSON.parse(body.messages[1].content);
    if (mode === "rewrite-transport-error" && data.candidates) throw new Error("Synthetic verifier outage");
    assert.ok(!JSON.stringify(data.sources).includes("PRIVATE OWNER"));
    const source = data.sources[0];
    const fact = source.facts.find((fact: { field: string }) => fact.field === "referenceDescription");
    const quote = { sourceId: mode === "forged" ? "foreign" : source.id, factId: fact.id, quote: fact.text };
    const output = rewriteReply ? rewriteReply(data, source) : data.claims
      ? { claims: data.claims.map((claim: { id: number }) => ({ id: claim.id, verdict: "supported", explanation: "Совпадает с описанием карточки.", correction: "", evidence: [quote] })) }
      : { quotes: [quote], service: null, clarify: false };
    if (mode === "stale") cards = [{ ...cards[0], referenceDescription: "Карточка обновлена после запроса." }];
    if (mode === "rewrite-stale" && data.candidates) {
      cards = cards.map(card => card.id === "lab-midis-kuka"
        ? { ...card, referenceDescription: "На площадке МИДиС указан промышленный робот-манипулятор KUKA." }
        : card);
    }
    if (mode === "rewrite-deleted" && data.candidates) {
      cards = cards.filter(card => card.id !== "lab-midis-kuka");
    }
    if (mode === "rewrite-offline" && data.candidates) storageOffline = true;
    return Response.json({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
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

test("guest can rewrite the original KUKA example and find the same approved equipment in chat", async context => {
  const { provider } = setup(context, "chat", pilotCards);
  const response = await run(factCheck, { text: kukaDraft, mode: "rewrite" }, "guest");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.summary.red > 0);
  assert.deepEqual(result.rewrite.sourceCardIds, ["lab-midis-kuka"]);
  assert.match(result.rewrite.lead, /МИДиС.*KUKA.*скульптуры/u);
  assert.equal(result.rewriteCheck.canPublish, true);
  assert.equal(result.rewriteCheck.isClean, true);

  const chat = await run(assistant, { message: "кто такой робот кука" }, "guest");
  assert.equal(chat.status, 200);
  const answer = await chat.json();
  assert.equal(answer.status, "local");
  assert.ok(answer.citations.some((item: { cardId: string; quote: string; href: string }) =>
    item.cardId === "lab-midis-kuka" && item.quote.includes("KUKA") && item.href.includes("version=cv-")
  ));
  assert.equal(provider.mock.callCount(), 0);
});

test("opt-in staff AI rewrite accepts a verified thematic paraphrase and retains original findings", async context => {
  const { provider } = setup(context, "rewrite", pilotCards, (data, source) => {
    assert.equal((data.sources as unknown[]).length, 1);
    const fact = source.facts.find(({ field }) => field === "referenceDescription")!;
    const evidence = [{ sourceId: source.id, factId: fact.id }];
    return data.candidates
      ? { reviews: [{ id: 1, verdict: "supported" }, { id: 2, verdict: "supported" }] }
      : { sentences: [{ text: rewrittenKuka, evidence }, { text: planKuka, evidence }] };
  });
  const options = { text: kukaDraft, mode: "rewrite", useAi: true };
  assert.equal((await run(factCheck, options, "guest")).status, 403);
  const response = await run(factCheck, options, "rewrite");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.rewriteAi.status, "ready");
  assert.match(result.rewrite.lead, /^Робот-манипулятор KUKA помогает/u);
  assert.doesNotMatch(result.rewrite.plainText, /кинопласт|114|245|37|https?:/iu);
  assert.ok(result.summary.red > 0);
  assert.equal(result.rewriteCheck.canPublish, true);
  assert.equal(result.rewriteAi.citations[0].cardId, "lab-midis-kuka");
  assert.match(result.rewriteAi.citations[0].href, /version=cv-/u);
  assert.deepEqual(result.rewriteAi.usage, { inputTokens: 200, outputTokens: 40 });
  assert.equal(result.rewriteAi.usageComplete, true);
  assert.equal(result.rewriteAi.attempts, 2);
  assert.equal(provider.mock.callCount(), 2);
});

test("a verifier transport failure reports known usage without filling in missing billing data", async context => {
  const login = "rewrite-transport-error";
  const { provider } = setup(context, login, pilotCards, (_data, source) => {
    const fact = source.facts.find(({ field }) => field === "referenceDescription")!;
    const evidence = [{ sourceId: source.id, factId: fact.id }];
    return { sentences: [{ text: rewrittenKuka, evidence }, { text: planKuka, evidence }] };
  });
  const result = await (await run(factCheck, { text: kukaDraft, mode: "rewrite", useAi: true }, login)).json();
  assert.equal(result.rewriteAi.status, "failed");
  assert.equal(result.rewriteAi.attempts, 2);
  assert.equal(result.rewriteAi.usageComplete, false);
  assert.deepEqual(result.rewriteAi.usage, { inputTokens: 100, outputTokens: 20 });
  assert.equal(result.rewriteAi.cost, undefined);
  assert.equal(provider.mock.callCount(), 2);
});

test("AI generation receives the editable assertion separately from the dated plan", async context => {
  const login = "rewrite-prompt";
  let editable: unknown;
  const { provider } = setup(context, login, pilotCards, (data, source) => {
    const fact = source.facts.find(({ field }) => field === "referenceDescription")!;
    const evidence = [{ sourceId: source.id, factId: fact.id }];
    if (data.candidates) {
      return { reviews: [{ id: 1, verdict: "supported" }, { id: 2, verdict: "supported" }] };
    }
    editable = data.editableSentenceIds;
    return { sentences: [{ text: rewrittenKuka, evidence }, { text: planKuka, evidence }] };
  });
  const result = await (await run(factCheck, { text: kukaDraft, mode: "rewrite", useAi: true }, login)).json();
  assert.deepEqual(editable, [1]);
  assert.equal(result.rewriteAi.status, "ready");
  assert.equal(result.rewrite.lead, rewrittenKuka + " " + planKuka);
  assert.equal(provider.mock.callCount(), 2);
});

test("separately validated rewrite sentences retain their boundary when the provider omits final periods", async context => {
  const login = "rewrite-punctuation";
  const actualFirst = "Робот-манипулятор KUKA помогает создавать скульптуры по цифровым моделям в Центре промышленного дизайна на площадке института МИДиС";
  const expectedLead = actualFirst + ". " + planKuka;
  let verified: unknown;
  const { provider } = setup(context, login, pilotCards, (data, source) => {
    const fact = source.facts.find(({ field }) => field === "referenceDescription")!;
    const evidence = [{ sourceId: source.id, factId: fact.id }];
    if (Array.isArray(data.candidates)) {
      verified = data.candidates.map(({ text }) => text);
      return { reviews: [{ id: 1, verdict: "supported" }, { id: 2, verdict: "supported" }] };
    }
    return { sentences: [
      { text: actualFirst, evidence },
      { text: planKuka.slice(0, -1), evidence },
    ] };
  });
  const result = await (await run(factCheck, { text: kukaDraft, mode: "rewrite", useAi: true }, login)).json();
  assert.equal(result.rewriteAi.status, "ready");
  assert.equal(result.rewrite.lead, expectedLead);
  assert.ok(result.rewrite.plainText.includes(expectedLead));
  assert.deepEqual(verified, [actualFirst + ".", planKuka]);
  assert.equal(provider.mock.callCount(), 2);
});

for (const [caseId, candidate, plan, factOverride, verifier, expectedCalls] of [
  ["multi-sentence", rewrittenKuka + " Робот лечит пациентов.", planKuka, null, "supported", 1],
  ["number", rewrittenKuka.replace("скульптуры", "378 скульптур"), planKuka, null, "supported", 1],
  ["place", rewrittenKuka.replace("в Центре промышленного дизайна МИДиС", "в новом корпусе кампуса"), planKuka, null, "supported", 1],
  ["location-link", rewrittenKuka.replace("в Центре", "из Центра"), planKuka, null, "supported", 1],
  ["model", rewrittenKuka.replace("KUKA", "FANUC"), planKuka, null, "supported", 1],
  ["relation", rewrittenKuka.replace("скульптуры по цифровым моделям", "цифровые модели по скульптурам"), planKuka, null, "supported", 1],
  ["negation", rewrittenKuka.replace("помогает", "не помогает"), planKuka, null, "supported", 1],
  ["plan", rewrittenKuka, planKuka.replace("объявил о намерении создать", "создал"), null, "supported", 1],
  ["url", rewrittenKuka.replace("МИДиС", "МИДиС https://unsafe.invalid"), planKuka, null, "supported", 1],
  ["source", rewrittenKuka, planKuka, "foreign", "supported", 1],
  ["verifier", rewrittenKuka, planKuka, null, "unknown", 2],
] as const) {
  test(`AI rewrite falls back on ${caseId} without allowing a provider to certify unsupported material`, async context => {
    const login = "rewrite-" + caseId;
    const { provider } = setup(context, login, pilotCards, (data, source) => {
      const fact = source.facts.find(({ field }) => field === "referenceDescription")!;
      const evidence = [{ sourceId: source.id, factId: factOverride ?? fact.id }];
      return data.candidates
        ? { reviews: [{ id: 1, verdict: verifier }, { id: 2, verdict: "supported" }] }
        : { sentences: [{ text: candidate, evidence }, { text: plan, evidence }] };
    });
    const response = await run(factCheck, { text: kukaDraft, mode: "rewrite", useAi: true }, login);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.rewriteAi.status, "failed");
    assert.match(result.rewrite.lead, /^МИДиС описывает/u);
    assert.equal(result.rewriteCheck.canPublish, true);
    assert.ok(result.summary.red > 0);
    assert.equal(provider.mock.callCount(), expectedCalls);
  });
}

test("AI rewrite never returns a candidate grounded in a superseded source version", async context => {
  const { provider } = setup(context, "rewrite-stale", pilotCards, (data, source) => {
    const fact = source.facts.find(({ field }) => field === "referenceDescription")!;
    const evidence = [{ sourceId: source.id, factId: fact.id }];
    return data.candidates
      ? { reviews: [{ id: 1, verdict: "supported" }, { id: 2, verdict: "supported" }] }
      : { sentences: [{ text: rewrittenKuka, evidence }, { text: planKuka, evidence }] };
  });
  const result = await (await run(factCheck, { text: kukaDraft, mode: "rewrite", useAi: true }, "rewrite-stale")).json();
  assert.equal(result.rewriteAi.status, "failed");
  assert.equal(result.rewriteAi.reason, "sources-changed");
  assert.equal(result.rewrite.lead, "На площадке МИДиС указан промышленный робот-манипулятор KUKA.");
  assert.equal(provider.mock.callCount(), 2);
});

for (const [mode, expectedStatus] of [["rewrite-deleted", 200], ["rewrite-offline", 503]] as const) {
  test(`an unknown verdict cannot certify a cached rewrite after ${mode}`, async context => {
    const { provider } = setup(context, mode, pilotCards, (data, source) => {
      const fact = source.facts.find(({ field }) => field === "referenceDescription")!;
      const evidence = [{ sourceId: source.id, factId: fact.id }];
      return data.candidates
        ? { reviews: [{ id: 1, verdict: "unknown" }, { id: 2, verdict: "supported" }] }
        : { sentences: [{ text: rewrittenKuka, evidence }, { text: planKuka, evidence }] };
    });
    const response = await run(factCheck, { text: kukaDraft, mode: "rewrite", useAi: true }, mode);
    const result = await response.json();
    assert.equal(response.status, expectedStatus);
    if (mode === "rewrite-deleted") {
      assert.equal(result.rewrite, null);
      assert.equal(result.rewriteCheck, null);
      assert.equal(result.rewriteAi.reason, "sources-changed");
      assert.ok(result.findings.every((finding: { sourceCardId?: string }) => finding.sourceCardId !== "lab-midis-kuka"));
    } else {
      assert.equal(result.rewrite, undefined);
      assert.equal(result.rewriteCheck, undefined);
    }
    assert.equal(provider.mock.callCount(), 2);
  });
}
