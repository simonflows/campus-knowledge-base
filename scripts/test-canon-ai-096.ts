import assert from "node:assert/strict";
import { test } from "node:test";
import { knowledgeSeedCards, type KnowledgeCard } from "../lib/knowledge";

const loadContext = () => import("../lib/canon-context").catch(() => null);
const laboratory = () => {
  const card = knowledgeSeedCards.find(card => card.type === "laboratory");
  assert.ok(card);
  return { ...structuredClone(card), status: "approved", title: "Центр МИДиС — KUKA", equipment: ["Робот-манипулятор KUKA"], owners: ["PRIVATE OWNER"], ownerIds: ["private-id"], referenceDescription: "Робот KUKA действует на площадке МИДиС.", stopFormula: "Не переносить объект в кампус." } as KnowledgeCard;
};

test("context contains approved field evidence and excludes private ownership and unpublished changes", async () => {
  const subject = await loadContext();
  assert.ok(subject, "Canonical context builder is missing");
  const card = laboratory();
  const pending = { ...card, status: "pending", title: "SECRET PENDING", approvedSnapshot: card } as KnowledgeCard;
  const sources = subject.buildCanonSources([pending], { [card.id]: "cv-test" });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].title, card.title);
  assert.equal(sources[0].versionId, "cv-test");
  assert.ok(sources[0].facts.some(fact => fact.text === "Робот-манипулятор KUKA"));
  assert.ok(sources[0].constraints.includes(card.stopFormula));
  assert.ok(!JSON.stringify(sources).match(/PRIVATE OWNER|private-id|SECRET PENDING/));
  assert.ok(sources[0].href.includes("version=cv-test"));
});

test("quote validation requires the supplied source, exact field and verbatim evidence", async () => {
  const subject = await loadContext();
  assert.ok(subject, "Canonical context builder is missing");
  const sources = subject.buildCanonSources([laboratory()], { [laboratory().id]: "cv-test" });
  const source = sources[0];
  const fact = source.facts.find(fact => fact.text === "Робот-манипулятор KUKA")!;
  const valid = { sourceId: source.id, factId: fact.id, quote: fact.text };
  assert.ok(subject.validateCanonQuote(valid, sources));
  assert.equal(subject.validateCanonQuote({ ...valid, quote: "Робот KUKA обучил 5000 врачей" }, sources), null);
  assert.equal(subject.validateCanonQuote({ ...valid, sourceId: "foreign" }, sources), null);
  assert.equal(subject.validateCanonQuote({ ...valid, factId: "stopFormula" }, sources), null);
  assert.equal(subject.validateCanonQuote({ ...valid, quote: "K" }, sources), null);
});

test("a pending record without an approved snapshot cannot enter model context", async () => {
  const subject = await loadContext();
  assert.ok(subject, "Canonical context builder is missing");
  const pending = { ...laboratory(), status: "pending", approvedSnapshot: undefined } as KnowledgeCard;
  assert.deepEqual(subject.buildCanonSources([pending], {}), []);
});

test("AI fact review receives live card facts and accepts only evidence from that request", async () => {
  const subject = await import("../lib/canon-ai").catch(() => null);
  assert.ok(subject, "Grounded AI service is missing");
  const card = laboratory();
  const text = "Робот KUKA действует на площадке МИДиС.";
  const request = new Request("https://canon.invalid/api/fact-check");
  const accepted = await subject.reviewFactsWithAi({ request, accountId: "test", text, cards: [card], ask: async (_request, _account, _instruction, input) => {
    const data = JSON.parse(input);
    assert.ok(JSON.stringify(data.sources).includes(card.referenceDescription));
    assert.ok(!input.includes("PRIVATE OWNER"));
    const source = data.sources[0];
    const fact = source.facts.find((fact: { text: string }) => fact.text === text);
    return { status: "ready", output: { claims: [{ id: data.claims[0].id, verdict: "supported", explanation: "Сведения совпадают с утверждённым описанием.", correction: "", evidence: [{ sourceId: source.id, factId: fact.id, quote: fact.text }] }] } };
  } });
  assert.equal(accepted.status, "ready");
  if (accepted.status === "ready") assert.equal(accepted.claims[0].evidence[0].cardId, card.id);
  const forged = await subject.reviewFactsWithAi({ request, accountId: "test", text, cards: [card], ask: async () => ({ status: "ready", output: { claims: [{ id: 1, verdict: "supported", explanation: "Подтверждено", correction: "", evidence: [{ sourceId: "foreign", factId: "f1", quote: text }] }] } }) });
  assert.equal(forged.status, "failed");
});

test("AI review must cover every claim; failures preserve ordinary findings", async () => {
  const subject = await import("../lib/canon-ai").catch(() => null);
  assert.ok(subject, "Grounded AI service is missing");
  const result = await subject.reviewFactsWithAi({ request: new Request("https://canon.invalid"), accountId: "test", text: "Робот KUKA действует на площадке МИДиС. Он лечит людей без врачей.", cards: [laboratory()], ask: async () => ({ status: "ready", output: { claims: [] } }) });
  assert.equal(result.status, "failed");
  const { checkFactText } = await import("../lib/fact-check");
  const ordinary = checkFactText("Общая площадь кампуса составляет 987654321 квадратных метров.", knowledgeSeedCards);
  assert.deepEqual(subject.mergeAiFactReview(ordinary, { status: "failed" }), ordinary);
});

test("a valid citation cannot confirm an invented number or supply an invented correction", async () => {
  const subject = await import("../lib/canon-ai");
  const card = laboratory();
  const result = await subject.reviewFactsWithAi({ request: new Request("https://canon.invalid"), accountId: "test", text: "Робот KUKA обучил 5000 врачей.", cards: [card], ask: async (_r, _a, _i, input) => {
    const { sources } = JSON.parse(input);
    const source = sources[0];
    const fact = source.facts.find((fact: { field: string }) => fact.field === "referenceDescription");
    return { status: "ready", output: { claims: [{ id: 1, verdict: "supported", explanation: "Есть в карточке", correction: "Робот обучил 6000 врачей.", evidence: [{ sourceId: source.id, factId: fact.id, quote: fact.text }] }] } };
  } });
  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.equal(result.claims[0].verdict, "unknown");
    assert.equal(result.claims[0].correction, "");
  }
});

test("all AI actions share quota and an aborted request never reaches a provider", async () => {
  const subject = await import("../lib/flash-assist");
  assert.equal(typeof subject.runLimitedAi, "function", "Common AI limit is missing");
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const stopped = await subject.runLimitedAi(new Request("https://canon.invalid", { signal: controller.signal }), "quota-aborted", async () => { calls++; return "unexpected"; });
  assert.equal(stopped.status, "failed");
  assert.equal(calls, 0);
  let release!: (value: string) => void;
  const first = subject.runLimitedAi(new Request("https://canon.invalid"), "quota-shared-096", () => new Promise<string>(resolve => { release = resolve; }));
  const second = await subject.runLimitedAi(new Request("https://canon.invalid"), "quota-shared-096", async () => "unexpected");
  assert.equal(second.status, "busy");
  release("done");
  assert.deepEqual(await first, { status: "ready", value: "done" });
});

test("chat uses current evidence, builds its own links and never charges anonymous visitors", async () => {
  const subject = await import("../lib/canon-ai");
  assert.equal(typeof subject.answerCanonChat, "function", "Grounded chat is missing");
  let calls = 0;
  const input = { request: new Request("https://canon.invalid"), accountId: null, question: "KUKA", cards: [laboratory()] };
  const anonymous = await subject.answerCanonChat({ ...input, ask: async () => { calls++; throw new Error("not allowed"); } });
  assert.equal(calls, 0);
  assert.ok(anonymous.citations.every(citation => citation.href.startsWith("/knowledge?")));
  const staff = await subject.answerCanonChat({ ...input, accountId: "staff", ask: async (_r, _a, _i, payload) => {
    const { sources } = JSON.parse(payload);
    const source = sources[0];
    const fact = source.facts.find((fact: { field: string }) => fact.field === "referenceDescription");
    return { status: "ready", output: { quotes: [{ sourceId: source.id, factId: fact.id, quote: fact.text }], service: null, clarify: false } };
  } });
  assert.equal(staff.status, "ready");
  assert.equal(staff.citations[0].quote, laboratory().referenceDescription);
  assert.ok(staff.citations[0].href.includes("version=cv-"));
});

test("citing real equipment does not establish an invented nonnumeric capability", async () => {
  const subject = await import("../lib/canon-ai");
  const result = await subject.reviewFactsWithAi({ request: new Request("https://canon.invalid"), accountId: "test", text: "Робот KUKA самостоятельно лечит пациентов без участия врачей.", cards: [laboratory()], ask: async (_r, _a, _i, input) => {
    const { sources } = JSON.parse(input);
    const source = sources[0];
    const fact = source.facts.find((fact: { field: string }) => fact.field.startsWith("equipment."));
    return { status: "ready", output: { claims: [{ id: 1, verdict: "supported", explanation: "Подтверждено оборудованием", correction: "", evidence: [{ sourceId: source.id, factId: fact.id, quote: fact.text }] }] } };
  } });
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.equal(result.claims[0].verdict, "unknown");
});

test("a genuine partner quote cannot verify placement or contradict an unrelated unknown claim", async () => {
  const subject = await import("../lib/canon-ai");
  const card = { ...laboratory(), partner: "Учебный партнёр" } as KnowledgeCard;
  for (const [text, verdict] of [[card.referenceDescription, "supported"], ["ЮУрГУ открыл космическую больницу на Луне.", "contradicted"]] as const) {
    const result = await subject.reviewFactsWithAi({ request: new Request("https://canon.invalid"), accountId: "test", text, cards: [card], ask: async (_r, _a, _i, input) => {
      const { sources } = JSON.parse(input);
      const source = sources[0];
      const fact = source.facts.find((fact: { field: string }) => fact.field === "partner");
      return { status: "ready", output: { claims: [{ id: 1, verdict, explanation: "Есть ссылка на карточку", correction: "", evidence: [{ sourceId: source.id, factId: fact.id, quote: fact.text }] }] } };
    } });
    assert.equal(result.status, "ready");
    if (result.status === "ready") assert.equal(result.claims[0].verdict, "unknown");
  }
});

test("natural chat questions find KUKA but an unrelated real quote is never a false answer", async () => {
  const subject = await import("../lib/canon-ai");
  for (const question of ["Где находится KUKA?", "Что известно об оборудовании KUKA?", "Есть ли KUKA?"]) {
    const result = await subject.answerCanonChat({ request: new Request("https://canon.invalid"), accountId: null, question, cards: [laboratory()] });
    assert.ok(result.citations.length, question);
  }
  const unrelated = await subject.answerCanonChat({ request: new Request("https://canon.invalid"), accountId: "staff", question: "Где находится неведомая орбитальная больница?", cards: [laboratory()], ask: async (_r, _a, _i, input) => {
    const { sources } = JSON.parse(input);
    const source = sources[0];
    const fact = source.facts.find((fact: { field: string }) => fact.field.startsWith("equipment."));
    return { status: "ready", output: { quotes: [{ sourceId: source.id, factId: fact.id, quote: fact.text }], service: null, clarify: false } };
  } });
  assert.equal(unrelated.citations.length, 0);
});

test("a directly negated quoted fact is a sourced AI contradiction", async () => {
  const subject = await import("../lib/canon-ai");
  const result = await subject.reviewFactsWithAi({ request: new Request("https://canon.invalid"), accountId: "test", text: "Робот KUKA не действует на площадке МИДиС.", cards: [laboratory()], ask: async (_r, _a, _i, input) => {
    const { sources } = JSON.parse(input); const source = sources[0];
    const fact = source.facts.find((fact: { field: string }) => fact.field === "referenceDescription");
    return { status: "ready", output: { claims: [{ id: 1, verdict: "contradicted", explanation: "В карточке прямо сказано, что робот действует.", correction: fact.text, evidence: [{ sourceId: source.id, factId: fact.id, quote: fact.text }] }] } };
  } });
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.equal(result.claims[0].verdict, "contradicted");
});

test("a pronominal follow-up uses prior user context without dropping a new named condition", async () => {
  const subject = await import("../lib/canon-ai");
  const common = { request: new Request("https://canon.invalid"), accountId: null, cards: [laboratory()], history: ["Робот KUKA"] };
  const followup = await subject.answerCanonChat({ ...common, question: "А где он находится?" });
  assert.ok(followup.citations.length);
  const different = await subject.answerCanonChat({ ...common, question: "А где находится FANUC?" });
  assert.equal(different.citations.length, 0);
});

test("an extracted positive substring of a denial cannot become confirmed evidence", async () => {
  const subject = await import("../lib/canon-ai");
  const card = { ...laboratory(), referenceDescription: "Неверно утверждать, что робот KUKA лечит пациентов. Устройство используется для учебных испытаний." } as KnowledgeCard;
  const result = await subject.reviewFactsWithAi({ request: new Request("https://canon.invalid"), accountId: "test", text: "Робот KUKA лечит пациентов.", cards: [card], ask: async (_r, _a, _i, payload) => {
    const { sources } = JSON.parse(payload); const source = sources[0];
    const fact = source.facts.find((fact: { field: string }) => fact.field === "referenceDescription");
    return { status: "ready", output: { claims: [{ id: 1, verdict: "supported", explanation: "Подтверждено", correction: "", evidence: [{ sourceId: source.id, factId: fact.id, quote: "робот KUKA лечит пациентов." }] }] } };
  } });
  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.equal(result.claims[0].verdict, "unknown");
    assert.ok(result.claims[0].evidence[0].quote.startsWith("Неверно утверждать"));
  }
});

test("model commentary cannot attach an invented fact to a valid green source", async () => {
  const subject = await import("../lib/canon-ai");
  const result = await subject.reviewFactsWithAi({ request: new Request("https://canon.invalid"), accountId: "test", text: laboratory().referenceDescription, cards: [laboratory()], ask: async (_r, _a, _i, payload) => {
    const { sources } = JSON.parse(payload); const source = sources[0];
    const fact = source.facts.find((fact: { field: string }) => fact.field === "referenceDescription");
    return { status: "ready", output: { claims: [{ id: 1, verdict: "supported", explanation: "Робот KUKA вылечил 5000 пациентов.", correction: "", evidence: [{ sourceId: source.id, factId: fact.id, quote: fact.text }] }] } };
  } });
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.doesNotMatch(result.claims[0].explanation, /5000|вылечил/u);
});

test("a location question never uses a partner field as its answer", async () => {
  const subject = await import("../lib/canon-ai");
  const card = { ...laboratory(), partner: "Учебный партнёр", placementDetails: "На площадке МИДиС." } as KnowledgeCard;
  const result = await subject.answerCanonChat({ request: new Request("https://canon.invalid"), accountId: "staff", question: "Где находится KUKA?", cards: [card], ask: async (_r, _a, _i, payload) => {
    const { sources } = JSON.parse(payload); const source = sources[0];
    const fact = source.facts.find((fact: { field: string }) => fact.field === "partner");
    return { status: "ready", output: { quotes: [{ sourceId: source.id, factId: fact.id, quote: fact.text }], service: null, clarify: false } };
  } });
  assert.ok(result.citations.length);
  assert.ok(result.citations.every(citation => citation.field !== "partner"));
  assert.ok(result.citations.some(citation => citation.field === "placementDetails"));
});

test("a sentence cannot discard the preceding hypothetical or rebuttal context of a canonical field", async () => {
  const subject = await import("../lib/canon-ai");
  const { checkEditorialEvidence } = await import("../lib/editorial-evidence");
  const text = "Робот KUKA лечит пациентов.";
  for (const prefix of ["Гипотетический сценарий на 2027 год.", "Ниже перечислены опровергнутые утверждения:\n"]) {
    const card = { ...laboratory(), referenceDescription: `${prefix} ${text}`, stopFormula: "Не утверждать, что робот KUKA лечит пациентов." } as KnowledgeCard;
    assert.equal(checkEditorialEvidence(text, [card]).canPublish, false);
    const result = await subject.reviewFactsWithAi({ request: new Request("https://canon.invalid"), accountId: "test", text, cards: [card], ask: async (_r, _a, _i, payload) => {
      const { sources } = JSON.parse(payload); const source = sources[0];
      const fact = source.facts.find((fact: { field: string }) => fact.field === "referenceDescription");
      return { status: "ready", output: { claims: [{ id: 1, verdict: "supported", explanation: "Есть в источнике", correction: "", evidence: [{ sourceId: source.id, factId: fact.id, quote: text }] }] } };
    } });
    assert.equal(result.status, "ready");
    if (result.status === "ready") {
      assert.equal(result.claims[0].verdict, "unknown");
      assert.equal(subject.mergeAiFactReview((await import("../lib/fact-check")).checkFactText(text, [card]), result).canPublish, false);
    }
  }
});

test("chat keeps ordinary question words out of named constraints and respects a newly named model", async () => {
  const { answerCanonChat } = await import("../lib/canon-ai");
  const common = { request: new Request("https://canon.invalid"), accountId: null, cards: [laboratory()] };
  for (const question of ["Где работает KUKA?", "Какое оборудование у лаборатории KUKA?", "Кто партнёр KUKA?", "Что известно об оборудовании KUKA?"]) {
    const result = await answerCanonChat({ ...common, question });
    assert.ok(result.citations.length, question);
  }
  assert.ok((await answerCanonChat({ ...common, history: ["Робот KUKA"], question: "А где он работает?" })).citations.length);
  assert.equal((await answerCanonChat({ ...common, question: "Где работает FANUC?" })).citations.length, 0);
});

test("long canonical fields never make the chat response invalid for its client", async () => {
  const { answerCanonChat } = await import("../lib/canon-ai");
  const { parseAssistantAnswer } = await import("../components/assistant/assistant-answer");
  const card = { ...laboratory(), referenceDescription: "Робот KUKA. " + "Подробное утверждённое описание учебного стенда. ".repeat(36) };
  for (const accountId of [null, "staff"]) {
    const result = await answerCanonChat({ request: new Request("https://canon.invalid"), accountId, question: "KUKA", cards: [card], ask: async (_r, _a, _i, payload) => {
      const { sources } = JSON.parse(payload); const source = sources[0];
      const fact = source.facts.find((fact: { field: string }) => fact.field === "referenceDescription");
      return { status: "ready", output: { quotes: [{ sourceId: source.id, factId: fact.id, quote: fact.text.slice(0, 1000) }], service: null, clarify: false } };
    } });
    assert.ok(parseAssistantAnswer(result));
    assert.ok(result.citations.length);
    assert.ok(result.citations.every(citation => citation.quote.length <= 1200));
  }
});

test("several cited fields keep their own semantic units when verifying a claim", async () => {
  const { reviewFactsWithAi } = await import("../lib/canon-ai");
  const card = laboratory();
  const result = await reviewFactsWithAi({ request: new Request("https://canon.invalid"), accountId: "test", text: card.referenceDescription, cards: [card], ask: async (_r, _a, _i, payload) => {
    const { sources } = JSON.parse(payload); const source = sources[0];
    const facts = source.facts.filter((fact: { field: string }) => ["title", "referenceDescription"].includes(fact.field));
    return { status: "ready", output: { claims: [{ id: 1, verdict: "supported", explanation: "Подтверждено", correction: "", evidence: facts.map((fact: { id: string; text: string }) => ({ sourceId: source.id, factId: fact.id, quote: fact.text })) }] } };
  } });
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.equal(result.claims[0].verdict, "supported");
});

test("AI contradiction uses the whole cited unit and preserves numeric signs", async () => {
  const { reviewFactsWithAi } = await import("../lib/canon-ai");
  for (const [referenceDescription, text] of [
    ["Следующая формулировка неверна. Робот KUKA не работает на площадке МИДиС.", "Робот KUKA работает на площадке МИДиС."],
    ["В учебном примере система не получила −12 условных баллов.", "В учебном примере система получила +12 условных баллов."],
    ["Робот KUKA не оснащён синим модулем?", "Робот KUKA оснащён синим модулем."],
  ]) {
    const card = { ...laboratory(), referenceDescription };
    const result = await reviewFactsWithAi({ request: new Request("https://canon.invalid"), accountId: "test", text, cards: [card], ask: async (_r, _a, _i, payload) => {
      const { sources } = JSON.parse(payload); const source = sources[0]; const fact = source.facts.find((fact: { field: string }) => fact.field === "referenceDescription");
      return { status: "ready", output: { claims: [{ id: 1, verdict: "contradicted", explanation: "Противоречие", correction: "", evidence: [{ sourceId: source.id, factId: fact.id, quote: fact.text }] }] } };
    } });
    assert.equal(result.status, "ready");
    if (result.status === "ready") assert.equal(result.claims[0].verdict, "unknown");
  }
});

test("a contradiction from another field cannot validate an unrelated AI citation", async () => {
  const { reviewFactsWithAi } = await import("../lib/canon-ai");
  const seed = knowledgeSeedCards.find(card => card.type === "campus")!;
  const card: KnowledgeCard = { ...seed, status: "approved", referenceDescription: "Карточка описывает методику подготовки документов.", campusMetrics: seed.campusMetrics.map((metric, index) => index === 0 ? { ...metric, value: "160 000 кв. м" } : metric) };
  const text = "Общая площадь объектов кампуса — 150 000 кв. м.";
  assert.ok((await import("../lib/fact-check")).checkFactText(text, [card]).summary.red > 0);
  const result = await reviewFactsWithAi({ request: new Request("https://canon.invalid"), accountId: "test", text, cards: [card], ask: async (_r, _a, _i, payload) => {
    const { sources } = JSON.parse(payload); const source = sources[0]; const fact = source.facts.find((fact: { field: string }) => fact.field === "referenceDescription");
    return { status: "ready", output: { claims: [{ id: 1, verdict: "contradicted", explanation: "Не совпадает площадь", correction: "", evidence: [{ sourceId: source.id, factId: fact.id, quote: fact.text }] }] } };
  } });
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.equal(result.claims[0].verdict, "unknown");
});

test("equipment questions cite the requested model within a multi-model card", async () => {
  const { answerCanonChat } = await import("../lib/canon-ai");
  const card: KnowledgeCard = { ...laboratory(), equipment: ["Робот-манипулятор KUKA", "Робот-манипулятор FANUC"] } as KnowledgeCard;
  for (const accountId of [null, "staff"]) {
    const result = await answerCanonChat({ request: new Request("https://canon.invalid"), accountId, question: "Что известно об оборудовании FANUC?", cards: [card], ask: async (_r, _a, _i, payload) => {
      const { sources } = JSON.parse(payload); const source = sources[0]; const fact = source.facts.find((fact: { field: string }) => fact.field === "equipment.0");
      return { status: "ready", output: { quotes: [{ sourceId: source.id, factId: fact.id, quote: fact.text }], service: null, clarify: false } };
    } });
    assert.ok(result.citations.length);
    assert.ok(result.citations.every(citation => citation.quote.includes("FANUC")));
  }
});
