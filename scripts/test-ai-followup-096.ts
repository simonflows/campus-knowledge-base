import assert from "node:assert/strict";
import { test } from "node:test";
import candidates from "../data/pilot-0.9.5-candidates.json";
import verification from "../data/pilot-0.9.5-verification.json";
import { FACT_CHECK_PRESETS } from "../lib/audit-canon-registry";
import { answerCanonChat } from "../lib/canon-ai";
import { buildCanonicalRewrite, checkFactText } from "../lib/fact-check";
import { knowledgeSeedCards, type KnowledgeCard } from "../lib/knowledge";

const approvedIds = new Set(verification.approvedIds);
const cards = candidates.cards
  .filter(({ card }) => approvedIds.has(card.id))
  .map(({ card }) => ({ ...card, status: "approved" })) as KnowledgeCard[];
const original = "В новом учебно-научном корпусе кампуса «Южный Урал» в Челябинске уже работает робот Куки, который отливает скульптуры из кинопласта. Кроме того, челябинский кампус сформировал 37 продуктовых программ и 245 решений, а общая площадь кампуса составляет 114 тыс. кв. метров.";
const request = new Request("https://canon.invalid/api/assistant");

test("archived portfolio flags point to the metrics and unsupported area appears once", () => {
  const checked = checkFactText(original, cards);
  const portfolio = checked.findings.filter(({ title }) => title.includes("37 программ / 245 решений"));
  assert.equal(portfolio.length, 1);
  assert.match(portfolio[0].quote, /сформировал 37 продуктовых программ и 245 решений/u);
  assert.doesNotMatch(portfolio[0].quote, /Куки|114/u);

  const area = checked.findings.filter(({ quote }) => /114 тыс/u.test(quote));
  assert.deepEqual(area.map(({ level }) => level), ["yellow"]);
  assert.doesNotMatch(area[0].quote, /245/u);
});

test("separate archived portfolio claims stay with their own numbers and preserve boundary checks", () => {
  const draft = "В Челябинске показали робота KUKA. Кампус сформировал 37 продуктовых программ. Кампус сформировал 245 решений. Кампус сформировал 137 программ и 1245 решений.";
  const findings = checkFactText(draft, cards).findings
    .filter(({ title }) => title.includes("37 программ / 245 решений"));
  assert.deepEqual(findings.map(({ quote }) => quote), [
    "Кампус сформировал 37 продуктовых программ",
    "Кампус сформировал 245 решений",
  ]);
});

test("campus area is red only with an applicable conflicting official measure", () => {
  const area = "Общая площадь кампуса составляет 114 тыс. кв. метров.";
  const seed = knowledgeSeedCards.find(card => card.type === "campus")!;
  assert.equal(seed.type, "campus");
  if (seed.type !== "campus") return;
  const exact = {
    ...seed,
    campusMetrics: [{ label: "Общая площадь объектов", value: "114 тыс. м²", note: "" }],
  };
  assert.ok(checkFactText(area, [seed]).findings.some(({ level, quote }) => level === "red" && /114 тыс/u.test(quote)));
  assert.ok(checkFactText(area, [exact]).findings.every(({ level }) => level !== "red"));
});

test("campus area claims use evidence for the same object and scope", () => {
  const seed = knowledgeSeedCards.find(card => card.type === "campus")!;
  assert.ok(seed.type === "campus");
  const campus = "Общая площадь кампуса";
  for (const [label, ownClaim, value, wrongScopeValue] of [
    ["Площадь земельных участков", "Площадь земельных участков кампуса", "58,8", "114"],
    ["Площадь УНК", "Площадь УНК кампуса", "40,3", "114"],
    ["Площадь гостиничных корпусов", "Площадь гостиниц кампуса", "60", "114"],
    ["Общая площадь объектов", campus, "123", "114"],
  ]) {
    const card = { ...seed, campusMetrics: [{ label, value: value + " тыс. м²", note: "" }] };
    const scopedFindings = (claim: string, amount: string) => checkFactText(
      `${claim} составляет ${amount} тыс. кв. метров.`, [card]
    ).findings.filter(({ checkpoint }) => checkpoint === "campus");
    if (ownClaim !== campus) {
      assert.deepEqual(scopedFindings(campus, wrongScopeValue).map(({ level }) => level), ["yellow"], label);
      assert.deepEqual(scopedFindings(campus, value).map(({ level }) => level), ["yellow"], label);
    }
    assert.ok(scopedFindings(ownClaim, wrongScopeValue).some(({ level }) => level === "red"), label);
    assert.ok(scopedFindings(ownClaim, value).every(({ level }) => level !== "red"), label);
  }
  const notesOnly = {
    ...seed,
    campusMetrics: [{ label: "Общая площадь объектов", value: "123 тыс. м²", note: "Два земельных участка — 58,8 тыс. м²" }],
  };
  const matchedNote = checkFactText("Площадь земельных участков кампуса составляет 58,8 тыс. кв. метров.", [notesOnly]);
  assert.equal(matchedNote.summary.red, 0);
  const landOnly = {
    ...seed,
    campusMetrics: [{ label: "Площадь земельных участков", value: "58,8 тыс. м²", note: "" }],
  };
  const neighboring = checkFactText(
    "Общая площадь кампуса составляет 114 тыс. м², площадь земельных участков — 58,8 тыс. м².",
    [landOnly]
  );
  assert.deepEqual(neighboring.findings.filter(({ checkpoint }) => checkpoint === "campus")
    .map(({ level }) => level), ["yellow"]);
});

test("two areas in one sentence compare each amount against its own object", () => {
  const seed = knowledgeSeedCards.find(card => card.type === "campus")!;
  assert.ok(seed.type === "campus");
  const card = {
    ...seed,
    campusMetrics: [{ label: "Общая площадь объектов", value: "123 тыс. м²", note: "Два земельных участка — 58,8 тыс. м²" }],
  };
  const campus = "Общая площадь кампуса составляет 123 тыс. м²";
  const land = "Площадь земельных участков составляет 58,8 тыс. м²";
  for (const draft of [
    campus + " и " + land.toLowerCase() + ".",
    land + " и " + campus.toLowerCase() + ".",
    campus + ", " + land.toLowerCase() + ".",
    land + ", " + campus.toLowerCase() + ".",
  ]) {
    assert.equal(checkFactText(draft, [card]).summary.red, 0, draft);
  }
  const wrong = checkFactText(campus.replace("123", "114") + " и " + land.toLowerCase() + ".", [card]);
  const errors = wrong.findings.filter(({ checkpoint, level }) => checkpoint === "campus" && level === "red");
  assert.equal(errors.length, 1);
  assert.match(errors[0].explanation, /Общая площадь объектов: 123 тыс/u);
  assert.doesNotMatch(errors[0].explanation, /Два земельных участка/u);
  const restatement = checkFactText(
    "Площадь УНК кампуса — 40,3 тыс. м² (40 306 м²).",
    [seed]
  );
  assert.ok(restatement.findings.every(({ checkpoint, level }) => checkpoint !== "campus" || level === "green"));
});

test("rewriting the original KUKA transmission retains its topic and separates unsupported facts", () => {
  assert.equal(FACT_CHECK_PRESETS.find(({ id }) => id === "preset-midis-kuka")!.text, original);
  const originalCheck = checkFactText(original, cards);
  assert.ok(originalCheck.findings.some(({ quote, level }) => level === "red" && quote.includes("кинопласта")));
  assert.ok(originalCheck.findings.some(({ quote, level }) => level !== "green" && /37|245|114/u.test(quote)));
  const suggestions = originalCheck.findings.map(({ suggestion }) => suggestion).join("\n");
  assert.doesNotMatch(suggestions, /пенопласт|121,8|83–84/iu);

  const rewrite = buildCanonicalRewrite(original, cards);
  assert.ok(rewrite);
  assert.deepEqual(rewrite.sourceCardIds, ["lab-midis-kuka"]);
  assert.match(rewrite.lead, /МИДиС.*KUKA.*скульптуры/u);
  assert.doesNotMatch(rewrite.plainText, /https?:|кинопласт|пенопласт|отлива|114|245|37|гостиниц/iu);
  const checked = checkFactText(rewrite.plainText, cards);
  assert.deepEqual([checked.summary.red, checked.summary.yellow, checked.canPublish], [0, 0, true]);
});

test("a campus location does not justify replacing unknown equipment with passport prose", () => {
  for (const name of ["FANUC L-55", "«KUKA» L-55", "KUKA KR AGILUS"]) {
    const text = `В новом корпусе кампуса «Южный Урал» уже работает робот ${name}.`;
    assert.equal(buildCanonicalRewrite(text, cards)?.lead, undefined, name);
  }
  for (const unknown of [
    "манипулятор FANUC",
    "контроллер KUKA",
    "FANUC L-55",
    "манипулятор «полюс»",
    "манипулятор модели полюс",
  ]) {
    const text = `В новом корпусе кампуса «Южный Урал» действует ${unknown}. Общая площадь кампуса — 114 тыс. кв. м.`;
    assert.equal(buildCanonicalRewrite(text, cards)?.lead, undefined, unknown);
    assert.equal(buildCanonicalRewrite(text, knowledgeSeedCards)?.lead, undefined, unknown);
  }
});

test("exact approved project and laboratory titles retain the subject of the rewrite", () => {
  const seedTitles = knowledgeSeedCards.filter(card => card.type === "project" || card.type === "laboratory")
    .map(({ title, id }) => [title, id]);
  const titles = [
    ...seedTitles,
    ["Виртуальный тренажёр Травмпункта (PROJ-COOP-001)", "joint-midis-susmu-trauma"],
  ];
  for (const [title, id] of titles) {
    assert.equal(buildCanonicalRewrite(title, knowledgeSeedCards)?.sourceCardIds[0], id, title);
  }
});

test("a known bare model guides the rewrite and a campus passport still has its own subject", () => {
  const named = "В новом корпусе кампуса «Южный Урал» действует KUKA. Общая площадь кампуса — 114 тыс. кв. м.";
  assert.deepEqual(buildCanonicalRewrite(named, cards)?.sourceCardIds, ["lab-midis-kuka"]);
  const campus = knowledgeSeedCards.find(card => card.type === "campus")!;
  assert.deepEqual(buildCanonicalRewrite(campus.title, knowledgeSeedCards)?.sourceCardIds, [campus.id]);
});

test("a conversational identity question retains the literal robot and model", async () => {
  const common = { request, accountId: null, cards };
  for (const question of [
    "робот KUKA",
    "кто такой робот кука",
    "Что такое робот-манипулятор KUKA?",
    "Что за робот Кука?",
    "Слушай, кто такой робот Кука?",
    "Что за робот Кука в МИДиС?",
    "Кто такой робот Кука из МИДиС?",
  ]) {
    const answer = await answerCanonChat({ ...common, question });
    assert.ok(answer.citations.some(({ cardId, quote }) => cardId === "lab-midis-kuka" && quote.includes("KUKA")), question);
  }
  for (const question of [
    "Кто такой робот FANUC?",
    "Кто такой робот KUKA L-55?",
    "Кто такой контроллер KUKA?",
    "Слушай, что за робот Кука L-55?",
    "Какие лаборатории без робота KUKA?",
    "Что за робот Кука без оборудования?",
    "Робот KUKA не работает?",
  ]) {
    assert.equal((await answerCanonChat({ ...common, question })).citations.length, 0, question);
  }
});

test("the named university constrains equipment location instead of matching incidental prose", async () => {
  const common = { request, accountId: null, cards };
  for (const question of [
    "кто такой робот кука в ЮУрГУ?",
    "кто такой робот кука в Южно-Уральском государственном университете?",
    "кто такой робот кука из ЮУрГУ?",
  ]) {
    assert.deepEqual((await answerCanonChat({ ...common, question })).citations, [], question);
  }
});

test("robot identity answers use the requested model within a multi-model card", async () => {
  const lab = cards.find((card) => card.id === "lab-midis-kuka");
  assert.ok(lab?.type === "laboratory");
  const multiModel = {
    ...lab,
    referenceDescription: "Робот-манипулятор FANUC помогает создавать скульптуры.",
    equipment: ["Робот-манипулятор KUKA", "Робот-манипулятор FANUC"],
  };
  const answer = await answerCanonChat({
    request,
    accountId: null,
    cards: [multiModel],
    question: "кто такой робот кука",
  });
  assert.ok(answer.citations.length > 0);
  assert.ok(answer.citations.every(({ quote }) => quote.includes("KUKA")));
});

test("editorial transitions preserve evidence without hiding the new claim they introduce", () => {
  const lab = cards.find(({ id }) => id === "lab-midis-kuka")!;
  const confirmed = lab.referenceDescription.slice(0, lab.referenceDescription.indexOf(".") + 1);
  const draft = [
    lab.title,
    "Что это означает?",
    "А теперь — к подробностям.",
    `Кроме того, ${confirmed}`,
    "Далее разберёмся, как это работает.",
    "Дальше — о главном.",
    "В заключение — к итогам.",
  ].join("\n\n");
  const checked = checkFactText(draft, cards);
  assert.equal(checked.summary.yellow, 0, JSON.stringify(checked.findings));
  assert.equal(checked.canPublish, true);
  for (const draft of [
    "Кроме того, робот KUKA отливает скульптуры из неизвестного сплава.",
    "Кроме того, робот KUKA обучил 5000 врачей.",
    "Кроме того, робот KUKA уже работает в новом корпусе кампуса.",
    "А теперь — к подробностям: робот KUKA обучил 5000 врачей.",
    "Это открывает новые возможности: робот KUKA теперь лечит пациентов.",
  ]) {
    const result = checkFactText(draft, cards);
    assert.ok(result.summary.red || result.summary.yellow, draft);
    assert.equal(result.canPublish, false, draft);
  }
});

test("a supported paragraph cannot certify a new capability stated with a short Russian verb", () => {
  const lab = cards.find(({ id }) => id === "lab-midis-kuka")!;
  const confirmed = lab.referenceDescription.slice(0, lab.referenceDescription.indexOf(".") + 1);
  const baseline = lab.title + "\n\n" + confirmed + "\n\n";
  for (const claim of [
    "Робот KUKA лечит пациентов.",
    "KUKA лечит пациентов и печёт хлеб.",
    "Теперь разберёмся, как робот KUKA лечит пациентов.",
  ]) {
    const checked = checkFactText(baseline + claim, cards);
    assert.ok(checked.findings.some(({ level, quote }) => level === "yellow" && quote === claim), claim);
    assert.equal(checked.canPublish, false, claim);
  }
});
