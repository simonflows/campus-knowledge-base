import "next/dist/server/node-environment";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { NextRequest } from "next/server";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store";
import { workAsyncStorage, type WorkStore } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { POST as generate } from "../app/api/editor/generate/route";
import { SESSION_COOKIE, signSessionToken } from "../lib/auth-server";
import { docClient, resetDbAvailableCache } from "../lib/db";
import { editorialContentSchema } from "../lib/editorial";
import { getEditorialReadiness, updateEditorialReadiness } from "../lib/editorial-readiness";
import { createEditorial, getEditorialSourceVersions, mutateEditorial } from "../lib/editorial-models";
import { knowledgeSeedCards, type StructuredMetric, type UniversityCard } from "../lib/knowledge";
import { getCardVersionId } from "../lib/knowledge-versions";
import { TableName } from "../lib/schema";
import { installPilotFixture } from "./pilot-fixture";

const timestamp = "2026-11-22T12:00:00.000Z";
const metric: StructuredMetric = {
  id: "students-2025", label: "Численность студентов", year: 2025, unit: "студентов", kind: "actual", value: 10,
  evidenceUrl: "https://example.org/qa/students-2025", verifiedAt: timestamp, owner: "Учебный вуз",
};
const passport: UniversityCard = {
  id: "qa-passport-editor-source-versions", type: "university", title: "Учебные показатели МИДиС",
  folderId: "01_universities/midis", owners: [], referenceDescription: "Сведения из утверждённого паспорта МИДиС.",
  stopFormula: "", universityId: "midis", status: "approved", createdAt: timestamp, updatedAt: timestamp,
  structuredMetrics: [metric, { ...metric, id: "students-2024", year: 2024, value: 8 }],
};

function database(context: TestContext) {
  const environment = {
    USE_DATABASE: "true", DOCUMENT_API_ENDPOINT: "http://fixture.invalid", OUTPUT_MODE: "fixture", CAMPUS_LOCAL_DEMO: "false",
  };
  const prior = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  resetDbAvailableCache();
  context.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDbAvailableCache();
  });
  const tables = new Map<string, Map<string, object>>();
  function table(name?: string) {
    assert.ok(name);
    const found = tables.get(name) ?? new Map<string, object>();
    tables.set(name, found);
    return found;
  }
  const save = (name: TableName, item: { id: string }) => table(name).set(item.id, item);
  context.mock.method(docClient, "send", async (command: unknown) => {
    if (command instanceof ListTablesCommand) return {};
    if (command instanceof GetCommand) return { Item: table(command.input.TableName).get(command.input.Key?.id) };
    if (command instanceof ScanCommand) return { Items: [...table(command.input.TableName).values()] };
    if (command instanceof PutCommand) {
      assert.ok(command.input.Item);
      table(command.input.TableName).set(command.input.Item.id, command.input.Item);
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      for (const { Put } of command.input.TransactItems ?? []) {
        if (Put?.Item) table(Put.TableName).set(Put.Item.id, Put.Item);
      }
      return {};
    }
    assert.fail("No unmanaged database operations in the regression");
  });
  return { save, table };
}

test("a single-year generation saves the full passport's immutable version", async context => {
  const { save } = database(context);
  const user = installPilotFixture().account("demo-pr-midis");
  save(TableName.KNOWLEDGE_CARDS, passport);
  const session = signSessionToken(user.id);
  assert.ok(session.length);
  const route = "/api/editor/generate";
  const origin = "http://localhost:8080";
  const request = new NextRequest(origin + route, {
    method: "POST", headers: { Origin: origin, Cookie: SESSION_COOKIE + "=" + session },
    body: JSON.stringify({ query: "Покажи фактические показатели МИДиС за 2025 год", provider: "canonical" }),
  });
  const store = createRequestStoreForAPI(request, { pathname: route }, { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined, undefined);
  const response = await workAsyncStorage.run({ route } as WorkStore, () =>
    workUnitAsyncStorage.run(store, () => generate(request)));
  assert.equal(response.status, 200);
  const { article, noData } = await response.json();
  assert.equal(noData, false);
  assert.ok(JSON.stringify(article.sections).includes("2025"));
  assert.ok(!JSON.stringify(article.sections).includes("2024"), "The draft still uses the requested year");
  const draft = await createEditorial(user, { channel: "Оригинал", content: editorialContentSchema.parse(article) });
  const [pinned] = await getEditorialSourceVersions(draft.content);
  assert.equal(pinned.version?.id, getCardVersionId(passport));
  assert.deepEqual((pinned.version?.snapshot as UniversityCard).structuredMetrics.map(row => row.year), [2025, 2024]);
});

test("approval checks pinned numbers even when the current card would confirm the text", async context => {
  const { save, table } = database(context);
  const accounts = installPilotFixture();
  const user = accounts.account("demo-pr-midis");
  const coordinator = accounts.account("demo-admin");
  save(TableName.KNOWLEDGE_CARDS, passport);
  const pin = { cardId: passport.id, versionId: getCardVersionId(passport) };
  const lead = "МИДиС: в 2025 году 20 студентов.";
  const content = editorialContentSchema.parse({
    universityId: "midis", title: passport.title, lead,
    sections: [{ id: "section", heading: "Показатели", level: 2, chunks: [{ id: "paragraph", content: lead }] }],
    sourceCardIds: [passport.id], sourceVersions: [pin],
  });
  const draft = await createEditorial(user, { channel: "Оригинал", content });
  const revisedPassport = { ...passport, updatedAt: "2026-11-23T12:00:00.000Z",
    structuredMetrics: [{ ...metric, value: 20 }, passport.structuredMetrics[1]] };
  save(TableName.KNOWLEDGE_CARDS, revisedPassport);
  const submit = await mutateEditorial(draft.id, user, {
    action: "submit", version: draft.version, revisionId: draft.revisionId, reviewerId: coordinator.id, comment: "",
  });
  await assert.rejects(mutateEditorial(draft.id, coordinator, {
    action: "approve", version: submit.document.version, revisionId: draft.revisionId, comment: "",
  }), { status: 422 });
  assert.equal(table(TableName.ARTICLES).size, 0);
  assert.equal((await getEditorialReadiness(user, draft.id)).approval.status, "submitted");

  const legacy = await createEditorial(user, { channel: "Оригинал", content: { ...content, sourceVersions: undefined } });
  const legacySubmitted = await mutateEditorial(legacy.id, user, {
    action: "submit", version: legacy.version, revisionId: legacy.revisionId, reviewerId: coordinator.id, comment: "",
  });
  const legacyApproved = await mutateEditorial(legacy.id, coordinator, {
    action: "approve", version: legacySubmitted.document.version, revisionId: legacy.revisionId, comment: "",
  });
  assert.equal(legacyApproved.document.status, "approved");
  assert.equal(legacyApproved.publication?.sourceVersions, undefined);
});

test("readiness separates evidence for an official title from an unrelated claim", async context => {
  const { save } = database(context);
  const user = installPilotFixture().account("demo-pr-midis");
  const source = knowledgeSeedCards.find(card => card.id === "project-susu-digital-twin")!;
  save(TableName.KNOWLEDGE_CARDS, source);
  const content = editorialContentSchema.parse({
    universityId: "midis", title: `Проект «${source.title}»`,
    lead: "Экспедиция завоевала международную награду.",
    sourceCardIds: [source.id], sourceVersions: [{ cardId: source.id, versionId: getCardVersionId(source) }],
  });
  const draft = await createEditorial(user, { channel: "Оригинал", content });
  const checked = await updateEditorialReadiness(user, draft.id, { action: "check", version: draft.version, revisionId: draft.revisionId });
  assert.equal(checked.check.status, "attention");
  assert.ok(checked.check.findings.some(finding => finding.level === "yellow" && finding.quote.includes("награду")));
});

test("a source remains current throughout its scheduled review day in UTC", async context => {
  const { save } = database(context);
  const user = installPilotFixture().account("demo-pr-midis");
  context.mock.timers.enable({ apis: ["Date"], now: new Date(timestamp) });
  const today = { ...passport, freshness: { nextReviewAt: "2026-11-22" } };
  const yesterday = { ...passport, id: passport.id + "-yesterday", freshness: { nextReviewAt: "2026-11-21" } };
  for (const card of [today, yesterday]) save(TableName.KNOWLEDGE_CARDS, card);
  const content = editorialContentSchema.parse({
    universityId: "midis", title: today.title,
    sourceCardIds: [today.id, yesterday.id],
    sourceVersions: [today, yesterday].map(card => ({ cardId: card.id, versionId: getCardVersionId(card) })),
  });
  const draft = await createEditorial(user, { channel: "Оригинал", content });
  assert.deepEqual((await getEditorialReadiness(user, draft.id)).overdueSources, [yesterday.id]);
});

test("readiness keeps a wrong citation on the cited fragment and accepts the exact source", async context => {
  const { save } = database(context);
  const user = installPilotFixture().account("demo-pr-midis");
  const first = knowledgeSeedCards.find(card => card.id === "project-susu-digital-twin")!;
  const second = knowledgeSeedCards.find(card => card.id === "project-susu-pish-machines")!;
  const sources = [first, second];
  for (const source of sources) save(TableName.KNOWLEDGE_CARDS, source);
  const firstClaim = `Проект «${first.title}»`;
  for (const source of [second, first]) {
    const lead = `${firstClaim}. [${source.id}]`;
    const content = editorialContentSchema.parse({
      universityId: "midis", lead,
      sourceCardIds: sources.map(card => card.id),
      sourceVersions: sources.map(card => ({ cardId: card.id, versionId: getCardVersionId(card) })),
    });
    const draft = await createEditorial(user, { channel: "Оригинал", content });
    const checked = await updateEditorialReadiness(user, draft.id, {
      action: "check", version: draft.version, revisionId: draft.revisionId,
    });
    if (source === second) {
      assert.equal(checked.check.status, "attention");
      assert.ok(checked.check.findings.some(finding => finding.level === "yellow" && finding.quote === lead));
    } else {
      assert.equal(checked.check.status, "passed");
    }
  }
});
