import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAnalyticsWithAi,
  type AnalyticsSnapshot,
} from "../lib/canon-analytics-ai";
import { buildAnalyticsReport } from "../lib/analytics";
import { currentCanonSources } from "../lib/canon-ai";
import candidates from "../data/pilot-0.9.5-candidates.json";
import verification from "../data/pilot-0.9.5-verification.json";
import type { CanonSource } from "../lib/canon-context";
import type { askFlash } from "../lib/flash-assist";
import { knowledgeSeedCards } from "../lib/knowledge";
import type { KnowledgeCard } from "../lib/knowledge";

const request = new Request("https://canon.example.test/api/analytics", {
  method: "POST",
});
const profile = "fixture-staff";
const passport = knowledgeSeedCards.find(
  (card) => card.type === "university" && card.universityId === "midis"
);
const project = knowledgeSeedCards.find(
  (card) => card.id === "joint-midis-susmu-trauma"
);
const lab = knowledgeSeedCards.find((card) => card.type === "laboratory");
assert.ok(
  passport?.type === "university" &&
    project?.type === "project" &&
    lab?.type === "laboratory"
);

const fixture: AnalyticsSnapshot = {
  cards: [
    passport,
    { ...project, title: "Вуз МИДиС — учебный проект" },
    { ...lab, equipment: ["Учебный робот KUKA", "Робот FANUC"] },
  ],
  types: [],
};

const institutionQuery = "Покажи вуз МИДиС";
const passportQuery = "Покажи паспорт вуза МИДиС";

type ModelInput = {
  canonicalPlan?: { query: string | null; allowedSourceIds: string[] };
  sources: CanonSource[];
};

function candidate(
  query: string | null,
  clarification: string | null = null,
  quotes: unknown[] = []
) {
  return { query, clarification, quotes };
}

async function runCandidate(
  query: string,
  snapshot: AnalyticsSnapshot,
  output: unknown
) {
  const result = await buildAnalyticsWithAi({
    request,
    accountId: profile,
    query,
    snapshot,
    loadCurrent: async () => snapshot,
    ask: async () => ({ status: "ready", output }),
  });
  assert.ok(result);
  return result;
}

function assertOrdinaryReport(
  result: Awaited<ReturnType<typeof runCandidate>>,
  ordinary: ReturnType<typeof buildAnalyticsReport>
) {
  assert.equal(result.query, ordinary.query);
  assert.deepEqual(
    result.cards.map((card) => card.id),
    ordinary.cards.map((card) => card.id)
  );
  assert.deepEqual(result.summary, ordinary.summary);
  assert.deepEqual(result.filters, ordinary.filters);
  assert.deepEqual(result.interpretation, ordinary.interpretation);
  assert.equal(result.ai.appliedQuery, undefined);
  assert.ok(result.ai.clarification);
}

async function run(
  query: string,
  ask: typeof askFlash,
  loadCurrent: () => Promise<AnalyticsSnapshot> = async () => fixture
) {
  const result = await buildAnalyticsWithAi({
    request,
    accountId: profile,
    query,
    snapshot: fixture,
    loadCurrent,
    ask,
  });
  assert.ok(result);
  return result;
}

test("one model interpretation can change report rows to a university passport", async () => {
  const original = buildAnalyticsReport(
    institutionQuery,
    fixture.cards,
    fixture.types
  );
  assert.ok(original.cards.some((card) => card.id === project.id));
  let calls = 0;
  let modelInstruction = "";
  let modelInput: ModelInput | undefined;
  const result = await run(
    institutionQuery,
    async (_request, actor, instruction, input) => {
      calls++;
      modelInstruction = instruction;
      const data: ModelInput & {
        query: string;
        criteria: { usesDefaultCardTypes: boolean };
      } = JSON.parse(input);
      modelInput = data;
      assert.equal(actor, profile);
      assert.equal(data.query, institutionQuery);
      assert.equal(data.criteria.usesDefaultCardTypes, true);
      const source = data.sources.find((item) => item.cardId === passport.id);
      assert.ok(source);
      const fact = source.facts.find((f) => f.field === "referenceDescription");
      assert.ok(fact);
      return {
        status: "ready",
        output: candidate(passportQuery, null, [
          {
            sourceId: source.id,
            factId: fact.id,
          },
        ]),
      };
    },
    async () => ({ ...fixture, cards: [...fixture.cards].reverse() })
  );
  assert.equal(calls, 1);
  assert.equal(result.ai.originalQuery, institutionQuery);
  assert.equal(result.ai.appliedQuery, passportQuery);
  assert.deepEqual(
    result.cards.map((card) => card.id),
    [passport.id]
  );
  assert.equal(result.summary.projects, 0);
  const source = currentCanonSources(fixture.cards).find((item) => item.cardId === passport.id)!;
  const fact = source.facts.find(({ field }) => field === "referenceDescription")!;
  assert.equal(result.ai.citations[0]?.versionId, source.versionId);
  assert.equal(result.ai.citations[0]?.quote, fact.text);
  assert.deepEqual(modelInput?.canonicalPlan, { query: passportQuery, allowedSourceIds: [source.id] });
  assert.deepEqual(modelInput?.sources.map((item) => item.cardId), [passport.id]);
  assert.match(modelInstruction, /сервер сам рассчитывает числа/i);
  assert.match(modelInstruction, /JSON null без кавычек/u);
  assert.match(modelInstruction, /"sourceId":"s1","factId":"f1"\}/);
  assert.equal(result.ai.citations[0]?.href, result.cards[0].sourceHref);
  assert.match(result.cards[0].sourceHref, /&version=cv-[a-f0-9]{64}$/);
});

test("an already recognized equipment query sends its exact wording and only the selected laboratory", async () => {
  const ids = new Set(verification.approvedIds);
  const cards = candidates.cards
    .filter(({ card }) => ids.has(card.id))
    .map(({ card }) => ({ ...card, status: "approved" }) as KnowledgeCard);
  const snapshot = { cards, types: [] };
  const query = "робот кука";
  const source = currentCanonSources(cards).find(({ cardId }) => cardId === "lab-midis-kuka")!;
  const fact = source.facts.find(({ field, text }) => field.startsWith("equipment.") && /KUKA/i.test(text))!;
  const captured: { payload?: ModelInput } = {};
  const result = await buildAnalyticsWithAi({
    request, accountId: profile, query, snapshot, loadCurrent: async () => snapshot,
    ask: async (_request, _actor, _instruction, input) => {
      captured.payload = JSON.parse(input);
      return { status: "ready", output: candidate(query, null, [{ sourceId: source.id, factId: fact.id }]) };
    },
  });
  assert.deepEqual(captured.payload?.canonicalPlan, { query, allowedSourceIds: [source.id] });
  assert.deepEqual(captured.payload?.sources.map(({ cardId }) => cardId), [source.cardId]);
  assert.equal(result?.ai.status, "ready");
  assert.equal(result.ai.citations[0]?.quote, fact.text);
  assert.equal(result.ai.appliedQuery, undefined);
});

test("a deterministic passport plan also works for a different university", async () => {
  const other = knowledgeSeedCards.find(({ id }) => id === "university-susu")!;
  const snapshot = { ...fixture, cards: [...fixture.cards, other] };
  const query = "Покажи университет ЮУрГУ";
  const expected = "Покажи паспорт вуза ЮУрГУ";
  const source = currentCanonSources(snapshot.cards).find(({ cardId }) => cardId === other.id)!;
  const captured: { payload?: ModelInput } = {};
  const result = await buildAnalyticsWithAi({
    request, accountId: profile, query, snapshot, loadCurrent: async () => snapshot,
    ask: async (_request, _actor, _instruction, input) => {
      captured.payload = JSON.parse(input);
      return { status: "ready", output: candidate(expected) };
    },
  });
  assert.deepEqual(captured.payload?.canonicalPlan, { query: expected, allowedSourceIds: [source.id] });
  assert.deepEqual(captured.payload?.sources.map(({ cardId }) => cardId), [other.id]);
  assert.equal(result?.ai.appliedQuery, expected);
});

test("unsupported analytics conditions get a clarification-only plan without facts", async () => {
  const query = "Покажи лаборатории KUKA после 2024 года";
  const captured: { payload?: ModelInput } = {};
  const result = await run(query, async (_request, _actor, _instruction, input) => {
    captured.payload = JSON.parse(input);
    return { status: "ready", output: candidate(null, "period") };
  });
  assert.deepEqual(captured.payload?.canonicalPlan, { query: null, allowedSourceIds: [] });
  assert.deepEqual(captured.payload?.sources, []);
  assert.match(result.ai.clarification ?? "", /период/i);
  assert.deepEqual(result.cards, []);
});

test("an unseen citation invalidates the whole model response even for an unchanged report", async () => {
  const source = currentCanonSources(fixture.cards).find(({ cardId }) => cardId === project.id)!;
  const result = await runCandidate(institutionQuery, fixture, candidate(institutionQuery, null, [{
    sourceId: source.id, factId: source.facts[0].id,
  }]));
  assert.equal(result.ai.status, "failed");
  assert.deepEqual(result.ai.citations, []);
  assert.equal(result.ai.appliedQuery, undefined);
  assert.ok(result.cards.some(({ id }) => id === project.id));
});

test("the model cannot echo an ordinary zero-row query instead of the proven passport plan", async () => {
  const snapshot = { cards: [passport], types: [] };
  const ordinary = buildAnalyticsReport(institutionQuery, snapshot.cards);
  assert.deepEqual(ordinary.cards, []);
  for (const proposed of [institutionQuery, ` ${passportQuery} `]) {
    const result = await runCandidate(institutionQuery, snapshot, candidate(proposed));
    assert.equal(result.ai.status, "failed");
    assertOrdinaryReport(result, ordinary);
  }
});

test("a clarification-only plan rejects a non-null echo, even when it would keep empty rows", async () => {
  const snapshot = { cards: [passport], types: [] };
  const query = "Робот FANUC";
  const ordinary = buildAnalyticsReport(query, snapshot.cards);
  assert.deepEqual(ordinary.cards, []);
  const result = await runCandidate(query, snapshot, candidate(query));
  assert.equal(result.ai.status, "failed");
  assertOrdinaryReport(result, ordinary);
});

test("a model clarification must not arrive with citations", async () => {
  const source = currentCanonSources(fixture.cards).find(({ cardId }) => cardId === passport.id)!;
  const result = await runCandidate(institutionQuery, fixture, candidate(null, "university", [{
    sourceId: source.id, factId: source.facts[0].id,
  }]));
  assert.equal(result.ai.status, "failed");
  assert.deepEqual(result.ai.citations, []);
  assert.equal(result.ai.clarification, undefined);
  assert.ok(result.cards.some(({ id }) => id === project.id));
});

test("the approved MIDIS passport can be cited by its complete short university field", async () => {
  const ids = new Set(verification.approvedIds);
  const cards = candidates.cards
    .filter(({ card }) => ids.has(card.id))
    .map(({ card }) => ({ ...card, status: "approved" }) as KnowledgeCard);
  assert.equal(cards.length, 16);
  const snapshot = { cards, types: [] };
  const source = currentCanonSources(cards).find(({ cardId }) => cardId === passport.id)!;
  const short = source.facts.find(({ field }) => field === "universityId")!;
  const long = source.facts.find(({ field }) => field === "referenceDescription")!;
  assert.equal(short.text, "МИДиС");
  assert.ok(long.text.includes(short.text) && long.text.length > 8);
  const exact = { sourceId: source.id, factId: short.id, quote: " МИДиС " };
  const result = await runCandidate(
    institutionQuery, snapshot, candidate(passportQuery, null, [exact])
  );
  assert.equal(result.ai.status, "ready");
  assert.equal(result.ai.appliedQuery, passportQuery);
  assert.deepEqual(result.ai.citations.map(({ cardId, field, quote, versionId }) =>
    [cardId, field, quote, versionId]), [[passport.id, "universityId", "МИДиС", source.versionId]]);
  const fragment = await runCandidate(
    institutionQuery, snapshot, candidate(passportQuery, null, [{ ...exact, factId: long.id }])
  );
  assert.equal(fragment.ai.status, "failed");
  assert.deepEqual(fragment.ai.citations, []);
  assert.deepEqual(fragment.cards, buildAnalyticsReport(institutionQuery, cards).cards);
});

test("a model clarification or rejected rewrite leaves the proven KUKA report visible", async () => {
  const ids = new Set(verification.approvedIds);
  const cards = candidates.cards
    .filter(({ card }) => ids.has(card.id))
    .map(({ card }) => ({ ...card, status: "approved" }) as KnowledgeCard);
  const snapshot = { cards, types: [] };
  const query = "Робот KUKA";
  const ordinary = buildAnalyticsReport(query, cards);
  assert.deepEqual(
    ordinary.cards.map((card) => card.id),
    ["lab-midis-kuka"]
  );
  assert.equal(ordinary.interpretation?.status, "ready");
  for (const output of [
    candidate(null, "equipment"),
    candidate("Покажи лаборатории"),
  ]) {
    assertOrdinaryReport(await runCandidate(query, snapshot, output), ordinary);
  }
});

test("a lexically equivalent rewrite cannot substitute different named rows", async () => {
  const base = {
    ...lab,
    title: "Стенд учебной метрологии",
    referenceDescription: "Стенд учебной метрологии.",
    workDirections: ["Методика измерений"],
    confirmedIndicators: [],
    stopFormula: "",
  };
  for (const [noun, originalName, candidateName, equipment, replacements] of [
    ["Робот", "Фанука", "Фанук", "FANUKA", ["FANUK", "FANUC"]],
    ["Станок", "Вердина", "Вердин", "VERDINA", ["VERDIN"]],
  ] as const) {
    const snapshot = {
      cards: [
        { ...base, id: "held-source", equipment: [noun + " " + equipment] },
        ...replacements.map((name, index) => ({
          ...base,
          id: "other-" + index,
          equipment: [noun + " " + name],
        })),
      ],
      types: [],
    };
    const query = noun + " " + originalName;
    const proposed = noun + " " + candidateName;
    const ordinary = buildAnalyticsReport(query, snapshot.cards);
    const substituted = buildAnalyticsReport(proposed, snapshot.cards);
    assert.deepEqual(
      ordinary.cards.map((card) => card.id),
      ["held-source"]
    );
    assert.deepEqual(
      substituted.cards.map((card) => card.id).sort(),
      replacements.map((_, index) => "other-" + index)
    );
    assertOrdinaryReport(
      await runCandidate(query, snapshot, candidate(proposed)),
      ordinary
    );
  }
});

test("missing KUKA/FANUC, equipment scope, or a quoted phrase cannot broaden a report", async () => {
  for (const [original, proposed] of [
    [
      "Покажи лаборатории с оборудованием KUKA и FANUC",
      "Покажи лаборатории с оборудованием KUKA",
    ],
    [
      "Покажи лаборатории с оборудованием KUKA и FANUC",
      "Покажи лаборатории KUKA и FANUC",
    ],
    [
      "Покажи лаборатории с оборудованием «робот FANUC»",
      "Покажи лаборатории с оборудованием робот и FANUC",
    ],
    [
      "Покажи лаборатории с оборудованием KUKA",
      "Покажи лаборатории с оборудованием KUKA или FANUC",
    ],
    [
      "Покажи лаборатории с оборудованием KUKA",
      "Покажи лаборатории с оборудованием FANUC",
    ],
  ]) {
    const result = await run(original, async () => ({
      status: "ready",
      output: candidate(proposed),
    }));
    assertOrdinaryReport(
      result,
      buildAnalyticsReport(original, fixture.cards, fixture.types)
    );
  }
  const exactQuery = "Покажи лаборатории с оборудованием KUKA и FANUC";
  const equivalent = await run(
    exactQuery,
    async () => ({
      status: "ready",
      output: candidate("Покажи лаборатории с оборудованием кука и FANUC"),
    })
  );
  assertOrdinaryReport(equivalent, buildAnalyticsReport(exactQuery, fixture.cards, fixture.types));
  assert.equal(equivalent.ai.status, "failed");
  const exact = await runCandidate(exactQuery, fixture, candidate(exactQuery));
  assert.deepEqual(exact.cards.map(({ id }) => id), [lab.id]);
  assert.equal(exact.ai.status, "ready");
});

test("unknown industry, lost negation, changed explicit filters and unsupported logic require clarification", async () => {
  for (const [original, proposed] of [
    ["Покажи проекты в сфере квантофермы", "Покажи проекты"],
    ["Покажи не действующие лаборатории", "Покажи действующие лаборатории"],
    ["Покажи проекты МИДиС в контуре кампус", "Покажи проекты МИДиС"],
    ["Покажи проекты МИДиС", "Покажи проекты ЮУрГУ"],
    ["Покажи проекты МИДиС", "Покажи паспорта вуза МИДиС"],
    ["Покажи МИДиС", passportQuery],
    ["Покажи проекты KUKA или FANUC", "Покажи проекты KUKA и FANUC"],
    ["Покажи лаборатории KUKA после 2024 года", "Покажи лаборатории KUKA"],
  ]) {
    const result = await run(original, async () => ({
      status: "ready",
      output: candidate(proposed),
    }));
    const ordinary = buildAnalyticsReport(
      original,
      fixture.cards,
      fixture.types
    );
    if (/квантофермы| или | после /u.test(original)) {
      assert.equal(ordinary.summary.total, 0, original);
      assert.equal(
        ordinary.interpretation?.status,
        "needs-clarification",
        original
      );
    }
    assertOrdinaryReport(result, ordinary);
  }
});

test("references must name an exact field from the selected report rows", async () => {
  for (const kind of ["unknown-source", "unknown-fact", "outside-report", "rewritten-quote"]) {
    const sources = currentCanonSources(fixture.cards);
    const visible = sources.find(({ cardId }) => cardId === passport.id)!;
    const source = kind === "outside-report" ? sources.find(({ cardId }) => cardId === project.id)! : visible;
    const fact = source.facts.find(({ field }) => field === "referenceDescription")!;
    const result = await runCandidate(institutionQuery, fixture, candidate(passportQuery, null, [
      { sourceId: visible.id, factId: visible.facts[0].id },
      {
        sourceId: kind === "unknown-source" ? "forged-source" : source.id,
        factId: kind === "unknown-fact" ? "forged-fact" : fact.id,
        ...(kind === "rewritten-quote" && { quote: "В источнике нет этой вымышленной фразы." }),
      },
    ]));
    assert.equal(result.ai.status, "failed");
    assert.deepEqual(result.ai.citations, []);
    assert.equal(result.ai.appliedQuery, undefined);
    assert.ok(result.cards.some((card) => card.id === project.id));
  }
});

test("an ID-only reference cannot add a citation to an empty report", async () => {
  const query = "Робот PANASONIC";
  const source = currentCanonSources(fixture.cards).find(({ cardId }) => cardId === lab.id)!;
  const fact = source.facts.find(({ field }) => field.startsWith("equipment."))!;
  assert.equal(buildAnalyticsReport(query, fixture.cards).cards.length, 0);
  const result = await runCandidate(query, fixture, candidate(query, null, [{
    sourceId: source.id,
    factId: fact.id,
  }]));
  assert.equal(result.ai.status, "failed");
  assert.deepEqual(result.cards, []);
  assert.deepEqual(result.ai.citations, []);
});

test("a change even in an uncited source discards the model plan and uses fresh ordinary rows", async () => {
  let reloads = 0;
  const source = currentCanonSources(fixture.cards).find(({ cardId }) => cardId === passport.id)!;
  const result = await run(
    institutionQuery,
    async () => ({
      status: "ready",
      output: candidate(passportQuery, null, [{ sourceId: source.id, factId: source.facts[0].id }]),
    }),
    async () => {
      reloads++;
      return {
        ...fixture,
        cards: fixture.cards.map((card) =>
          card.id === project.id
            ? {
                ...card,
                title: "Вуз МИДиС — обновлённый учебный проект",
              }
            : card
        ),
      };
    }
  );
  assert.equal(reloads, 1);
  assert.equal(result.ai.reason, "sources-changed");
  assert.equal(result.ai.appliedQuery, undefined);
  assert.deepEqual(result.ai.citations, []);
  assert.ok(
    result.cards.some(
      (card) => card.title === "Вуз МИДиС — обновлённый учебный проект"
    )
  );
});

test("quota, unavailable or malformed answers preserve the ordinary report without a second inference", async () => {
  const original = buildAnalyticsReport(
    institutionQuery,
    fixture.cards,
    fixture.types
  );
  for (const response of [
    { status: "busy" as const },
    { status: "unavailable" as const },
    { status: "failed" as const },
    {
      status: "ready" as const,
      output: { ...candidate(passportQuery), total: 12 },
    },
  ]) {
    let calls = 0;
    const result = await run(institutionQuery, async () => {
      calls++;
      return response;
    });
    assert.equal(calls, 1);
    assert.equal(
      result.ai.status,
      response.status === "ready" ? "failed" : response.status
    );
    assert.deepEqual(
      result.cards.map((card) => card.id),
      original.cards.map((card) => card.id)
    );
    assert.deepEqual(result.summary, original.summary);
  }
});

test("the model can only ask a server-defined clarification question", async () => {
  const result = await run(institutionQuery, async () => ({
    status: "ready",
    output: candidate(null, "type"),
  }));
  assert.match(result.ai.clarification ?? "", /тип карточек/i);
  assertOrdinaryReport(
    result,
    buildAnalyticsReport(institutionQuery, fixture.cards, fixture.types)
  );
});
