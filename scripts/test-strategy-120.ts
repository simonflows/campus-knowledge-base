import assert from "node:assert/strict";
import { test } from "node:test";
import { knowledgeSeedCards, type CustomCard } from "../lib/knowledge";
import { getCardVersionId } from "../lib/knowledge-versions";
import {
  OFFICIAL_DOCUMENT_TYPE_ID,
  ROADMAP_INDICATOR_TYPE_ID,
  officialDocumentDataSchema,
  roadmapIndicatorDataSchema,
} from "../lib/strategy";
import { validateKnownStrategyReferences } from "../lib/strategy-server";
import { knowledgeCardInputSchema } from "../lib/validation/knowledge";

test("обычный пользовательский тип не принимает данные встроенного документа", () => {
  const input = {
    title: "Учебная запись",
    owners: ["Учебный владелец"],
    type: "custom",
    customTypeId: "ordinary-custom",
    officialDocument: {
      kind: "roadmap",
      sourceOrganization: "Учебная организация",
      url: "https://example.com/qa",
      date: "2026-10-12",
      edition: "1",
      directions: [],
      clauses: [],
    },
  };
  assert.equal(knowledgeCardInputSchema.safeParse(input).success, false);
});

test("показатель сохраняет ноль отдельно от отсутствующих данных", () => {
  const valid = {
    definition: "Количество оборудованных площадок",
    unit: "шт.",
    scope: { kind: "campus" },
    relatedCardIds: [],
    plan: {
      value: 0,
      date: "2026-10-12",
      evidence: {
        document: { cardId: "qa-document", versionId: `cv-${"a".repeat(64)}` },
        clauseId: "goal",
      },
    },
  };
  const indicator = roadmapIndicatorDataSchema.parse(valid);
  assert.equal(indicator.plan?.value, 0);
  assert.equal(indicator.actual, undefined);
  assert.equal(
    roadmapIndicatorDataSchema.safeParse({
      ...valid,
      actual: { ...valid.plan, value: null },
    }).success,
    false
  );
});

test("выдержка документа ссылается на существующие направления", () => {
  const doc = {
    kind: "roadmap",
    sourceOrganization: "Учебная организация",
    url: "https://example.com/qa-roadmap",
    date: "2026-10-12",
    edition: "Редакция 1",
    directions: [{ id: "lab", title: "Инфраструктура" }],
    clauses: [
      {
        id: "goal",
        locator: "1.2",
        excerpt: "План на период",
        kind: "plan",
        directionIds: ["lab"],
      },
    ],
  };
  assert.equal(officialDocumentDataSchema.safeParse(doc).success, true);
  assert.equal(
    officialDocumentDataSchema.safeParse({ ...doc, directions: [] }).success,
    false
  );
  assert.equal(
    officialDocumentDataSchema.safeParse({
      ...doc,
      clauses: [...doc.clauses, ...doc.clauses],
    }).success,
    false
  );
});

test("документ плана нельзя принять как подтверждение факта", () => {
  const document: CustomCard = {
    ...knowledgeSeedCards[0],
    id: "document",
    type: "custom",
    customTypeId: OFFICIAL_DOCUMENT_TYPE_ID,
    customFields: {},
    officialDocument: {
      kind: "roadmap",
      sourceOrganization: "Учебная организация",
      url: "https://example.com/qa",
      date: "2026-10-12",
      edition: "1",
      directions: [],
      clauses: [
        {
          id: "goal",
          locator: "1",
          excerpt: "Запланировано",
          kind: "plan",
          directionIds: [],
        },
      ],
    },
  };
  const indicator: CustomCard = {
    ...knowledgeSeedCards[0],
    id: "indicator",
    type: "custom",
    customTypeId: ROADMAP_INDICATOR_TYPE_ID,
    customFields: {},
    roadmapIndicator: {
      definition: "Учебное определение",
      unit: "шт.",
      scope: { kind: "campus" },
      relatedCardIds: [],
      actual: {
        value: 0,
        date: "2026-10-01",
        evidence: {
          document: {
            cardId: document.id,
            versionId: getCardVersionId(document),
          },
          clauseId: "goal",
        },
      },
    },
  };
  assert.throws(
    () =>
      validateKnownStrategyReferences(
        indicator,
        new Map([[document.id, document]])
      ),
    /подтверждающую факт/
  );
});

test("прежний хеш карточки сохраняется без связи и при пустом блоке связей", () => {
  const card = knowledgeSeedCards.find(
    (item) => item.id === "project-susu-digital-twin"
  )!;
  const oldVersionId =
    "cv-9a555de8ed97ab9ce55107e3004dbfa38017afcd2541e7f9760a3f7e2eedb5e6";
  assert.equal(getCardVersionId(card), oldVersionId);
  assert.equal(getCardVersionId({ ...card, strategyLinks: [] }), oldVersionId);
});
