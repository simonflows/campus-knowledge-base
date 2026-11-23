import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeAiFactReview, reviewFactsWithAi } from "../lib/canon-ai";
import { checkFactText } from "../lib/fact-check";
import { knowledgeSeedCards } from "../lib/knowledge";

const request = new Request("https://fixture.invalid");
const accountId = "provider-format";
const cards = knowledgeSeedCards;

test("a Flash verdict confused with an atom kind becomes unknown and keeps valid neighbour rows", async () => {
  const text = "Ректор МИДИС Максим Усынин — о привлекательности Челябинска, изменениях в образовательном процессе и обостренном чувстве лжи у новых поколений.";
  const result = await reviewFactsWithAi({
    request, accountId, text, cards, streaming: true,
    ask: async () => ({ status: "ready", output: [
      {
        id: 1, verdict: "identity",
        atom: { kind: "role", subject: "Максим Усынин", predicate: "Ректор МИДИС" },
        evidence: [{ sourceId: "fabricated", factId: "fabricated" }],
        correction: "Непроверенное исправление.",
      },
      { id: 2, verdict: "outside", atom: { kind: "other" } },
    ] }),
  });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.mode, "mixed");
  assert.equal(result.rejectedClaims, 1);
  assert.deepEqual(result.claims.map(claim => claim.verdict), ["unknown", "outside"]);
  assert.deepEqual(result.claims[0].evidence, []);
  assert.equal(result.claims[0].correction, "");
  assert.ok(result.claims.every(claim => claim.quote === text.slice(claim.start, claim.end)));
  const merged = mergeAiFactReview(checkFactText(text, cards), result);
  assert.equal(merged.canPublish, false);
  assert.ok(merged.findings.every(finding => !finding.quote.includes("привлекательности")));
});

test("a bare Flash array retains the exact field proof requirements", async () => {
  const correct = "Общая площадь кампуса составляет 123 тыс. кв. метров.";
  const incorrect = "Общая площадь кампуса составляет 114 тыс. кв. метров.";
  const result = await reviewFactsWithAi({
    request, accountId, text: correct + " " + incorrect, cards,
    ask: async (_request, _accountId, _instruction, payload) => {
      const { sources } = JSON.parse(payload);
      const campus = sources.find((source: { cardId: string }) => source.cardId === "campus-passport");
      const fact = campus.facts.find((field: { label: string }) => field.label === "Общая площадь объектов");
      return { status: "ready", output: [
        { id: 1, verdict: "supported", evidence: [{ sourceId: campus.id, factId: fact.id }] },
        { id: 2, verdict: "supported", evidence: [{ sourceId: campus.id, factId: "fabricated" }] },
      ] };
    },
  });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.mode, "mixed");
  assert.equal(result.rejectedClaims, 1);
  assert.deepEqual(result.claims.map(claim => [claim.quote, claim.verdict]), [[correct, "supported"]]);
  assert.match(result.claims[0].evidence[0].href, /version=cv-/u);
});

test("a provisional fact kind cannot take the place of a valid verdict for the same span", async () => {
  const text = "Общая площадь кампуса составляет 123 тыс. кв. метров.";
  for (const provisionalFirst of [false, true]) {
    const result = await reviewFactsWithAi({
      request, accountId, text, cards,
      ask: async (_request, _accountId, _instruction, payload) => {
        const { sources } = JSON.parse(payload);
        const campus = sources.find((source: { cardId: string }) => source.cardId === "campus-passport");
        const fact = campus.facts.find((field: { label: string }) => field.label === "Общая площадь объектов");
        const supported = { id: 1, verdict: "supported", evidence: [{ sourceId: campus.id, factId: fact.id }] };
        const provisional = { id: 1, verdict: "metric", evidence: [{ sourceId: campus.id, factId: "fabricated" }] };
        return { status: "ready", output: provisionalFirst ? [provisional, supported] : [supported, provisional] };
      },
    });
    assert.equal(result.status, "ready");
    if (result.status !== "ready") continue;
    assert.equal(result.mode, "mixed");
    assert.deepEqual(result.claims.map(claim => [claim.quote, claim.verdict]), [[text, "supported"]]);
    assert.equal(result.rejectedClaims, 1);
    assert.match(result.claims[0].evidence[0].href, /version=cv-/u);
  }
});

test("Flash's text field is an exact quote alias and cannot hide a concrete equipment claim", async () => {
  const text = "Робот KUKA лечит пациентов на Луне.";
  const result = await reviewFactsWithAi({
    request, accountId, text, cards, streaming: true,
    ask: async () => ({ status: "ready", output: { claims: [{ id: 1, verdict: "outside", text }] } }),
  });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.deepEqual(result.claims.map(claim => [claim.quote, claim.verdict]), [[text, "unknown"]]);
  const merged = mergeAiFactReview(checkFactText(text, cards), result);
  assert.deepEqual(merged.summary, { red: 0, yellow: 1, green: 0, total: 1 });

  for (const row of [
    { verdict: "outside", text: text.replace("Луне", "Марсе") },
    { verdict: "outside", text, quote: text.replace("Луне", "Марсе") },
    { verdict: "outside", text, start: 1, end: text.length + 1 },
    { verdict: "supported", text, evidence: [{ sourceId: "fabricated", factId: "fabricated" }] },
  ]) {
    const invalid = await reviewFactsWithAi({
      request, accountId, text, cards,
      ask: async () => ({ status: "ready", output: { claims: [{ id: 1, ...row }] } }),
    });
    assert.equal(invalid.status, "failed");
  }
});

test("epistemic hedges keep literal relationships between distinct entities checkable", async () => {
  for (const { text, subject, predicate, expected } of [
    { text: "Мне кажется, МИДиС купил робота KUKA.", subject: "МИДиС", predicate: "купил робота KUKA", expected: "unknown" },
    { text: "По моему мнению, ЮУрГУ направил МИДиС новый протокол.", subject: "ЮУрГУ", predicate: "направил МИДиС новый протокол", expected: "unknown" },
    { text: "Мне кажется, МИДиС красив.", subject: "МИДиС", predicate: "красив", expected: "opinion" },
    { text: "Мне кажется, МИДиС выглядит лучше KUKA.", subject: "МИДиС", predicate: "выглядит лучше KUKA", expected: "opinion" },
    { text: "Мне кажется, Челябинск становится привлекательнее.", subject: "Челябинск", predicate: "становится привлекательнее", expected: "opinion" },
    { text: "Мне кажется, новые поколения острее чувствуют ложь.", subject: "новые поколения", predicate: "острее чувствуют ложь", expected: "opinion" },
    { text: "Мне кажется, робот KUKA напоминает KUKA ещё больше.", subject: "робот KUKA", predicate: "напоминает KUKA ещё больше", expected: "opinion" },
  ]) {
    const result = await reviewFactsWithAi({
      request, accountId, text, cards, streaming: true,
      ask: async () => ({ status: "ready", output: { claims: [{ id: 1, verdict: "opinion", atom: { kind: "other", subject, predicate } }] } }),
    });
    assert.equal(result.status, "ready", text);
    if (result.status !== "ready") continue;
    assert.deepEqual(result.claims.map(claim => [claim.quote, claim.verdict]), [[text, expected]], text);
    assert.deepEqual(result.claims[0].evidence, [], text);
    const merged = mergeAiFactReview(checkFactText(text, cards), result);
    assert.deepEqual(merged.summary, { red: 0, yellow: expected === "unknown" ? 1 : 0, green: 0, total: expected === "unknown" ? 1 : 0 }, text);
  }
});

for (const predicate of [
  "напоминает ЮУрГУ",
  "кажется мне прекраснее ЮУрГУ",
  "вдохновляет меня больше ЮУрГУ",
]) {
  test(`an opinion about two approved institutions stays an opinion: ${predicate}`, async () => {
    const text = `Мне кажется, МИДиС ${predicate}.`;
    const result = await reviewFactsWithAi({
      request, accountId, text, cards, streaming: true,
      ask: async () => ({ status: "ready", output: { claims: [{
        id: 1, verdict: "opinion", atom: { kind: "other", subject: "МИДиС", predicate },
      }] } }),
    });
    assert.equal(result.status, "ready");
    if (result.status !== "ready") return;
    assert.equal(result.claims[0].verdict, "opinion");
    assert.equal(mergeAiFactReview(checkFactText(text, cards), result).summary.total, 0);
  });
}

test("equipment in a pending card and a subject from a different span cannot establish a scoped relationship", async () => {
  const pendingLab = {
    ...cards.find(card => card.type === "laboratory")!, id: "pending-provider-fixture",
    equipment: ["Робот NOVA3"], status: "pending" as const,
  };
  const catalog = [...cards, pendingLab];
  for (const { text, id, predicate } of [
    { text: "Мне кажется, МИДиС купил робота NOVA3.", id: 1, predicate: "купил робота NOVA3" },
    { text: "МИДиС. Мне кажется, этот дизайн напоминает KUKA.", id: 2, predicate: "напоминает KUKA" },
  ]) {
    const result = await reviewFactsWithAi({
      request, accountId, text, cards: catalog,
      ask: async () => ({ status: "ready", output: { claims: [{
        id, verdict: "opinion", atom: { kind: "other", subject: "МИДиС", predicate },
      }] } }),
    });
    assert.equal(result.status, "ready", text);
    if (result.status === "ready") assert.equal(result.claims[0].verdict, "opinion", text);
  }
});

test("a long article accepts bare arrays for both extraction and verification", async () => {
  const fact = "Робот KUKA лечит пациентов на Луне.";
  const text = "Редакционная ремарка к предыдущему интервью. ".repeat(50) + fact;
  let verified = false;
  const result = await reviewFactsWithAi({
    request, accountId, text, cards, streaming: true,
    ask: async (_request, _accountId, _instruction, payload) => {
      const { stage, claims } = JSON.parse(payload) as { stage: string; claims: { id: number; text: string }[] };
      if (stage === "verify") {
        verified = true;
        assert.deepEqual(claims.map(row => row.text), [fact]);
      }
      return { status: "ready", output: claims.map(({ id, text: quote }) => ({
        id, verdict: stage === "verify" ? "unknown" : quote === fact ? "placement" : "outside",
      })) };
    },
  });
  assert.equal(verified, true);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.mode, "semantic");
  assert.deepEqual(result.verification, { total: 1, completed: 1 });
  assert.equal(result.reviewedSpans, result.totalSpans);
  assert.deepEqual(result.claims.at(-1)?.evidence, []);
  assert.equal(result.claims.at(-1)?.verdict, "unknown");
  assert.equal(result.claims.at(-1)?.quote, fact);
});
