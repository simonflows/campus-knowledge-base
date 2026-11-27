import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAnalyticsReport } from "../lib/analytics";
import { knowledgeSeedCards, type CustomCard } from "../lib/knowledge";
import { getCardVersionId } from "../lib/knowledge-versions";
import {
  OFFICIAL_DOCUMENT_TYPE_ID,
  ROADMAP_INDICATOR_TYPE_ID,
  type OfficialDocumentData,
  type StrategyLink,
} from "../lib/strategy";
import * as analyticsValidation from "../lib/validation/analytics";

const documentData: OfficialDocumentData = {
  kind: "roadmap",
  sourceOrganization: "Учебная организация",
  url: "https://example.com/qa-strategy",
  date: "2026-09-01",
  edition: "Редакция 1",
  directions: [
    { id: "facilities", title: "Площадки" },
    { id: "staff", title: "Сотрудники" },
  ],
  clauses: [
    {
      id: "plan",
      locator: "1.1",
      excerpt: "План площадок",
      directionIds: ["facilities"],
      kind: "plan",
    },
    {
      id: "actual",
      locator: "1.2",
      excerpt: "Результат площадок",
      directionIds: ["facilities"],
      kind: "actual",
    },
    {
      id: "staff-plan",
      locator: "2.1",
      excerpt: "План сотрудников",
      directionIds: ["staff"],
      kind: "plan",
    },
  ],
};

const document: CustomCard = {
  ...knowledgeSeedCards[0],
  type: "custom",
  status: "approved",
  id: "qa-roadmap",
  title: "Учебная дорожная карта",
  customTypeId: OFFICIAL_DOCUMENT_TYPE_ID,
  referenceDescription: "Сырое описание документа",
  customFields: {},
  officialDocument: documentData,
};
const documentRef = {
  cardId: document.id,
  versionId: getCardVersionId(document),
};
const planEvidence = { document: documentRef, clauseId: "plan" };
const actualEvidence = { document: documentRef, clauseId: "actual" };
const project = knowledgeSeedCards.find(
  (card) => card.id === "project-susu-digital-twin"
);
assert.ok(project?.type === "project");

const makeProject = (id: string, link: StrategyLink) => ({
  ...project,
  id,
  title: id,
  strategyLinks: [link],
});
const byClause = makeProject("qa-project-clause", {
  document: documentRef,
  clauseId: "plan",
  explanation: "По пункту",
  evidence: planEvidence,
});
const byDirection = makeProject("qa-project-direction", {
  document: documentRef,
  directionId: "facilities",
  explanation: "По направлению",
  evidence: planEvidence,
});
const unrelated = makeProject("qa-project-unrelated", {
  document: documentRef,
  directionId: "staff",
  explanation: "Другое направление",
  evidence: { document: documentRef, clauseId: "staff-plan" },
});
const draft = {
  ...byClause,
  id: "qa-draft-project",
  status: "pending" as const,
  title: "Закрытый проект",
};

const indicator: CustomCard = {
  ...knowledgeSeedCards[0],
  id: "qa-indicator",
  title: "Работающие площадки",
  status: "approved",
  type: "custom",
  customTypeId: ROADMAP_INDICATOR_TYPE_ID,
  customFields: { rawIndicatorSecret: "Сырое поле показателя" },
  referenceDescription: "Сырое описание показателя",
  roadmapIndicator: {
    definition: "Число действующих площадок",
    unit: "площадок",
    scope: { kind: "campus" },
    relatedCardIds: [byClause.id],
    actual: { value: 0, date: "2026-09-30", evidence: actualEvidence },
  },
};

const query = {
  mode: "strategy" as const,
  documentId: document.id,
  documentVersionId: documentRef.versionId,
};

async function loadReportBuilder() {
  return (
    await import("../lib/strategy-analytics").catch((error) => {
      assert.equal(error.code, "ERR_MODULE_NOT_FOUND");
      assert.fail("Стратегическая выборка пока отсутствует");
    })
  ).buildStrategyAnalyticsReport;
}

test("направление включает прямую связь и принадлежащую направлению выдержку, пункт — только точную связь", async () => {
  const buildReport = await loadReportBuilder();
  const cards = [document, byClause, byDirection, unrelated, draft];
  const direction = buildReport(
    { ...query, target: { kind: "direction", id: "facilities" } },
    cards
  );
  const clause = buildReport(
    { ...query, target: { kind: "clause", id: "plan" } },
    cards
  );
  assert.deepEqual(
    direction?.projects.map((item) => item.card.cardId),
    [byClause.id, byDirection.id]
  );
  assert.deepEqual(
    clause?.projects.map((item) => item.card.cardId),
    [byClause.id]
  );
});

test("подтверждённый ноль, неизвестный план и устаревший факт различимы в справке", async () => {
  const buildReport = await loadReportBuilder();
  const { createIndicatorConfirmation } =
    await import("../lib/strategy-server");
  const confirmedIndicator = {
    ...indicator,
    indicatorConfirmations: {
      actual: createIndicatorConfirmation(
        indicator,
        "actual",
        "qa-coordinator"
      ),
    },
  };
  const pendingDocument = {
    ...document,
    title: "Закрытый черновик документа",
    status: "pending" as const,
    approvedSnapshot: document,
  };
  const current = buildReport(query, [
    pendingDocument,
    byClause,
    confirmedIndicator,
  ]);
  assert.equal(current?.indicators[0]?.plan.status, "missing");
  const actual = current?.indicators[0]?.actual;
  assert.equal(actual?.status, "confirmed");
  if (actual?.status !== "confirmed")
    assert.fail("Ноль должен быть подтверждён");
  assert.deepEqual(actual.source.card, {
    ...documentRef,
    title: document.title,
  });
  assert.equal(actual.value, 0);
  assert.equal(actual.date, "2026-09-30");
  assert.equal(
    current?.indicators[0]?.card.versionId,
    getCardVersionId(indicator)
  );
  assert.doesNotMatch(
    JSON.stringify(current),
    /Сырое|Закрытый|fingerprint|qa-coordinator/
  );

  const revised = {
    ...document,
    officialDocument: { ...documentData, edition: "Редакция 2" },
  };
  const stale = buildReport(
    { ...query, documentVersionId: getCardVersionId(revised) },
    [revised, byClause, confirmedIndicator]
  );
  assert.deepEqual(stale?.indicators[0]?.actual, { status: "stale" });
  assert.equal(stale?.projects[0]?.status, "stale");
  assert.equal(
    buildReport(query, [revised, byClause, confirmedIndicator]),
    null
  );
});

test("неутверждённый документ и неизвестный объект фильтра дают одинаковый пустой ответ", async () => {
  const buildReport = await loadReportBuilder();
  assert.equal(buildReport(query, [{ ...document, status: "pending" }]), null);
  assert.equal(
    buildReport({ ...query, target: { kind: "direction", id: "unknown" } }, [
      document,
    ]),
    null
  );
});

test("неподтверждённый слот не влияет на выборку и не показывает число у связанного показателя", async () => {
  const buildReport = await loadReportBuilder();
  assert.deepEqual(buildReport(query, [document, indicator])?.indicators, []);
  const report = buildReport(query, [document, byClause, indicator]);
  assert.deepEqual(report?.indicators[0]?.actual, { status: "missing" });
});

test("неоднозначные или повреждённые фильтры отклоняются даже при наличии текстового запроса", () => {
  assert.ok(
    "analyticsRequestSchema" in analyticsValidation,
    "Стратегическая схема пока отсутствует"
  );
  const schema = analyticsValidation.analyticsRequestSchema;
  assert.equal(
    schema.safeParse({
      ...query,
      documentVersionId: "latest",
      query: "Покажи проекты",
    }).success,
    false
  );
  assert.equal(
    schema.safeParse({
      ...query,
      target: { kind: "clause", id: "plan", directionId: "facilities" },
    }).success,
    false
  );
  assert.equal(
    schema.safeParse({
      ...query,
      target: { kind: "direction", id: "../strategy" },
    }).success,
    false
  );
  assert.equal(
    schema.safeParse({
      ...query,
      target: { kind: "direction", id: "facilities" },
    }).success,
    true
  );
  assert.deepEqual(
    schema.parse({ query: "  Покажи проекты  ", flashAssist: true }),
    {
      query: "Покажи проекты",
      flashAssist: true,
    }
  );
  assert.equal(
    buildAnalyticsReport("Покажи проекты", [byClause], []).summary.total,
    1
  );
});
