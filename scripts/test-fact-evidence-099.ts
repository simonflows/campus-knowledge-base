import assert from "node:assert/strict";
import { test } from "node:test";
import { currentCanonSources, mergeAiFactReview, reviewFactsWithAi } from "../lib/canon-ai";
import { checkFactText } from "../lib/fact-check";
import { knowledgeSeedCards, type CampusCard } from "../lib/knowledge";

const opening = "Межуниверситетский кампус «Южный Урал» строится в Челябинске.";
const passport: CampusCard = {
  ...knowledgeSeedCards.find(
    (card): card is CampusCard => card.type === "campus"
  )!,
  referenceDescription: opening + " К проекту относятся семь вузов региона.",
  campusMetrics: [
    {
      label: "Первая очередь гостиниц",
      value: "2 корпуса, 336 мест",
      note: "Разрешение на ввод от 22.03.2024.",
    },
    {
      label: "Вторая очередь гостиниц",
      value: "6 корпусов, 3 064 места",
      note: "Разрешение на ввод от 16.06.2026.",
    },
    {
      label: "Общая вместимость гостиниц",
      value: "3 400 мест, 8 гостиниц",
      note: "После двух очередей.",
    },
  ],
};
const second = "Вторая очередь гостиниц кампуса рассчитана на 3 064 места.";

async function claim(
  text: string,
  quote: string,
  field: string,
  verdict = "supported",
  card = passport
) {
  const review = await reviewFactsWithAi({
    request: new Request("https://canon.invalid"),
    accountId: "evidence-099",
    text,
    cards: [card],
    ask: async (_request, _account, _instruction, payload) => {
      const data = JSON.parse(payload);
      const source = data.sources[0];
      const fact = source.facts.find(
        (item: { field: string }) => item.field === field
      );
      assert.ok(fact);
      return {
        status: "ready",
        output: {
          claims: data.claims.map((item: { id: number; text: string }) => ({
            id: item.id,
            verdict: item.text.includes(quote) ? verdict : "outside",
            ...(item.text.includes(quote) && {
              quote,
              evidence: [{ sourceId: source.id, factId: fact.id }],
            }),
          })),
        },
      };
    },
  });
  assert.equal(review.status, "ready");
  if (review.status !== "ready")
    throw new Error("Expected ready synthetic review");
  const result = review.claims.find((item) => item.quote === quote);
  assert.ok(result);
  return result;
}

test("AI capacity support resolves the exact queue field without a title whitelist", async () => {
  const result = await claim(second, second, "campusMetrics.1");
  assert.equal(result.verdict, "supported");
  assert.equal(result.evidence[0].field, "campusMetrics.1");
  assert.equal(
    result.evidence[0].quote,
    currentCanonSources([passport])[0].facts.find(
      (item) => item.field === "campusMetrics.1"
    )!.text
  );
  assert.match(result.evidence[0].versionId, /^cv-/u);
});

test("AI exact standalone construction assertion is supported by the complete description field", async () => {
  assert.equal(
    (await claim(opening, opening, "referenceDescription")).verdict,
    "supported"
  );
});

test("an exact one-sentence source cannot erase the hypothetical frame of a campus claim", async () => {
  const card = { ...passport, referenceDescription: opening };
  const result = await claim("## Гипотетический сценарий\n\n" + opening, opening, "referenceDescription", "supported", card);
  assert.equal(result.verdict, "unknown");
  assert.deepEqual(result.evidence, []);
});

test("AI cannot certify a queue using the total or an unrelated source field", async () => {
  for (const field of ["campusMetrics.2", "referenceDescription"]) {
    const result = await claim(second, second, field);
    assert.equal(result.verdict, "unknown");
    assert.deepEqual(result.evidence, []);
  }
});

test("AI proof preserves heading qualifications and queue context", async () => {
  const total = "Общая вместимость гостиниц кампуса составляет 3 400 мест.";
  for (const heading of [
    "# Вместимость второй очереди",
    "# Гипотетический сценарий",
    "# План на 2030 год",
    "# Кампус «Северная долина»",
  ]) {
    const result = await claim(
      heading + "\n\n" + total,
      total,
      "campusMetrics.2"
    );
    assert.equal(result.verdict, "unknown", heading);
  }
});

test("AI direct contradiction uses the same queue and source field", async () => {
  const wrong = second.replace("3 064", "3 400");
  assert.equal(
    (await claim(wrong, wrong, "campusMetrics.1", "contradicted")).verdict,
    "contradicted"
  );
});

test("AI cannot bypass an ambiguous passport by projecting only its favourite metric row", async () => {
  const total = "Общая вместимость гостиниц кампуса составляет 3 400 мест.";
  for (const value of [
    "9 999 мест, 8 гостиниц",
    "ориентировочно 9 999 мест",
    "данные уточняются",
  ]) {
    const card = {
      ...passport,
      campusMetrics: [
        ...passport.campusMetrics,
        { label: "Общая вместимость гостиниц", value, note: "" },
      ],
    };
    const result = await claim(
      total,
      total,
      "campusMetrics.2",
      "supported",
      card
    );
    assert.equal(result.verdict, "unknown", value);
    assert.deepEqual(result.evidence, []);
  }
});

test("AI confirmation retains the field that proves the claim when unrelated citations come first", async () => {
  const lab = knowledgeSeedCards.find(card => card.type === "laboratory")!;
  const cards = [passport, lab];
  const review = await reviewFactsWithAi({ request: new Request("https://canon.invalid"), accountId: "evidence-order-099", text: second, cards,
    ask: async (_request, _account, _instruction, payload) => {
      const data = JSON.parse(payload);
      const campus = data.sources.find((source: { cardId: string }) => source.cardId === passport.id);
      const unrelated = data.sources.find((source: { cardId: string }) => source.cardId === lab.id);
      const ref = (source: typeof campus, field: string) => ({ sourceId: source.id,
        factId: source.facts.find((fact: { field: string }) => fact.field === field).id });
      return { status: "ready", output: { claims: data.claims.map((row: { id: number }) => ({ id: row.id, verdict: "supported",
        evidence: [ref(unrelated, "title"), ref(campus, "campusMetrics.2"), ref(campus, "campusMetrics.1")],
      })) } };
    },
  });
  assert.equal(review.status, "ready");
  if (review.status !== "ready") return;
  assert.deepEqual(review.claims[0].evidence.map(item => item.field), ["campusMetrics.1"]);
  const result = mergeAiFactReview(checkFactText(second, cards), review);
  const green = result.findings.find(finding => finding.level === "green");
  assert.ok(green);
  assert.equal(green.sourceCardId, passport.id);
  assert.equal(green.sourceField, "campusMetrics.1");
  assert.match(green.sourceVersionId!, /^cv-/u);
});
