import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewFactsWithAi, type AiFactClaim } from "../lib/canon-ai";
import { buildCanonicalRewrite, checkFactText } from "../lib/fact-check";
import { replaceCheckedFragment } from "../lib/fact-check-edit";
import { knowledgeSeedCards, type CampusCard, type UniversityCard } from "../lib/knowledge";

const first = "Первая очередь гостиниц кампуса рассчитана на 336 мест.";
const second = "Вторая очередь гостиниц кампуса рассчитана на 3 064 места.";
const total = "Общая вместимость гостиниц кампуса составляет 3 400 мест.";
const construction = "Межуниверситетский кампус «Южный Урал» строится в Челябинске.";
const claims = [
  { quote: first, field: "campusMetrics.0" },
  { quote: second, field: "campusMetrics.1" },
  { quote: total, field: "campusMetrics.2" },
  { quote: construction, field: "referenceDescription" },
];

const passport: CampusCard = {
  ...knowledgeSeedCards.find((card): card is CampusCard => card.type === "campus")!,
  referenceDescription: construction + " К проекту относятся семь вузов региона.",
  stopFormula: "",
  stopList: [],
  campusMetrics: [
    { label: "Первая очередь гостиниц", value: "2 корпуса, 336 мест", note: "" },
    { label: "Вторая очередь гостиниц", value: "6 корпусов, 3 064 места", note: "" },
    { label: "Общая вместимость гостиниц", value: "3 400 мест, 8 гостиниц", note: "" },
  ],
};

function assertConfirmed(text: string, expected: typeof claims) {
  const result = checkFactText(text, [passport]);
  assert.deepEqual(result.summary, { red: 0, yellow: 0, green: 4, total: 4 });
  for (const { quote, field } of expected) {
    const finding = result.findings.find(item => item.quote === quote);
    assert.ok(finding, quote);
    assert.equal(finding.sourceCardId, passport.id);
    assert.equal(finding.sourceField, field);
    assert.equal(finding.quoteStart, text.indexOf(quote));
    assert.equal(finding.quoteEnd, text.indexOf(quote) + quote.length);
  }
}

test("adjacent hotel claims retain their own scope within a single paragraph", () => {
  for (const separator of ["\n\n", "\r\n", " ", "\u00a0"]) {
    assertConfirmed(claims.map(({ quote }) => quote).join(separator), claims);
  }
});

test("numbered and bulleted independent claims keep proof and source offsets", () => {
  const items = claims.map(({ quote, field }) => ({ quote: quote.slice(0, -1), field }));
  const markers = ["1. ", "2) ", "- ", "• "];
  assertConfirmed(items.map(({ quote }, index) => markers[index] + quote).join("\r\n"), items);
});

test("soft line wraps and different spaces within claims preserve the original fragments", () => {
  const wrapped = [
    first.replace("гостиниц кампуса", "гостиниц\r\nкампуса"),
    second.replace("3 064", "3\r\n064").replace("рассчитана на", "рассчитана\nна"),
    total.replace("3 400", "3\u202f400").replace("составляет", "\r\nсоставляет"),
    construction.replace("Южный Урал", "Южный\u00a0Урал").replace("в Челябинске", "в\nЧелябинске"),
  ].map((quote, index) => ({ quote, field: claims[index].field }));
  assertConfirmed(wrapped.map(({ quote }) => quote).join(" "), wrapped);
});

test("permuting independent sentences preserves evidence for each claim", () => {
  const permuted = [claims[3], claims[2], claims[0], claims[1]];
  assertConfirmed(permuted.map(({ quote }) => quote).join(" "), permuted);
});

test("area retains its numeric value and exact range across thousands separators", () => {
  for (const approvedValue of ["123 000 м²", "123\u202f000 м²"]) {
    const areaPassport = {
      ...passport,
      campusMetrics: [{ label: "Общая площадь кампуса", value: approvedValue, note: "" }],
    };
    for (const separator of [" ", "\u00a0", "\u202f", "\t", "\n", "\r\n"]) {
      for (const [number, level] of [["123", "green"], ["124", "red"]] as const) {
        const quote = "Общая площадь кампуса составляет " + number + separator + "000 м².";
        const text = "\r\n" + quote;
        const result = checkFactText(text, [areaPassport]);
        assert.deepEqual(result.findings.map(item => [item.level, item.quote, item.quoteStart, item.quoteEnd]),
          [[level, quote, 2, text.length]], JSON.stringify(quote));
      }
    }
    for (const quote of [
      "Общая площадь кампуса\nсоставляет 123 000 м².",
      "Общая площадь кампуса составляет\n123 000 м².",
    ]) assert.deepEqual(checkFactText(quote, [areaPassport]).findings.map(item => [item.level, item.quote]), [["green", quote]]);
  }
});

test("a construction assertion wraps before the capitalized place name", () => {
  const source = construction.replace("в Челябинске", "в городе Челябинске");
  const card = { ...passport, referenceDescription: source + " К проекту относятся семь вузов региона." };
  for (const quote of [source, source.replace("городе Челябинске", "городе\nЧелябинске")]) {
    const result = checkFactText("\n" + quote, [card]);
    assert.deepEqual(result.findings.map(item => [item.level, item.quote, item.quoteStart, item.sourceField]),
      [["green", quote, 1, "referenceDescription"]], quote);
  }
});

test("spacing around an area range keeps both endpoints subject to verification", () => {
  for (const value of ["123 000–125 000 м²", "123 000\u00a0–\u202f125 000 м²"]) {
    const areaPassport = {
      ...passport,
      campusMetrics: [{ label: "Общая площадь кампуса", value, note: "" }],
    };
    for (const dash of ["–", " – ", "\u00a0–\u202f", "\n– ", " –\n"]) {
      for (const [lower, level] of [["123 000", "green"], ["99 000", "red"]] as const) {
        const quote = "Общая площадь кампуса составляет " + lower + dash + "125 000 м².";
        assert.deepEqual(checkFactText(quote, [areaPassport]).findings.map(item => [item.level, item.quote]),
          [[level, quote]], JSON.stringify(quote));
      }
    }
  }
});

test("a negative or provisional area is not confirmed by the approved positive area", () => {
  const areaPassport = {
    ...passport,
    campusMetrics: [{ label: "Общая площадь кампуса", value: "123 000 м²", note: "" }],
  };
  for (const [quote, verdict] of [
    ["Общая площадь кампуса составляет -123 000 м².", "red"],
    ["Общая площадь кампуса составляет −123 000 м².", "red"],
    ["Общая площадь кампуса по предварительным данным составляет 123 000 м².", "yellow"],
    ["Общая площадь кампуса составляет предварительно 123 000 м².", "yellow"],
    ["По предварительным данным общая площадь кампуса составляет 123 000 м².", "yellow"],
  ]) {
    const result = checkFactText(quote, [areaPassport]);
    assert.deepEqual(result.findings.map(item => [item.level, item.quote]), [[verdict, quote]]);
  }
});

test("a standalone campus heading binds a lower-case statement or a marked list item", () => {
  for (const [heading, quote] of [
    ["Кампус «Южный Урал»\n", "вместимость гостиниц — 3 400 мест."],
    ["- Кампус «Южный Урал»\n- ", "Вместимость гостиниц — 3 400 мест."],
  ]) {
    const text = heading + quote;
    const result = checkFactText(text, [passport]);
    assert.deepEqual(result.summary, { red: 0, yellow: 0, green: 2, total: 2 }, text);
    assert.ok(result.findings.some(item => item.level === "green" && item.quote === quote &&
      item.quoteStart === heading.length && item.sourceField === "campusMetrics.2"), text);
  }
});

test("a four-digit year followed by a period qualifies the assertion rather than numbering it", () => {
  for (const separator of [" ", "\n"]) {
    const text = "2020." + separator + total;
    const result = checkFactText(text, [passport]);
    assert.equal(result.canPublish, false, text);
    assert.ok(result.findings.some(item => item.level === "yellow" && item.quote === total), text);
  }
});

test("a standalone dated assertion about another subject cannot date campus capacity", () => {
  const unrelated = "В 2030 году в Казани откроется музей.";
  for (const separator of [" ", "\n", "\n\n"]) {
    for (const text of [unrelated + separator + total, total + separator + unrelated]) {
      assert.ok(checkFactText(text, [passport]).findings.some(item =>
        item.level === "green" && item.quote === total), text);
    }
  }
});

test("an independent claim about a foreign campus cannot change an explicitly named campus", () => {
  const foreign = "Межуниверситетский кампус «Северная долина» строится в Казани.";
  const namedTotal = total.replace("кампуса", "кампуса «Южный Урал»");
  for (const text of [foreign + "\n\n" + namedTotal, namedTotal + "\n\n" + foreign]) {
    assert.ok(checkFactText(text, [passport]).findings.some(item =>
      item.level === "green" && item.quote === namedTotal), text);
  }
  const heading = "## Кампус «Северная долина»\n\n" + namedTotal;
  assert.ok(checkFactText(heading, [passport]).findings.some(item =>
    item.level === "yellow" && item.quote === namedTotal));
});

test("a hotel measurement can wrap before or after the dash", () => {
  for (const quote of [
    "Вместимость гостиниц кампуса «Южный Урал»\r\n— 3 400 мест.",
    "Вместимость гостиниц кампуса «Южный Урал» —\r\n3 400 мест.",
  ]) {
    const result = checkFactText(quote, [passport]);
    assert.deepEqual(result.findings.map(item => [item.level, item.quote, item.quoteStart]),
      [["green", quote, 0]], quote);
  }
});

test("an unverified listed quantity appears once at the claim range", () => {
  const card = { ...passport, campusMetrics: passport.campusMetrics.slice(2) };
  const expected = checkFactText([first, second, total, construction].join("\n\n"), [card]);
  const list = [first, second, total, construction].map(quote => "- " + quote).join("\n");
  const actual = checkFactText(list, [card]);
  assert.deepEqual(actual.summary, expected.summary);
  assert.deepEqual(actual.findings.map(item => [item.level, item.quote]), expected.findings.map(item => [item.level, item.quote]));
});

test("a university count keeps its subject and date across line breaks", () => {
  const seed = knowledgeSeedCards.find((card): card is UniversityCard =>
    card.type === "university" && card.universityId === "midis")!;
  const university: UniversityCard = {
    ...seed,
    structuredMetrics: [{
      id: "format-quota", label: "Квота мест", value: 120, unit: "мест", year: 2026, kind: "actual",
      evidenceUrl: "https://example.org/document", verifiedAt: "2026-11-20", owner: "Test owner",
    }],
  };
  for (const quote of [
    "МИДиС в 2026\nгоду получил 120 мест в кампусе",
    "МИДиС в 2026 году\nполучил 120 мест в кампусе",
    "МИДиС в 2026 году получил\r\n120 мест в кампусе",
    "МИДиС в 2026 году получил 120 мест в\nкампусе",
  ]) {
    const result = checkFactText(quote + ".", [university, passport]);
    assert.deepEqual(result.findings.map(item => [item.level, item.quote, item.sourceCardId]),
      [["green", quote, university.id]], quote);
  }
});

test("a changed amount is contradicted and its exact listed span can be corrected", () => {
  const wrong = second.replace("3 064", "3\u00a0065");
  const text = "- " + first + "\n- " + wrong + "\n- " + total + "\n- " + construction;
  const corrected = text.replace(wrong, second);
  const result = checkFactText(text, [passport]);
  assert.deepEqual(result.summary, { red: 1, yellow: 0, green: 3, total: 4 });
  const finding = result.findings.find(item => item.level === "red");
  assert.ok(finding?.replacement);
  assert.equal(finding.sourceField, "campusMetrics.1");
  assert.equal(finding.quote, wrong);
  assert.equal(replaceCheckedFragment(text, finding.quote, finding.replacement, finding.quoteStart, finding.quoteEnd), corrected);
});

test("dates, negation, other subjects and plans still qualify their own facts", () => {
  for (const changed of [
    second.replace("рассчитана", "не\r\nрассчитана"),
    second.replace("рассчитана", "будет рассчитана"),
    second.replace("кампуса", "кампуса «Северный Урал»"),
    second.slice(0, -1) + ", если гостиницы будут построены.",
  ]) {
    const result = checkFactText([first, changed, total].join(" "), [passport]);
    assert.ok(result.findings.some(item => item.quote === changed && item.level === "yellow"), changed);
    assert.ok(!result.findings.some(item => item.quote === changed && item.level === "green"), changed);
  }
  for (const heading of ["## Первая очередь гостиниц", "## Прогноз на 2030 год", "В 2020 году.", "Если в 2030 году в Казани откроется музей."]) {
    for (const separator of heading.startsWith("#") ? ["\n\n"] : [" ", "\n", "\n\n"]) {
      const text = heading + separator + second;
      assert.ok(checkFactText(text, [passport]).findings.some(item => item.quote === second && item.level === "yellow"), text);
    }
  }
});

test("rewrite repairs a wrong amount in a dense paragraph and preserves adjacent claims", () => {
  const wrong = second.replace("3 064", "3 065");
  const text = [first, wrong, total, construction].join(" ");
  const rewrite = buildCanonicalRewrite(text, [passport]);
  assert.equal(rewrite?.plainText, [first, second, total, construction].join(" "));
});

test("identical assertions in two sections use the context of each occurrence", () => {
  for (const quote of [total, construction]) {
    const text = quote + "\n\n## План на 2030 год\n\n" + quote;
    const result = checkFactText(text, [passport]);
    assert.deepEqual(
      result.findings.filter(item => item.quote === quote).map(item => [item.level, item.quoteStart]),
      [["yellow", text.lastIndexOf(quote)], ["green", 0]],
      quote
    );
  }
});

test("semantic proof validates the original offsets for all four adjacent claims", async () => {
  const text = claims.map(({ quote }) => quote).join(" ");
  const result = await reviewFactsWithAi({
    request: new Request("https://canon.invalid"),
    accountId: "format-110",
    text,
    cards: [passport],
    ask: async (_request, _account, _instruction, payload) => {
      const batch = JSON.parse(payload);
      const [source] = batch.sources;
      return {
        status: "ready",
        output: {
          claims: batch.claims.map(({ id, text: quote }: { id: number; text: string }) => {
            const expected = claims.find(item => item.quote === quote.trim());
            assert.ok(expected, quote);
            const fact = source.facts.find(({ field }: { field: string }) => field === expected.field);
            assert.ok(fact);
            return { id, quote: expected.quote, verdict: "supported", evidence: [{ sourceId: source.id, factId: fact.id }] };
          }),
        },
      };
    },
  });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.claims.length, claims.length);
  for (const { quote, field } of claims) {
    const claim: AiFactClaim | undefined = result.claims.find(item => item.quote === quote);
    assert.ok(claim, quote);
    assert.equal(claim.verdict, "supported", quote);
    assert.equal(claim.evidence[0]?.field, field);
    assert.equal(text.slice(claim.start, claim.end), quote);
  }
});
