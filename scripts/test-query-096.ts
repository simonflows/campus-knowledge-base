import assert from "node:assert/strict";
import { test } from "node:test";
import candidates from "../data/pilot-0.9.5-candidates.json";
import verification from "../data/pilot-0.9.5-verification.json";
import { buildAnalyticsReport, getAnalyticsExamples } from "../lib/analytics";
import {
  knowledgeSeedCards,
  type KnowledgeCard,
  type LaboratoryCard,
} from "../lib/knowledge";
import {
  getSearchFragment,
  searchKnowledgeCards,
} from "../lib/knowledge-search";
import { selectRelevantCards } from "../lib/editor";

const approvedIds = new Set(verification.approvedIds);
const pilotCards = candidates.cards
  .filter(({ card }) => approvedIds.has(card.id))
  .map(({ card }) => ({ ...card, status: "approved" }) as KnowledgeCard);

test("equipment names and their transliterations constrain the original pilot report", () => {
  assert.equal(pilotCards.length, 16);
  for (const query of [
    "Робот KUKA",
    "KUKA робот",
    "KUKA",
    "робот кука",
    "кука робот",
    "кука",
    "В каких вузах есть робот KUKA?",
  ]) {
    const report = buildAnalyticsReport(query, pilotCards);
    assert.deepEqual(
      report.cards.map(({ id }) => id),
      ["lab-midis-kuka"],
      query
    );
    assert.equal(report.summary.total, 1, query);
    assert.deepEqual(report.summary.universities, ["МИДиС"], query);
  }
});

test("equipment matching generalizes and retains all named terms", () => {
  const lab = pilotCards.find(({ id }) => id === "lab-midis-kuka")!;
  assert.equal(lab.type, "laboratory");
  if (lab.type !== "laboratory") return;
  const other = {
    ...lab,
    id: "test-equipment",
    title: "Стенд проверки приводов",
    referenceDescription: "Стенд для испытаний приводов.",
    equipment: ["Робот FANUC M-20", "Динамометр"],
  };
  for (const query of [
    "робот FANUC",
    "робот Фанук",
    "FANUC M-20",
    "FANUC М-20",
    "Покажи лаборатории с оборудованием FANUC",
    "Лаборатории по роботу FANUC",
  ]) {
    assert.deepEqual(
      buildAnalyticsReport(query, [...pilotCards, other]).cards.map(
        ({ id }) => id
      ),
      [other.id],
      query
    );
  }
  for (const query of [
    "робот FANUC L-55",
    "робот FANUC МГТУ",
    "робот Неведомый",
    "Неведомый",
  ]) {
    assert.equal(
      buildAnalyticsReport(query, [...pilotCards, other]).summary.total,
      0,
      query
    );
  }
});

test("equipment kind and model must be present in the same unit", () => {
  const example = pilotCards.find(({ id }) => id === "lab-midis-kuka")!;
  assert.equal(example.type, "laboratory");
  if (example.type !== "laboratory") return;
  for (const [kind, model, otherKind, otherModel, alias] of [
    ["робот", "KUKA", "контроллер", "FANUC", "кука"],
    ["станок", "OMRON", "датчик", "SIEMENS", "омрон"],
  ]) {
    const title = "Учебный центр: " + kind + " " + model;
    const correct: LaboratoryCard = {
      ...example,
      id: "correct",
      title: "Учебный стенд",
      equipment: [kind + " " + model],
    };
    const differentItems: LaboratoryCard = {
      ...example,
      id: "different",
      title,
      equipment: [kind + " " + otherModel, otherKind + " " + model],
    };
    const cards: KnowledgeCard[] = [differentItems, correct];
    for (const query of [
      kind + " " + model,
      kind + " " + alias,
      "«" + kind + " " + model + "»",
      kind + " «" + model + "»",
    ]) {
      assert.deepEqual(
        buildAnalyticsReport(query, cards).cards.map(({ id }) => id),
        [correct.id],
        query
      );
      assert.deepEqual(
        searchKnowledgeCards(cards, query).map(({ id }) => id),
        [correct.id],
        query
      );
      assert.deepEqual(
        selectRelevantCards(cards, query).map(({ card }) => card.id),
        [correct.id],
        query
      );
    }
    assert.deepEqual(
      buildAnalyticsReport(
        "Лаборатории с оборудованием " + kind + " " + model,
        cards
      ).cards.map(({ id }) => id),
      [correct.id]
    );
  }
});

test("equipment models stay with their kind before or after modifiers", () => {
  const example = pilotCards.find(({ id }) => id === "lab-midis-kuka")!;
  assert.equal(example.type, "laboratory");
  if (example.type !== "laboratory") return;
  const lab = (id: string, equipment: string[]): LaboratoryCard => ({
    ...example,
    id,
    equipment,
    title: "Учебная лаборатория",
    referenceDescription: "Учебная лаборатория приборов.",
    workDirections: [],
    confirmedIndicators: [],
    verifiedFacts: [],
  });
  const cards = [
    lab("crossed", ["Промышленный робот FANUC", "Контроллер KUKA"]),
    lab("different-modifier", ["Учебный робот KUKA", "Промышленный контроллер"]),
    lab("model-after", ["Промышленный робот KUKA", "Контроллер FANUC"]),
    lab("model-before", ["KUKA промышленный робот"]),
    lab("same-field", ["Промышленный робот FANUC, Контроллер KUKA"]),
  ];
  const cases: Array<[string, string[]]> = [
    ["KUKA робот", ["different-modifier", "model-after", "model-before"]],
    ["кука робот", ["different-modifier", "model-after", "model-before"]],
    ["Робот промышленный KUKA", ["model-after", "model-before"]],
    ["КУКА промышленный робот", ["model-after", "model-before"]],
    ["Промышленный робот KUKA", ["model-after", "model-before"]],
    ["Робот KUKA и контроллер FANUC", ["model-after"]],
    ["KUKA робот и FANUC контроллер", ["model-after"]],
  ];
  for (const [query, expected] of cases) {
    assert.deepEqual(
      buildAnalyticsReport(query, cards).cards.map(({ id }) => id).sort(),
      expected,
      "analytics: " + query
    );
    const searchQuery = query.replace(" и ", " ");
    assert.deepEqual(
      searchKnowledgeCards(cards, searchQuery).map(({ id }) => id).sort(),
      expected,
      "search: " + searchQuery
    );
    assert.deepEqual(
      selectRelevantCards(cards, query).map(({ card }) => card.id).sort(),
      expected,
      "editor: " + query
    );
  }
});

test("presence, exclusions and laboratory placement are applied as stated", () => {
  const lab = knowledgeSeedCards.find((card) => card.type === "laboratory")!;
  assert.equal(lab.type, "laboratory");
  if (lab.type !== "laboratory") return;
  const catalog = [
    ...knowledgeSeedCards,
    { ...lab, id: "test-no-partner", partner: "" },
  ];
  const all = buildAnalyticsReport("Все лаборатории", catalog).cards;
  assert.ok(
    all.some(({ partner }) => partner === "—" || /не указан/i.test(partner))
  );
  const without = buildAnalyticsReport(
    "Лаборатории без партнёра",
    catalog
  ).cards;
  assert.ok(without.length > 0 && without.length < all.length);
  assert.ok(
    without.every(
      ({ partner }) => partner === "—" || /не указан/i.test(partner)
    )
  );

  const excluded = buildAnalyticsReport(
    "Лаборатории кроме МИДиС",
    catalog
  ).cards;
  assert.ok(excluded.length > 0 && excluded.length < all.length);
  assert.ok(
    excluded.every(({ universities }) => !universities.includes("МИДиС"))
  );

  const active = buildAnalyticsReport("Действующие лаборатории", catalog).cards;
  assert.ok(active.length > 0 && active.length < all.length);
  assert.ok(active.every(({ contour }) => contour === "Площадка вуза"));

  const planned = buildAnalyticsReport(
    "Не действующие лаборатории",
    catalog
  ).cards;
  assert.equal(planned.length, all.length - active.length);
  assert.ok(
    planned.every(({ contour }) => contour === "УНК кампуса (планируется)")
  );
});

test("ambiguous quantities, years and unsupported negation do not return a broad report", () => {
  for (const query of [
    "Покажи проекты за 2025 год",
    "Покажи 10 проектов",
    "Лаборатории без KUKA",
  ]) {
    const report = buildAnalyticsReport(query, knowledgeSeedCards);
    assert.equal(report.summary.total, 0, query);
    assert.equal(
      Reflect.get(report, "interpretation")?.status,
      "needs-clarification",
      query
    );
  }
  for (const query of ["Покажи", "Действующие лаборатории в УНК кампуса"]) {
    const report = buildAnalyticsReport(query, knowledgeSeedCards);
    assert.equal(report.summary.total, 0, query);
    assert.equal(report.interpretation?.status, "needs-clarification", query);
  }
});

test("a named partner is matched in the partner field, including an unquoted request", () => {
  const lab = pilotCards.find(({ id }) => id === "lab-midis-kuka")!;
  assert.equal(lab.type, "laboratory");
  if (lab.type !== "laboratory") return;
  const match = { ...lab, id: "partner-correct", partner: "ООО «Ромашка»" };
  const distractor = {
    ...lab,
    id: "partner-wrong",
    partner: "ООО «Василёк»",
    equipment: ["Модель Ромашка"],
  };
  for (const query of [
    "Лаборатории с партнёром ООО Ромашка",
    "Лаборатории с партнёром «Ромашка»",
  ]) {
    assert.deepEqual(
      buildAnalyticsReport(query, [distractor, match]).cards.map(
        ({ id }) => id
      ),
      [match.id],
      query
    );
  }
});

test("examples can all be run against the same supplied approved cards", () => {
  const examples = getAnalyticsExamples(pilotCards);
  assert.ok(examples.length >= 3 && examples.length <= 5);
  for (const query of examples) {
    const report = buildAnalyticsReport(query, pilotCards);
    assert.equal(report.interpretation?.status, "ready", query);
    assert.ok(report.summary.total > 0, query);
  }
  assert.deepEqual(getAnalyticsExamples([]), []);
  assert.deepEqual(
    getAnalyticsExamples(
      pilotCards.map((card) => ({ ...card, status: "pending" as const }))
    ),
    []
  );
});

test("an approved 'not established' partner field behaves like absence", () => {
  assert.deepEqual(
    buildAnalyticsReport("Лаборатории KUKA с партнёром", pilotCards).cards,
    []
  );
  const without = buildAnalyticsReport(
    "Лаборатории KUKA без партнёра",
    pilotCards
  );
  assert.deepEqual(
    without.cards.map((row) => row.id),
    ["lab-midis-kuka"]
  );
  assert.deepEqual(without.summary.partners, []);
});

test("joint university alternatives remain OR and independent roles require clarification", () => {
  const base = knowledgeSeedCards.find((card) => card.type === "project")!;
  assert.equal(base.type, "project");
  if (base.type !== "project") return;
  const projects: KnowledgeCard[] = [
    {
      ...base,
      id: "or-midis",
      coExecutors: [],
      initiatorUniversityId: "midis",
      isJoint: true,
      participantUniversityIds: ["midis", "csu"],
    },
    {
      ...base,
      id: "or-susu",
      coExecutors: [],
      initiatorUniversityId: "susu",
      isJoint: true,
      participantUniversityIds: ["susu", "csu"],
    },
    {
      ...base,
      id: "and-both",
      coExecutors: [],
      initiatorUniversityId: "midis",
      isJoint: true,
      participantUniversityIds: ["midis", "susu"],
    },
  ];
  assert.deepEqual(
    buildAnalyticsReport("Совместные проекты МИДиС или ЮУрГУ", projects)
      .cards.map(({ id }) => id)
      .sort(),
    ["and-both", "or-midis", "or-susu"]
  );
  assert.deepEqual(
    buildAnalyticsReport(
      "Совместные проекты МИДиС и ЮУрГУ",
      projects
    ).cards.map(({ id }) => id),
    ["and-both"]
  );
  assert.deepEqual(
    buildAnalyticsReport("Проекты МИДиС с ЮУрГУ", projects).cards.map(
      ({ id }) => id
    ),
    ["and-both"]
  );
  for (const query of [
    "Проекты МИДиС от ЮУрГУ",
    "Все проекты, кроме действующих лабораторий",
  ]) {
    const report = buildAnalyticsReport(query, [...projects, ...pilotCards]);
    assert.equal(report.summary.total, 0, query);
    assert.equal(report.interpretation?.status, "needs-clarification", query);
  }
});

test("search ranks structured matches, resolves letter aliases and skips URL/stop-formula mentions", () => {
  const lab = pilotCards.find(({ id }) => id === "lab-midis-kuka")!;
  const distractor = {
    ...lab,
    id: "test-unrelated",
    title: "Центр мягких материалов",
    stopFormula: "Не утверждать, что здесь установлен робот KUKA.",
    referenceDescription: "Справка: https://example.test/robot-kuka",
    equipment: ["Пресс"],
    placementDetails: "Площадка университета",
  } as KnowledgeCard;
  for (const query of ["робот кука", "KUKA", "робот, КУКА"]) {
    assert.deepEqual(
      searchKnowledgeCards([distractor, lab], query).map(({ id }) => id),
      [lab.id],
      query
    );
    assert.match(getSearchFragment(lab, query), /KUKA/iu, query);
  }
  const withProseOnly = {
    ...distractor,
    referenceDescription: "Робот KUKA передан для испытаний.",
  };
  assert.deepEqual(
    searchKnowledgeCards([withProseOnly, lab], "робот KUKA").map(
      ({ id }) => id
    ),
    [lab.id, distractor.id]
  );
});
