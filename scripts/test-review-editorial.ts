import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { ListTablesCommand, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { strFromU8, unzipSync } from "fflate";
import { NextRequest } from "next/server";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store";
import { GET as exportDocx } from "../app/api/editor/drafts/[id]/docx/route";
import { POST as generateDraft } from "../app/api/editor/generate/route";
import { getDemoAccount, toSessionUser } from "../lib/auth";
import { SESSION_COOKIE, signSessionToken } from "../lib/auth-server";
import { docClient, resetDbAvailableCache } from "../lib/db";
import { buildDeterministicArticleDraft, normalizeGeneratedArticle, selectUniversityMetricCards } from "../lib/editor";
import { editorialContentSchema, type EditorialDocument, type EditorialRevision } from "../lib/editorial";
import { mutateEditorial } from "../lib/editorial-models";
import { mutateInformationRequest } from "../lib/information-requests-models";
import type { InformationRequest } from "../lib/information-requests";
import { knowledgeSeedCards, type CustomCard, type ProjectCard, type UniversityCard } from "../lib/knowledge";
import { knowledgeCardInputSchema, buildCustomFieldValuesSchema, cardTypeInputSchema } from "../lib/validation/knowledge";
import { TableName } from "../lib/schema";

const owner = toSessionUser(getDemoAccount("demo-pr-midis")!);
const now = "2026-11-20T11:00:00.000Z";
const source: ProjectCard = {
  id: "fixture-source",
  title: "Открытый учебный проект",
  type: "project",
  folderId: "01_universities/midis/products",
  owners: [],
  status: "approved",
  referenceDescription: "Студенты создают учебные материалы.",
  stopFormula: "Учебные сведения",
  createdAt: now,
  updatedAt: now,
  sphere: "Образование",
  initiatorUniversityId: "midis",
  coExecutors: [],
  industrialPartner: "Не указан",
  readinessStage: "Идея",
  contour: "собственный проект вуза",
  confirmedFigures: [],
  isJoint: false,
  participantUniversityIds: ["midis"],
};
const draftContent = editorialContentSchema.parse({
  title: "Синтетический материал",
  sourceCardIds: [source.id, "fixture-withdrawn"],
  sourceCardTitles: ["Прежнее название проекта", "Прежнее название отозванной карточки"],
});
const draft: EditorialDocument = {
  id: "fixture-draft",
  ownerId: owner.id,
  ownerName: owner.name,
  originalId: "fixture-draft",
  channel: "Оригинал",
  version: 1,
  revisionId: "fixture-revision",
  submittedRevisionId: null,
  approvedRevisionId: null,
  status: "draft",
  content: draftContent,
  events: [],
  createdAt: now,
  updatedAt: now,
};
const revision: EditorialRevision = {
  id: draft.revisionId,
  documentId: draft.id,
  number: 1,
  content: draftContent,
  actorId: owner.id,
  actorName: owner.name,
  createdAt: now,
};

function database(context: TestContext, handle: (command: unknown) => Promise<unknown>) {
  process.env.USE_DATABASE = "true";
  process.env.DOCUMENT_API_ENDPOINT = "https://editorial-test.invalid";
  process.env.OUTPUT_MODE = "fixture";
  process.env.CAMPUS_LOCAL_DEMO = "false";
  process.env.CAMPUS_DEMO_LOGIN = "true";
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  process.env.CAMPUS_PUBLIC_ORIGIN = "https://editorial-test.invalid";
  resetDbAvailableCache();
  const original = docClient.send;
  const calls: unknown[] = [];
  context.after(() => {
    docClient.send = original;
    resetDbAvailableCache();
  });
  docClient.send = (async (command: unknown) => {
    calls.push(command);
    if (command instanceof ListTablesCommand) return {};
    return handle(command);
  }) as typeof docClient.send;
  return calls;
}

function inRequestContext<T>(request: NextRequest, handler: () => T): T {
  const requestStore = createRequestStoreForAPI(
    request, request.nextUrl, { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined, undefined
  );
  return workAsyncStorage.run(
    {} as NonNullable<ReturnType<typeof workAsyncStorage.getStore>>,
    () => workUnitAsyncStorage.run(requestStore, handler)
  );
}

function generationRequest(body: string, userId?: string) {
  return new NextRequest("https://editorial-test.invalid/api/editor/generate", {
    method: "POST",
    headers: {
      origin: "https://editorial-test.invalid",
      "content-type": "application/json",
      ...(userId ? { cookie: `${SESSION_COOKIE}=${signSessionToken(userId)}` } : {}),
    },
    body,
  });
}

for (const [name, userId, body, status] of [
  ["anonymous", undefined, "{}", 401],
  ["guest", "demo-guest", JSON.stringify({ query: "Расскажите об учебном проекте", provider: "yandex" }), 403],
  ["guest with malformed JSON", "demo-guest", "{", 403],
] as const) {
  test(`${name} cannot generate a draft and is rejected before processing`, async context => {
    const commands = database(context, async () => assert.fail("Denied generation queried storage"));
    const outbound = context.mock.method(globalThis, "fetch", async () => assert.fail("Denied generation contacted a provider"));
    const request = generationRequest(body, userId);
    const response = await inRequestContext(request, () => generateDraft(request));
    assert.deepEqual(
      { status: response.status, bodyRead: request.bodyUsed, dbCalls: commands.length, outboundCalls: outbound.mock.callCount() },
      { status, bodyRead: false, dbCalls: 0, outboundCalls: 0 }
    );
  });
}

test("a staff member can still generate a draft with the local provider", async context => {
  database(context, async command => {
    if (command instanceof ScanCommand && command.input.TableName === TableName.ARTICLES) return { Items: [] };
    return editorialData(command);
  });
  const request = generationRequest(JSON.stringify({
    query: "Студенты создают учебные материалы",
    provider: "canonical",
  }), owner.id);
  const response = await inRequestContext(request, () => generateDraft(request));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.noData, false);
  assert.deepEqual(payload.article.sourceCardIds, [source.id]);
});

function editorialData(command: unknown) {
  if (command instanceof GetCommand && command.input.TableName === TableName.EDITORIAL_DOCUMENTS)
    return { Item: draft };
  if (command instanceof ScanCommand && command.input.TableName === TableName.EDITORIAL_REVISIONS)
    return { Items: [revision] };
  if (command instanceof ScanCommand && command.input.TableName === TableName.KNOWLEDGE_CARDS)
    return { Items: [source] };
  if (command instanceof GetCommand && command.input.TableName === TableName.KNOWLEDGE_CARDS)
    return { Item: command.input.Key?.id === source.id ? source : undefined };
  assert.fail("Unexpected editorial storage command");
}

test("deterministic generation handles valid long project titles and preserves long related text", () => {
  const title = "Длинное название проекта ".repeat(7).trim() + " и учебные исследования";
  const line = "Описание связанной инициативы без утверждений о цифрах. ";
  const extended = `${line.repeat(130)}Конец подтверждённого описания.`;
  const output = buildDeterministicArticleDraft({
    query: "Расскажите подробнее о проектах",
    selectedCards: [{ ...source, title }, {
      ...source,
      id: "second-source",
      referenceDescription: extended,
    }],
    matchedArticles: [],
    referenceChunks: [],
  });
  assert.ok(output.title.includes(title));
  const text = output.sections.flatMap(({ chunks }) => chunks).map(chunk => chunk.content).join(" ");
  assert.match(text, /Конец подтверждённого описания\./);
  assert.equal(editorialContentSchema.safeParse(output).success, true);
});

test("model-provided repeated section ids still yield a saveable draft", () => {
  const result = normalizeGeneratedArticle({
    title: source.title,
    lead: source.referenceDescription,
    sections: [
      { id: "section", heading: "Первая часть", chunks: ["Учебный текст"] },
      { id: "section", heading: "Вторая часть", chunks: ["Описание проекта"] },
    ],
    sourceCardIds: [source.id],
  }, { selectedCards: [source], matchedArticles: [] });
  assert.equal(result.sections.length, 2);
  assert.equal(editorialContentSchema.safeParse(result).success, true);
});

test("valid custom-card text spanning more than twelve paragraphs remains a saveable article", () => {
  const fields = Array.from({ length: 5 }, (_, index) => ({
    id: `detail-${index}`, name: `Раздел ${index}`, type: "longText" as const,
    required: true, options: [],
  }));
  const typeInput = cardTypeInputSchema.parse({ name: "Учебная карточка", description: "", fields });
  const type = { ...typeInput, id: "fixture-long", createdAt: now, updatedAt: now };
  const values = Object.fromEntries(fields.map((field, index) => [field.id, `${"а".repeat(9_980)} конец-${index}`]));
  const input = knowledgeCardInputSchema.parse({
    type: "custom", customTypeId: type.id, title: "Подробная карточка", folderId: "03_custom",
    owners: ["Синтетический владелец"], referenceDescription: "Открытое учебное описание.", stopFormula: "Без новых сведений",
    customFields: buildCustomFieldValuesSchema(type).parse(values),
  });
  const card: CustomCard = { ...input, type: "custom", customTypeId: type.id, customFields: values, id: "fixture-long-card", status: "approved", createdAt: now, updatedAt: now };
  const output = buildDeterministicArticleDraft({ query: "Собрать подробный материал", selectedCards: [card], matchedArticles: [], referenceChunks: [] });
  assert.equal(editorialContentSchema.safeParse(output).success, true);
  assert.ok(output.sections.length >= 2);
  const text = output.sections.flatMap(section => section.chunks.map(chunk => chunk.content)).join(" ");
  for (let index = 0; index < fields.length; index++) assert.ok(text.includes(`конец-${index}`));
});

test("two passports of the same university preserve both sources and unique paragraph identifiers", () => {
  const base = knowledgeSeedCards.find((card): card is UniversityCard => card.type === "university" && card.universityId === "midis")!;
  const metric = { id: "fixture-metric", label: "Учебный показатель", value: 101, unit: "мест", year: 2026, kind: "actual" as const, evidenceUrl: "https://example.org/test", verifiedAt: "2026-11-22", owner: "Тестовый владелец" };
  const first = { ...base, id: "fixture-passport-one", structuredMetrics: [{ ...metric, label: "Первый показатель" }] };
  const second = { ...base, id: "fixture-passport-two", structuredMetrics: [{ ...metric, value: 202, label: "Второй показатель" }] };
  const query = "Покажи паспорт вуза МИДиС";
  const selectedCards = selectUniversityMetricCards(query, [first, second]);
  assert.equal(selectedCards?.length, 2);
  const output = buildDeterministicArticleDraft({ query, selectedCards: selectedCards!, matchedArticles: [], referenceChunks: [] });
  assert.equal(editorialContentSchema.safeParse(output).success, true);
  assert.deepEqual(output.sourceCardIds, [first.id, second.id]);
  const text = output.sections.flatMap(section => section.chunks.map(chunk => chunk.content)).join(" ");
  assert.match(text, /первый показатель/iu);
  assert.match(text, /второй показатель/iu);
});

test("Word export identifies withdrawn sources and links only to approved cards", async context => {
  database(context, async command => editorialData(command));
  const request = new NextRequest(`https://editorial-test.invalid/api/editor/drafts/${draft.id}/docx`, {
    headers: { cookie: `${SESSION_COOKIE}=${signSessionToken(owner.id)}` },
  });
  const response = await inRequestContext(
    request, () => exportDocx(request, { params: Promise.resolve({ id: draft.id }) })
  );
  assert.equal(response.status, 200);
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const xml = strFromU8(entries["word/document.xml"]);
  const links = strFromU8(entries["word/_rels/document.xml.rels"]);
  assert.match(xml, /Прежнее название проекта/);
  assert.match(xml, /Источник недоступен/);
  assert.match(links, /fixture-source/);
  assert.doesNotMatch(links, /fixture-withdrawn/);
});

function capacityError() {
  return new TransactionCanceledException({
    $metadata: {},
    message: "Synthetic transaction canceled",
    CancellationReasons: [{ Code: "None" }, { Code: "ProvisionedThroughputExceeded" }],
  });
}

test("editorial writes preserve storage failures instead of reporting a version conflict", async context => {
  const outage = capacityError();
  database(context, async command => {
    if (command instanceof TransactWriteCommand) throw outage;
    return editorialData(command);
  });
  await assert.rejects(mutateEditorial(draft.id, owner, {
    action: "save", version: draft.version, content: draftContent,
  }), error => error === outage);
});

test("submitting a request preserves storage failures instead of reporting a revision conflict", async context => {
  const item: InformationRequest = {
    id: "request-fixture",
    authorId: owner.id,
    authorName: owner.name,
    authorOrganization: owner.organization,
    recipientUniversityId: "susu",
    subject: "Учебный проект",
    question: "Можно получить описание учебного проекта?",
    linkedCardId: null,
    status: "answered",
    answer: "Материалы подготовлены для открытого занятия.",
    evidenceUrl: "https://example.org/lesson",
    answeredBy: "demo-owner-susu",
    candidateCardId: null,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    creationDigest: "fixture",
    lastOperationId: null,
    lastOperationDigest: null,
  };
  const outage = capacityError();
  database(context, async command => {
    if (command instanceof GetCommand && command.input.TableName === TableName.INFORMATION_REQUESTS)
      return { Item: item };
    if (command instanceof TransactWriteCommand) throw outage;
    assert.fail("Unexpected information request storage command");
  });
  await assert.rejects(mutateInformationRequest(owner, item.id, {
    action: "submit", revision: item.revision, operationId: randomUUID(),
  }), error => error === outage);
});
