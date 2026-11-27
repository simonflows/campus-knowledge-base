import {
  buildKnowledgeCardsSummaryCsv,
  getKnowledgeCardBackupFileName,
} from "../lib/yandex-disk";
import assert from "node:assert/strict";
import { test } from "node:test";
import { knowledgeSeedCards, type CustomCard } from "../lib/knowledge";
import {
  getCardVersionId,
  describeApprovedCardVersion,
} from "../lib/knowledge-versions";
import {
  OFFICIAL_DOCUMENT_TYPE_ID,
  ROADMAP_INDICATOR_TYPE_ID,
} from "../lib/strategy";
import { createIndicatorConfirmation } from "../lib/strategy-server";
import {
  hydrateCanonicalStrategySources,
  hydrateHistoricalStrategySource,
} from "../lib/strategy-sources";
import {
  sourceDescription,
  strategySourceFacts,
  strategySourceProjection,
} from "../lib/strategy-evidence";
import { buildCanonSources } from "../lib/canon-context";
import { checkEditorialEvidence } from "../lib/editorial-evidence";
import {
  serializeCardForPrompt,
  selectNamedRoadmapIndicators,
  buildDeterministicArticleDraft,
} from "../lib/editor";
import { editorialContentSchema, editorialText } from "../lib/editorial";
import { checkFactText } from "../lib/fact-check";

const doc: CustomCard = {
  ...knowledgeSeedCards[0],
  id: "qa-source120-doc",
  title: "Учебная дорожная карта",
  type: "custom",
  customTypeId: OFFICIAL_DOCUMENT_TYPE_ID,
  customFields: {},
  referenceDescription: "Непроверенное описание не является выдержкой",
  status: "approved",
  officialDocument: {
    kind: "roadmap",
    sourceOrganization: "Учебная организация",
    url: "https://example.com/qa-only",
    date: "2026-10-12",
    edition: "1",
    directions: [],
    clauses: [
      {
        id: "goal",
        locator: "1",
        excerpt: "Предусмотрено создать две учебные площадки",
        kind: "plan",
        directionIds: [],
      },
      {
        id: "fact",
        locator: "2",
        excerpt: "Создано ноль учебных площадок",
        kind: "actual",
        directionIds: [],
      },
    ],
  },
};
const evidence = (clauseId: string) => ({
  document: { cardId: doc.id, versionId: getCardVersionId(doc) },
  clauseId,
});
const indicator: CustomCard = {
  ...knowledgeSeedCards[0],
  id: "qa-source120-indicator",
  title: "Учебные площадки",
  status: "approved",
  type: "custom",
  customTypeId: ROADMAP_INDICATOR_TYPE_ID,
  customFields: { smuggled: "Создано 999 площадок" },
  referenceDescription: "Создано 999 площадок",
  roadmapIndicator: {
    definition: "Количество учебных площадок.",
    unit: "шт.",
    scope: { kind: "campus" },
    relatedCardIds: [],
    plan: { value: 2, date: "2027-12-31", evidence: evidence("goal") },
    actual: { value: 0, date: "2026-10-01", evidence: evidence("fact") },
  },
};
function trusted() {
  return {
    ...indicator,
    indicatorConfirmations: {
      plan: createIndicatorConfirmation(indicator, "plan", "qa"),
      actual: createIndicatorConfirmation(indicator, "actual", "qa"),
    },
  };
}

test("managed evidence fails closed without independent receipts, never trusts raw description/custom fields", () => {
  const projected = hydrateCanonicalStrategySources([doc, indicator]);
  const card = projected.find((c) => c.id === indicator.id)!;
  const prompt = serializeCardForPrompt(card);
  assert.doesNotMatch(prompt, /999|2 шт\.|0 шт\./u);
  assert.ok(
    !buildCanonSources(projected, {})
      .flatMap((s) => s.facts)
      .some((f) => f.text.includes("999"))
  );
  assert.equal(
    checkEditorialEvidence("Создано 999 площадок [qa-source120-indicator]", [
      card,
    ]).canPublish,
    false
  );
  assert.equal(checkFactText("Создано 999 площадок", [card]).summary.green, 0);
  assert.equal(strategySourceProjection(card)?.strategyEvidenceCurrent, false);
});

test("confirmed zero and plan keep unit, scope, date and evidence; source view never changes pinned hash", () => {
  const raw = trusted();
  const original = getCardVersionId(raw);
  const card = hydrateCanonicalStrategySources([doc, raw]).find(
    (c) => c.id === raw.id
  )!;
  assert.equal(getCardVersionId(card), original);
  assert.equal(strategySourceProjection(card)?.strategyEvidenceCurrent, true);
  assert.match(
    sourceDescription(card),
    /0 шт.; факт по состоянию на 2026-10-01/u
  );
  assert.match(
    sourceDescription(card),
    /2 шт.; план к 2027-12-31, не достигнутый результат/u
  );
  const fact = strategySourceFacts(card).find(
    (f) => f.field === "indicator.actual"
  )!;
  assert.equal(
    checkEditorialEvidence(`${fact.text} [${card.id}]`, [card]).canPublish,
    true
  );
  assert.equal(
    checkEditorialEvidence(
      `Показатель «Учебные площадки», кампус «Южный Урал»: 2 шт.; факт по состоянию на 2027-12-31. [${card.id}]`,
      [card]
    ).canPublish,
    false
  );
  const draft = buildDeterministicArticleDraft({
    query: "Подготовь справку об учебных площадках",
    selectedCards: [card],
    matchedArticles: [],
    referenceChunks: [],
  });
  assert.doesNotMatch(JSON.stringify(draft), /999/u);
  assert.match(JSON.stringify(draft), /план к 2027-12-31/u);
  assert.equal(
    checkEditorialEvidence(editorialText(editorialContentSchema.parse(draft)), [
      card,
    ]).canPublish,
    true
  );
});

test("new source approval invalidates dependent evidence; an unapproved edit keeps old approved evidence", () => {
  const raw = trusted();
  const changed = {
    ...doc,
    title: "Новая карта",
    status: "pending" as const,
    approvedSnapshot: doc,
  };
  let card = hydrateCanonicalStrategySources([changed, raw]).find(
    (c) => c.id === raw.id
  )!;
  assert.equal(strategySourceProjection(card)?.strategyEvidenceCurrent, true);
  card = hydrateCanonicalStrategySources([
    { ...changed, status: "approved" as const },
    raw,
  ]).find((c) => c.id === raw.id)!;
  assert.equal(strategySourceProjection(card)?.strategyEvidenceCurrent, false);
  assert.ok(
    !strategySourceFacts(card).some(
      (f) => f.field === "indicator.actual" || f.field === "indicator.plan"
    )
  );
  const version = describeApprovedCardVersion(raw, {
    legacyBaseline: false,
    recordedAt: "2026-11-27",
  });
  const historical = hydrateHistoricalStrategySource(version, [doc]);
  assert.match(sourceDescription(historical), /0 шт./u);
  assert.equal(getCardVersionId(historical), version.id);
});

test("small nonzero values stay nonzero and unsafe magnitudes fail validation", async () => {
  const { roadmapIndicatorDataSchema } = await import("../lib/strategy");
  const tiny: CustomCard = {
    ...indicator,
    roadmapIndicator: {
      ...indicator.roadmapIndicator!,
      actual: { ...indicator.roadmapIndicator!.actual!, value: 1e-13 },
    },
  };
  tiny.indicatorConfirmations = {
    actual: createIndicatorConfirmation(tiny, "actual", "qa"),
  };
  const card = hydrateCanonicalStrategySources([doc, tiny]).find(
    (c) => c.id === tiny.id
  )!;
  assert.match(sourceDescription(card), /0,0000000000001 шт/u);
  assert.equal(
    roadmapIndicatorDataSchema.safeParse({
      ...tiny.roadmapIndicator,
      actual: {
        ...tiny.roadmapIndicator!.actual,
        value: Number.MAX_SAFE_INTEGER + 1,
      },
    }).success,
    false
  );
});

test("Disk CSV points to the same projected indicator backup that gets uploaded", () => {
  const raw = trusted();
  const card = hydrateCanonicalStrategySources([doc, raw]).find(
    (c) => c.id === raw.id
  )!;
  assert.ok(
    buildKnowledgeCardsSummaryCsv(card, [doc, raw]).includes(
      getKnowledgeCardBackupFileName(card)
    )
  );
});

test("future dates are plans; an actual can predate retrospective evidence", async () => {
  const { roadmapIndicatorDataSchema } = await import("../lib/strategy");
  assert.equal(
    roadmapIndicatorDataSchema.safeParse({
      ...indicator.roadmapIndicator,
      actual: { ...indicator.roadmapIndicator!.actual, date: "2099-01-01" },
    }).success,
    false
  );
  assert.equal(
    roadmapIndicatorDataSchema.safeParse({
      ...indicator.roadmapIndicator,
      plan: { ...indicator.roadmapIndicator!.plan, date: "2099-01-01" },
    }).success,
    true
  );
});

test("explicit indicator selection preserves name and university scope without hijacking normal questions", () => {
  const tinyName = { ...indicator, title: "А" };
  const scoped: CustomCard = {
    ...indicator,
    roadmapIndicator: {
      ...indicator.roadmapIndicator!,
      scope: { kind: "university", universityId: "susu" },
    },
  };
  assert.deepEqual(
    selectNamedRoadmapIndicators("Расскажи о роботе KUKA", [tinyName]),
    []
  );
  assert.deepEqual(
    selectNamedRoadmapIndicators("Показатели кампуса, а также роботы KUKA", [
      tinyName,
    ]),
    []
  );
  assert.deepEqual(
    selectNamedRoadmapIndicators(
      "Подготовь справку о показателе «Учебные площадки» ЧелГУ",
      [scoped]
    ),
    []
  );
  assert.deepEqual(
    selectNamedRoadmapIndicators(
      "Подготовь справку о показателе «Учебные площадки» ЮУрГУ",
      [scoped]
    ).map((card) => card.id),
    [scoped.id]
  );
  assert.deepEqual(
    selectNamedRoadmapIndicators(
      "Подготовь справку о показателе Учебные площадки ЮУрГУ",
      [scoped]
    ).map((card) => card.id),
    [scoped.id]
  );
  assert.deepEqual(
    selectNamedRoadmapIndicators(
      "Подготовь справку о показателе «Учебные площадки» ЮУрГУ",
      [indicator]
    ),
    []
  );
});

test("university factual evidence cannot round a legitimate small metric to zero", () => {
  const card = structuredClone(
    knowledgeSeedCards.find((card) => card.type === "university")!
  );
  card.structuredMetrics = [
    {
      id: "tiny-qa",
      label: "Учебное измерение",
      value: 1e-13,
      unit: "мг",
      year: 2026,
      kind: "actual",
      evidenceUrl: "https://example.com/qa",
      verifiedAt: "2026-11-27",
      owner: "Учебный ответственный",
    },
  ];
  const draft = buildDeterministicArticleDraft({
    query: `Показатели ${card.title}`,
    selectedCards: [card],
    matchedArticles: [],
    referenceChunks: [],
  });
  assert.match(JSON.stringify(draft), /0,0000000000001 мг/u);
  const wrong = `МИДиС за 2026 год (факт) — учебное измерение составляет 0 мг. [${card.id}]`;
  assert.equal(
    checkEditorialEvidence(wrong, [{ ...card, universityId: "midis" }])
      .canPublish,
    false
  );
});
