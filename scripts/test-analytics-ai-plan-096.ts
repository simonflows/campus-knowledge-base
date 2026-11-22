import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAnalyticsWithAi,
  type AnalyticsSnapshot,
} from "../lib/canon-analytics-ai";
import { buildAnalyticsReport } from "../lib/analytics";
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
  const result = await run(
    institutionQuery,
    async (_request, actor, instruction, input) => {
      calls++;
      const data: {
        query: string;
        criteria: { usesDefaultCardTypes: boolean };
        sources: CanonSource[];
      } = JSON.parse(input);
      assert.equal(actor, profile);
      assert.match(instruction, /не.*(?:цифры|числа)/i);
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
            quote: fact.text.slice(0, 80),
          },
        ]),
      };
    }
  );
  assert.equal(calls, 1);
  assert.equal(result.ai.originalQuery, institutionQuery);
  assert.equal(result.ai.appliedQuery, passportQuery);
  assert.deepEqual(
    result.cards.map((card) => card.id),
    [passport.id]
  );
  assert.equal(result.summary.projects, 0);
  assert.equal(result.ai.citations[0]?.href, result.cards[0].sourceHref);
  assert.match(result.cards[0].sourceHref, /&version=cv-[a-f0-9]{64}$/);
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
  const equivalent = await run(
    "Покажи лаборатории с оборудованием KUKA и FANUC",
    async () => ({
      status: "ready",
      output: candidate("Покажи лаборатории с оборудованием кука и FANUC"),
    })
  );
  assert.deepEqual(
    equivalent.cards.map((card) => card.id),
    [lab.id]
  );
  assert.equal(equivalent.ai.status, "ready");
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

test("citations must use literal evidence from the selected report rows", async () => {
  for (const kind of ["unknown-source", "outside-report", "rewritten-quote"]) {
    const result = await run(
      institutionQuery,
      async (_request, _actor, _instruction, input) => {
        const { sources }: { sources: CanonSource[] } = JSON.parse(input);
        const source = sources.find(
          (item) =>
            item.cardId ===
            (kind === "rewritten-quote" ? passport.id : project.id)
        );
        assert.ok(source);
        const fact = source.facts.find(
          (f) => f.field === "referenceDescription"
        );
        assert.ok(fact);
        return {
          status: "ready",
          output: candidate(passportQuery, null, [
            {
              sourceId: kind === "unknown-source" ? "forged-source" : source.id,
              factId: fact.id,
              quote:
                kind === "rewritten-quote"
                  ? "В источнике нет этой вымышленной фразы."
                  : fact.text,
            },
          ]),
        };
      }
    );
    assert.equal(result.ai.status, "failed");
    assert.deepEqual(result.ai.citations, []);
    assert.equal(result.ai.appliedQuery, undefined);
    assert.ok(result.cards.some((card) => card.id === project.id));
  }
});

test("a change even in an uncited source discards the model plan and uses fresh ordinary rows", async () => {
  let reloads = 0;
  const result = await run(
    institutionQuery,
    async () => ({ status: "ready", output: candidate(passportQuery) }),
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
