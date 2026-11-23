import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFactText, buildCanonicalRewrite } from "../lib/fact-check";
import { knowledgeSeedCards, type LaboratoryCard } from "../lib/knowledge";
import { mergeAiFactReview, reviewFactsWithAi } from "../lib/canon-ai";
import pilotCards from "../data/pilot-0.9.5-candidates.json";

const headline = "Ректор МИДИС Максим Усынин — о привлекательности Челябинска, изменениях в образовательном процессе и обостренном чувстве лжи у новых поколений";
const opinion = "Мне кажется, Челябинск становится привлекательнее. Новые поколения острее чувствуют ложь. Образование меняется.";
const area = "Общая площадь кампуса составляет 114 тыс. кв. метров.";
const correctArea = area.replace("114", "123");
const request = new Request("https://canon.invalid");

test("interview headline separates the role from discussion topics", () => {
  const result = checkFactText(headline, knowledgeSeedCards);
  assert.deepEqual(result.findings.map(({ quote }) => quote), ["Ректор МИДИС Максим Усынин"]);
  assert.equal(result.findings[0].quoteStart, 0);
  assert.equal(result.findings[0].quoteEnd, "Ректор МИДИС Максим Усынин".length);
  assert.equal(result.claimCoverage?.unknown, 1);
  assert.equal(result.claimCoverage?.outside, 1);
});

test("opinion, questions and off-topic statements do not generate findings", () => {
  const article = `${opinion}\nКто возглавляет МИДИС? Кошки живут в домах. В 2025 году вышел мой роман.`;
  const result = checkFactText(article, knowledgeSeedCards);
  assert.deepEqual(result.findings.map(({ quote }) => quote), []);
  assert.equal(result.coverage, "unverified");
  assert.equal(result.canPublish, false);
  assert.equal(result.claimCoverage?.mode, "limited");
  assert.equal(result.claimCoverage?.opinion, 2);
});

test("interview rewrite retains the topic, paragraphs, author voice and direct quotes", () => {
  const article = `${headline}\n\n— Как вам Челябинск?\n— «Мне кажется, Челябинск становится привлекательнее».\n\n${area}`;
  const rewrite = buildCanonicalRewrite(article, knowledgeSeedCards);
  assert.ok(rewrite);
  assert.ok(rewrite.plainText.startsWith(`${headline}\n\n— Как вам Челябинск?\n— «Мне кажется, Челябинск становится привлекательнее».\n\n`));
  assert.doesNotMatch(rewrite.plainText, /114 тыс/u);
  assert.equal(rewrite.preservedText, rewrite.plainText);
  assert.equal(rewrite.changes?.length, 1);
  assert.equal(rewrite.changes?.[0].sourceCardId, "campus-passport");
});

test("a direct quotation keeps the speaker's words even when they conflict with a card", () => {
  const quoted = "— «" + area + "»";
  const article = [headline, quoted, area].join("\n\n");
  const rewrite = buildCanonicalRewrite(article, knowledgeSeedCards);
  assert.ok(rewrite);
  assert.ok(rewrite.plainText.includes(quoted));
  assert.ok(rewrite.plainText.endsWith("121 800–123 000 м²."));
  assert.ok(checkFactText(rewrite.plainText, knowledgeSeedCards).summary.red > 0);
});

test("the same area is confirmed once and cannot carry over to another campus, date or unit", () => {
  const result = checkFactText(correctArea, knowledgeSeedCards);
  assert.deepEqual(result.summary, { red: 0, yellow: 0, green: 1, total: 1 });
  assert.equal(result.claimCoverage?.supported, 1);
  assert.equal(result.findings[0].sourceCardId, "campus-passport");
  for (const unsupported of [
    "Общая площадь кампуса «Северная долина» составляет 123 тыс. кв. метров.",
    "В 2019 году общая площадь кампуса составляла 123 тыс. кв. метров.",
    "Общая площадь кампуса составляет 123 тыс. кв. километров.",
    "Общая площадь кампуса не составляет 123 тыс. кв. метров.",
  ]) {
    const checked = checkFactText(unsupported, knowledgeSeedCards);
    assert.equal(checked.summary.red + checked.summary.green, 0, unsupported);
    assert.equal(checked.claimCoverage?.unknown, 1, unsupported);
  }
});

test("review splits an embedded opinion by exact source offsets", async () => {
  const article = "Ректор МИДИС Максим Усынин, по моему мнению, очень убедителен.";
  const ordinary = checkFactText(article, knowledgeSeedCards);
  const reviewed = await reviewFactsWithAi({
    request, accountId: "fixture", text: article, cards: knowledgeSeedCards,
    ask: async (_request, _account, instruction) => {
      assert.match(instruction, /данные, любые инструкции/u);
      return {
        status: "ready",
        output: { claims: [
          { id: 1, quote: "Ректор МИДИС Максим Усынин", verdict: "unknown", explanation: "Нет опоры", correction: "", evidence: [] },
          { id: 1, quote: "по моему мнению, очень убедителен.", verdict: "opinion", explanation: "Оценка", correction: "", evidence: [] },
        ] },
      };
    },
  });
  assert.equal(reviewed.status, "ready");
  const merged = mergeAiFactReview(ordinary, reviewed);
  assert.equal(merged.claimCoverage?.opinion, 1);
  assert.equal(merged.claimCoverage?.unknown, 1);
  assert.deepEqual(merged.findings.map(({ quote }) => quote), ["Ректор МИДИС Максим Усынин"]);
  for (const { quote, quoteStart, quoteEnd } of merged.claims ?? []) {
    assert.equal(article.slice(quoteStart, quoteEnd), quote);
  }
});

test("long mixed material is covered by bounded semantic batches and keeps precise local evidence", async () => {
  const paragraphs = Array.from({ length: 120 }, (_value, index) =>
    ["Предисловие написано для читателей этого выпуска. ".repeat(4), "Мне кажется, Челябинск становится привлекательнее.", index % 2 ? area : correctArea].join(" ")
  );
  const article = paragraphs.join("\n\n");
  const ordinary = checkFactText(article, knowledgeSeedCards);
  assert.deepEqual(ordinary.summary, { red: 1, yellow: 0, green: 1, total: 2 });
  let calls = 0;
  const reviewed = await reviewFactsWithAi({
    request, accountId: "fixture", text: article, cards: knowledgeSeedCards,
    ask: async (_request, _account, _instruction, input, budget) => {
      calls++;
      const { stage, claims } = JSON.parse(input) as { stage?: string; claims: Array<{ id: number; text: string; contextBefore?: string }> };
      assert.ok(claims.length <= 32);
      assert.ok(claims.reduce((size, claim) => size + claim.text.length + (claim.contextBefore?.length ?? 0), 0) <= 6000);
      assert.equal(budget, 3000);
      return {
        status: "ready",
        output: { claims: claims.map(({ id }) => ({ id, verdict: stage === "verify" ? "unknown" : "outside", explanation: "Недостаточно сведений", correction: "", evidence: [] })) },
      };
    },
  });
  assert.ok(calls > 1);
  assert.equal(reviewed.status, "ready");
  const mixed = mergeAiFactReview(ordinary, reviewed);
  assert.equal(mixed.claimCoverage?.mode, "semantic");
  assert.equal(mixed.claimCoverage!.semanticReviewed, mixed.claimCoverage!.spanCount);
  assert.deepEqual(mixed.summary, ordinary.summary);
  for (const { quote, quoteStart, quoteEnd } of mixed.findings) {
    assert.equal(article.slice(quoteStart, quoteEnd), quote);
  }
});

test("a model cannot discard an invented ability of recognized equipment as off-topic", async () => {
  const text = "Робот KUKA лечит пациентов на Луне.";
  const ordinary = checkFactText(text, knowledgeSeedCards);
  const review = await reviewFactsWithAi({
    request, accountId: "fixture", text, cards: knowledgeSeedCards,
    ask: async () => ({
      status: "ready",
      output: { claims: [{ id: 1, verdict: "outside", explanation: "Нет в реестре", correction: "", evidence: [] }] },
    }),
  });
  assert.equal(review.status, "ready");
  const merged = mergeAiFactReview(ordinary, review);
  assert.equal(merged.claimCoverage?.unknown, 1);
  assert.deepEqual(merged.findings.map(({ level, quote }) => [level, quote]), [["yellow", text]]);
});

test("red findings need an applicable published value for the same metric, period or object", () => {
  for (const text of [
    "Смета ремонта гостиницы кампуса составила 11 млрд рублей.",
    "В учебном классе кампуса запланировано 15 мест.",
    "Во второй очереди кампуса ремонт начался в 2018 году.",
  ]) {
    const result = checkFactText(text, knowledgeSeedCards);
    assert.equal(result.summary.red, 0, text);
    assert.equal(result.summary.green, 0, text);
    assert.ok(result.summary.yellow > 0, text);
  }
});

test("an entity name does not confirm its location, completion or historical size", () => {
  for (const text of [
    "Кампус «Южный Урал» в Москве.",
    "Кампус «Южный Урал» полностью готов.",
    "Общая площадь кампуса в 2019 г. составляет 123 тыс. кв. метров.",
  ]) {
    const result = checkFactText(text, knowledgeSeedCards);
    assert.ok(result.summary.yellow > 0, text);
    assert.equal(result.canPublish, false, text);
    assert.ok(result.findings.every(finding => finding.level !== "green" || finding.quote !== text), text);
  }
});

test("an equipment assertion is not a reference lookup", () => {
  for (const text of [
    "На площадке МИДИС установлен робот KUKA.",
    "Робот KUKA на территории нового корпуса кампуса.",
  ]) {
    const rewrite = buildCanonicalRewrite(text, knowledgeSeedCards);
    assert.ok(!rewrite || rewrite.plainText === text, text);
  }
});

test("an adjacent possessive area refers only to the preceding campus", () => {
  const areaClause = "Его общая площадь составляет 114 тыс. кв. метров.";
  const match = "Кампус «Южный Урал» открывается в августе. " + areaClause;
  assert.ok(checkFactText(match, knowledgeSeedCards).findings.some(finding =>
    finding.level === "red" && finding.quote === areaClause && finding.sourceCardId === "campus-passport"
  ));
  for (const text of [
    "Кампус «Другой город» открывается в августе. " + areaClause,
    "Кампус «Южный Урал» открывается в августе.\n\n" + areaClause,
  ]) {
    assert.ok(checkFactText(text, knowledgeSeedCards).findings.every(finding =>
      finding.level !== "red" || finding.quote !== areaClause
    ), text);
  }
});

test("opinion cannot erase a concrete action, while genuine evaluation produces no yellow", async () => {
  for (const text of [
    "Робот KUKA лечит пациентов на Луне.",
    "Лаборатория МИДИС находится в Москве.",
    "Кампус «Южный Урал» — сердце города.",
  ]) {
    const ordinary = checkFactText(text, knowledgeSeedCards);
    const review = await reviewFactsWithAi({
      request, accountId: "fixture", text, cards: knowledgeSeedCards,
      ask: async () => ({
        status: "ready",
        output: { claims: [{ id: 1, verdict: "opinion", explanation: "Оценка", correction: "", evidence: [] }] },
      }),
    });
    const merged = mergeAiFactReview(ordinary, review);
    assert.equal(merged.claimCoverage?.unknown, text.includes("сердце") ? 0 : 1, text);
    assert.equal(merged.claimCoverage?.opinion, text.includes("сердце") ? 1 : 0, text);
  }
});

test("AI keeps a newly scoped unknown claim and skips a row with a changed quote", async () => {
  const text = "Лаборатория МИДИС на пятом этаже. Это было для меня неожиданно.";
  const reviewed = await reviewFactsWithAi({
    request, accountId: "fixture", text, cards: knowledgeSeedCards,
    ask: async (_request, _account, _instruction, payload) => {
      const { sources } = JSON.parse(payload);
      const source = sources.find((item: { cardId: string }) => item.cardId === "lab-midis-kuka");
      const fact = source.facts.find((item: { field: string }) => item.field === "placementDetails");
      return {
        status: "ready",
        output: { claims: [
          { id: 1, verdict: "unknown", explanation: "Этаж не указан", correction: "", evidence: [{ sourceId: source.id, factId: fact.id }] },
          { id: 2, quote: "Это было совсем неожиданно.", verdict: "opinion", explanation: "Оценка", correction: "", evidence: [] },
        ] },
      };
    },
  });
  assert.equal(reviewed.status, "ready");
  if (reviewed.status === "ready") assert.equal(reviewed.rejectedClaims, 1);
  const merged = mergeAiFactReview(checkFactText(text, knowledgeSeedCards), reviewed);
  assert.equal(merged.claimCoverage?.mode, "mixed");
  assert.equal(merged.claimCoverage?.semanticReviewed, 1);
  assert.equal(merged.claimCoverage?.unknown, 1);
  assert.equal(merged.findings.find(finding => finding.level === "yellow")?.quote, "Лаборатория МИДИС на пятом этаже.");
});

test("a hedged claim and a factually loaded question retain the checkable premise", () => {
  const hedged = "Мне кажется, " + area.charAt(0).toLowerCase() + area.slice(1);
  const checked = checkFactText(hedged, knowledgeSeedCards);
  assert.equal(checked.claimCoverage?.opinion, 1);
  assert.equal(checked.summary.red, 1);
  assert.equal(checked.findings[0].quote, area.charAt(0).toLowerCase() + area.slice(1));
  const status = checkFactText("Мне кажется, что кампус «Южный Урал» уже работает.", knowledgeSeedCards);
  assert.ok(status.summary.red + status.summary.yellow > 0);
  for (const question of [
    "Почему площадь кампуса составляет 114 тыс. кв. метров?",
    "Почему робот KUKA находится в новом корпусе кампуса?",
    "Когда площадь кампуса достигла 114 тыс. кв. метров?",
  ]) {
    assert.ok(checkFactText(question, knowledgeSeedCards).summary.yellow > 0, question);
  }
  assert.equal(checkFactText("Какова площадь кампуса?", knowledgeSeedCards).summary.total, 0);
});

test("rewrite preserves Markdown, attributed speech and quoted interview lines", () => {
  for (const speech of [
    "> " + area,
    "Ректор: " + area,
    "В интервью ректор сказал: „" + area + "“",
  ]) {
    const text = [headline, speech, area].join("\n\n");
    const rewrite = buildCanonicalRewrite(text, knowledgeSeedCards);
    assert.ok(rewrite);
    assert.ok(rewrite.plainText.includes(speech));
    assert.ok(rewrite.plainText.endsWith("121 800–123 000 м²."));
    assert.ok(checkFactText(rewrite.plainText, knowledgeSeedCards).summary.red > 0);
  }
});

test("a campus portfolio rule needs the same owner, predicate and period", () => {
  for (const text of [
    "В материалах кампуса сравнили 37 программ МИДИС.",
    "Эксперты кампуса «Южный Урал» обсудили 245 решений других регионов.",
    "После 2030 года кампус «Южный Урал» планирует запустить 245 решений.",
    "В 2021 году кампус «Южный Урал» реализовал 245 решений.",
  ]) {
    assert.equal(checkFactText(text, knowledgeSeedCards).summary.red, 0, text);
  }
  const matching = checkFactText(
    "Кампус «Южный Урал» реализует 37 программ и 245 решений.", knowledgeSeedCards
  );
  assert.equal(matching.summary.red, 1);
});

test("verified location follows the same KUKA equipment, timeframe and current site", async () => {
  const imported = pilotCards.cards.find(({ card }) => card.id === "lab-midis-kuka");
  assert.ok(imported && imported.card.type === "laboratory");
  const card = { ...imported.card, status: "approved" } as (typeof knowledgeSeedCards)[number];
  for (const [text, requested, expected] of [
    ["Робот KUKA работает на площадке МИДИС.", "supported", "supported"],
    ["Робот Кука работает в новом корпусе кампуса.", "contradicted", "contradicted"],
    ["В 2019 г. робот KUKA работал в кампусе.", "contradicted", "unknown"],
    ["Робот KUKA ЧелГУ работает в новом корпусе кампуса.", "contradicted", "unknown"],
  ] as const) {
    const review = await reviewFactsWithAi({
      request, accountId: "fixture", text, cards: [card],
      ask: async (_request, _account, _instruction, payload) => {
        const source = JSON.parse(payload).sources[0];
        const fact = source.facts.find((item: { field: string }) => item.field === "referenceDescription");
        return {
          status: "ready",
          output: { claims: [{ id: 1, verdict: requested, explanation: "Сверка площадки", correction: "", evidence: [{ sourceId: source.id, factId: fact.id }] }] },
        };
      },
    });
    assert.equal(review.status, "ready");
    if (review.status === "ready") assert.equal(review.claims[0].verdict, expected, text);
    const checked = mergeAiFactReview(checkFactText(text, [card]), review);
    const expectedLevel = { supported: "green", contradicted: "red", unknown: "yellow" }[expected];
    assert.deepEqual(checked.findings.map(({ level }) => level), [expectedLevel], text);
  }
});

test("a scoped unknown needs no example citation and survives a confirmed name next to it", async () => {
  for (const text of [
    "Лаборатория МИДИС без аккредитации.",
    "Приборы МИДИС совместимы с протоколом Modbus.",
    "Кампус «Южный Урал» недоступен для посетителей.",
  ]) {
    const review = await reviewFactsWithAi({
      request, accountId: "fixture", text, cards: knowledgeSeedCards,
      ask: async () => ({
        status: "ready",
        output: { claims: [{ id: 1, verdict: "unknown", explanation: "В подтверждённых карточках нет этого отношения", correction: "", evidence: [] }] },
      }),
    });
    assert.equal(review.status, "ready");
    const checked = mergeAiFactReview(checkFactText(text, knowledgeSeedCards), review);
    assert.equal(checked.claimCoverage?.unknown, 1, text);
    assert.equal(checked.canPublish, false, text);
  }
});

test("a former or partner location is no proof of current operation at the university", async () => {
  const seed = knowledgeSeedCards.find((card): card is LaboratoryCard => card.id === "lab-midis-kuka" && card.type === "laboratory");
  assert.ok(seed);
  const text = "Робот KUKA работает на площадке МИДИС.";
  for (const placementDetails of [
    "Ранее робот-манипулятор KUKA работал на площадке МИДиС; сейчас робот-манипулятор KUKA находится в другом учреждении.",
    "Робот-манипулятор KUKA работает на площадке университета-партнёра.",
  ]) {
    const card = { ...seed, placementDetails, referenceDescription: placementDetails };
    const ordinary = checkFactText(text, [card]);
    assert.equal(ordinary.summary.green, 0, placementDetails);
    const review = await reviewFactsWithAi({
      request, accountId: "fixture", text, cards: [card],
      ask: async (_request, _account, _instruction, payload) => {
        const source = JSON.parse(payload).sources[0];
        const fact = source.facts.find((item: { field: string }) => item.field === "placementDetails");
        return {
          status: "ready",
          output: { claims: [{ id: 1, verdict: "supported", explanation: "Сверка площадки", correction: "", evidence: [{ sourceId: source.id, factId: fact.id }] }] },
        };
      },
    });
    assert.equal(review.status, "ready");
    if (review.status === "ready") assert.equal(review.claims[0].verdict, "unknown");
    assert.equal(mergeAiFactReview(ordinary, review).summary.green, 0, placementDetails);
  }
});

test("the cited location must affirm the same equipment in the same source clause", async () => {
  const seed = knowledgeSeedCards.find((card): card is LaboratoryCard => card.id === "lab-midis-kuka" && card.type === "laboratory");
  assert.ok(seed);
  for (const [placementDetails, location] of [
    ["Робот-манипулятор KUKA работает не на площадке МИДиС.", "на площадке МИДИС"],
    ["Робот-манипулятор KUKA работает не в кампусе «Южный Урал».", "в кампусе «Южный Урал»"],
    ["Манипулятор ABB работает на площадке МИДиС. Робот-манипулятор KUKA сейчас находится в другом учреждении.", "на площадке МИДИС"],
    ["Робот-манипулятор KUKA работает на площадке МИДиС. Другой манипулятор работает в кампусе «Южный Урал».", "в кампусе «Южный Урал»"],
    ["Робот-манипулятор KUKA наблюдает, как манипулятор ABB работает на площадке МИДиС.", "на площадке МИДИС"],
    ["Контроллер KUKA работает на площадке МИДиС.", "на площадке МИДИС"],
    ["Робот-манипулятор KUKA работает на площадке МИДиС?", "на площадке МИДИС"],
    ["На площадке МИДиС работает робот-манипулятор KUKA?", "на площадке МИДИС"],
    ["Робот KUKA работает на площадке МИДИС?", "на площадке МИДИС"],
    ["Робот-манипулятор KUKA работает на площадке МИДиС, если подключено питание.", "на площадке МИДИС"],
  ] as const) {
    const text = "Робот KUKA работает " + location + ".";
    const card = { ...seed, placementDetails, referenceDescription: placementDetails };
    const ordinary = checkFactText(text, [card]);
    assert.equal(ordinary.summary.green, 0, placementDetails);
    const review = await reviewFactsWithAi({
      request, accountId: "fixture", text, cards: [card],
      ask: async (_request, _account, _instruction, payload) => {
        const source = JSON.parse(payload).sources[0];
        const fact = source.facts.find((item: { field: string }) => item.field === "placementDetails");
        return {
          status: "ready",
          output: { claims: [{ id: 1, verdict: "supported", explanation: "Сверка площадки", correction: "", evidence: [{ sourceId: source.id, factId: fact.id }] }] },
        };
      },
    });
    assert.equal(review.status, "ready");
    if (review.status === "ready") assert.equal(review.claims[0].verdict, "unknown", placementDetails);
  }
});

test("the name of a known campus in an evaluation does not make it checkable", () => {
  for (const text of [
    "Кампус «Южный Урал» — приятное место.",
    "Кампус «Южный Урал» — уютное место.",
    "Мне нравится кампус «Южный Урал».",
  ]) {
    const result = checkFactText(text, knowledgeSeedCards);
    assert.equal(result.summary.total, 0, text);
    assert.equal(result.claimCoverage?.opinion, 1, text);
  }
});

test("equipment presence at a known site does not prove the equipment operates there", async () => {
  const seed = knowledgeSeedCards.find((card): card is LaboratoryCard => card.id === "lab-midis-kuka" && card.type === "laboratory");
  assert.ok(seed);
  const text = "Робот KUKA работает на площадке МИДИС.";
  for (const [operation, level] of [["находится", "yellow"], ["работает", "green"]] as const) {
    const details = "Робот-манипулятор KUKA " + operation + " на площадке МИДиС.";
    const card = { ...seed, placementDetails: details, referenceDescription: details };
    const local = checkFactText(text, [card]);
    assert.deepEqual(local.findings.map(finding => finding.level), [level], operation);
    const review = await reviewFactsWithAi({
      request, accountId: "fixture", text, cards: [card],
      ask: async (_request, _account, _instruction, payload) => {
        const source = JSON.parse(payload).sources[0];
        const fact = source.facts.find((item: { field: string }) => item.field === "placementDetails");
        return {
          status: "ready",
          output: { claims: [{ id: 1, verdict: "supported", explanation: "Сверка действия", correction: "", evidence: [{ sourceId: source.id, factId: fact.id }] }] },
        };
      },
    });
    assert.equal(review.status, "ready");
    if (review.status === "ready") assert.equal(review.claims[0].verdict, level === "green" ? "supported" : "unknown");
  }
});

test("a named speaker's line stays verbatim while an adjacent data label remains editable", () => {
  const speaker = "Максим Усынин: " + area;
  const data = "Площадь: 114 тыс. кв. метров — общая площадь кампуса.";
  const article = ["Беседа о кампусе", speaker, data].join("\n\n");
  const rewrite = buildCanonicalRewrite(article, knowledgeSeedCards);
  assert.ok(rewrite);
  assert.ok(rewrite.plainText.includes(speaker));
  assert.match(rewrite.plainText, /Площадь: 121 800–123 000 м²/u);
  assert.equal(rewrite.changes?.length, 1);
  assert.ok(checkFactText(rewrite.plainText, knowledgeSeedCards).summary.red > 0);
});

test("an approved name cannot make a separate offline assertion clean", () => {
  for (const property of ["недоступен для посетителей", "платный для студентов", "закрыт для мероприятий"]) {
    const text = "Кампус «Южный Урал» " + property + ".";
    const checked = checkFactText(text, knowledgeSeedCards);
    assert.equal(checked.canPublish, false, text);
    assert.ok(checked.findings.some(finding => finding.level === "yellow" && finding.quote.includes(property)), text);
    const rewrite = buildCanonicalRewrite(text, knowledgeSeedCards);
    if (rewrite) assert.equal(checkFactText(rewrite.plainText, knowledgeSeedCards).canPublish, false);
  }
  const topic = checkFactText("Кампус «Южный Урал» — о жизни студентов", knowledgeSeedCards);
  assert.equal(topic.summary.yellow, 0);
});

test("a repeated claim is anchored to the source heading that determines its outcome", () => {
  const seed = knowledgeSeedCards.find((card): card is LaboratoryCard => card.type === "laboratory");
  assert.ok(seed);
  const cards = [
    { ...seed, id: "lab-sensor-fixture", title: "Лаборатория фотонных сенсоров", partner: "ООО «Азимут»" },
    { ...seed, id: "lab-optics-fixture", title: "Лаборатория адаптивной оптики", partner: "ООО «Меридиан»" },
  ];
  const phrase = "Партнёр: ООО «Азимут».";
  const text = cards[0].title + "\n" + phrase + "\n\n" + cards[1].title + "\n" + phrase;
  const result = checkFactText(text, cards);
  const findings = result.findings.filter(finding => finding.quote === phrase);
  assert.deepEqual(findings.map(finding => [finding.level, finding.sourceCardId, finding.quoteStart]), [
    ["red", cards[1].id, text.lastIndexOf(phrase)],
    ["green", cards[0].id, text.indexOf(phrase)],
  ]);
  assert.equal(result.claims?.find(claim => claim.quoteStart === text.lastIndexOf(phrase))?.verdict, "contradicted");
  assert.equal(result.claims?.find(claim => claim.quoteStart === text.indexOf(phrase))?.verdict, "supported");
});
