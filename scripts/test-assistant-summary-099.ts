import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAssistantAnswer } from "../components/assistant/assistant-answer";
import { answerCanonChat, currentCanonSources } from "../lib/canon-ai";
import { assistantFactSummary } from "../lib/assistant-query";
import { resolveCanonReference } from "../lib/canon-context";
import { knowledgeSeedCards, type KnowledgeCard } from "../lib/knowledge";

const request = new Request("https://canon.invalid/api/assistant");
const seedCampus = knowledgeSeedCards.find((card) => card.type === "campus")!;
const campus: KnowledgeCard = {
  ...seedCampus,
  title: "Паспорт межуниверситетского кампуса «Южный Урал»",
  referenceDescription: "К проекту относятся семь вузов региона.",
  campusMetrics: [
    {
      label: "Вузы-резиденты",
      value: "7 вузов",
      note: "По сообщению вуза от 13.02.2026.",
    },
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
      note: "Вместимость после двух гостиничных очередей.",
    },
    {
      label: "Апартаменты А5",
      value: "90 апартаментов",
      note: "По сообщению вуза от 16.09.2026. Единица — апартаменты.",
    },
  ],
  verifiedFacts: [],
};

const local = (question: string, cards: KnowledgeCard[] = [campus]) =>
  answerCanonChat({
    request,
    accountId: null,
    question,
    cards,
    ask: async () => assert.fail("Anonymous assistant called a paid provider"),
  });

const passportHref = /^\/knowledge\?card=campus-passport&version=cv-/u;

test("a clear question about missing campus area gives the passport version", async () => {
  for (const question of [
    "Какова площадь кампуса?",
    "Какая площадь у кампуса?",
    "Какова площадь межуниверситетского кампуса Южный Урал?",
    "Какова общая площадь кампуса в квадратных метрах?",
    "Какова общая площадь кампуса «Южный Урал»? Дайте ссылку.",
  ]) {
    const answer = await local(question);
    assert.match(answer.message, /площадь.+не указана/iu, question);
    assert.doesNotMatch(answer.message, /уточните|\d/u);
    assert.deepEqual(answer.citations, []);
    assert.ok(answer.actions.some((action) => passportHref.test(action.href)));
  }
});

test("the answer states the exact campus statistic with its scope and version", async () => {
  for (const [question, value, scope, note] of [
    [
      "Сколько мест для проживания в кампусе?",
      "3 400 мест в 8 гостиницах",
      "Вместимость",
      "после двух гостиничных очередей",
    ],
    [
      "Сколько апартаментов А5 в кампусе?",
      "90 апартаментов",
      "А5",
      "16.09.2026",
    ],
    ["Сколько апартаментов А5?", "90 апартаментов", "А5", "16.09.2026"],
    ["Сколько вузов в кампусе?", "7 вузов", "резидент", "13.02.2026"],
  ]) {
    const answer = await local(question);
    assert.ok(answer.message.includes(value), question);
    assert.ok(
      answer.message.toLowerCase().includes(scope.toLowerCase()),
      question
    );
    assert.ok(answer.message.includes(note), question);
    assert.match(answer.citations[0].href, passportHref);
    assert.ok(answer.citations[0].quote.includes(note), question);
    assert.equal(parseAssistantAnswer(answer)?.presentation, "summary");
  }
});

test("each hotel phase uses its own approved row and retains its note", async () => {
  for (const [question, label, value, note] of [
    [
      "Сколько мест в первой очереди гостиниц кампуса?",
      "Первая очередь гостиниц",
      "336 мест",
      "22.03.2024",
    ],
    [
      "Сколько мест во второй очереди гостиниц кампуса?",
      "Вторая очередь гостиниц",
      "3 064 места",
      "16.06.2026",
    ],
  ]) {
    const answer = await local(question);
    assert.ok(answer.message.includes(label), question);
    assert.ok(answer.message.includes(value), question);
    assert.ok(answer.message.includes(note), question);
    assert.doesNotMatch(answer.message, /3 400|8 гостиниц/u);
    assert.deepEqual(
      answer.citations.map((citation) => citation.label),
      [label]
    );
    assert.match(answer.citations[0].href, passportHref);
  }
  const noCapacity = {
    ...campus,
    campusMetrics: campus.campusMetrics.map((metric) =>
      metric.label === "Вторая очередь гостиниц"
        ? { ...metric, value: "6 корпусов" }
        : metric
    ),
  };
  const missing = await local(
    "Сколько мест во второй очереди гостиниц кампуса?",
    [noCapacity]
  );
  assert.deepEqual(missing.citations, []);
});

test("an unscoped apartment question requires a unique matching passport row", async () => {
  const secondCampus = {
    ...campus,
    id: "alternative-campus",
    title: "Паспорт кампуса «Второй»",
    campusMetrics: [
      { label: "Апартаменты А5", value: "А5, 50 апартаментов", note: "" },
    ],
  };
  const answer = await local("Сколько апартаментов А5?", [
    campus,
    secondCampus,
  ]);
  assert.deepEqual(answer.citations, []);
});

test("similar terms do not remove a campus, measurement, date, or status constraint", async () => {
  for (const question of [
    "Какова площадь кампуса «Северный Урал»?",
    "Какая площадь у межуниверситетского кампуса Северный Урал в квадратных метрах?",
    "Какова площадь учебно-научного корпуса кампуса в квадратных метрах?",
    "Какова площадь кампуса в гектарах?",
    "Сколько мест для проживания в кампусе в 2024 году?",
    "Сколько мест во второй очереди гостиниц кампуса в 2024 году?",
    "Сколько свободных мест во второй очереди гостиниц кампуса?",
    "Сколько апартаментов в кампусе?",
    "Сколько апартаментов А5 заселено в кампусе?",
    "Сколько апартаментов А5 заселено?",
    "Сколько обучающихся в гостиницах кампуса?",
    "Сколько мест для проживания вне кампуса?",
    "Сколько мест для проживания в кампусе кроме А5?",
  ]) {
    const answer = await local(question);
    assert.deepEqual(answer.citations, [], question);
    assert.ok(
      !answer.actions.some((action) => passportHref.test(action.href)),
      question
    );
  }
});

const lab = knowledgeSeedCards.find(
  (card) => card.type === "laboratory" && card.title.includes("KUKA")
)!;
const labRequest = {
  request,
  accountId: "staff",
  question: "Кратко расскажи про KUKA и дай ссылку.",
  cards: [lab],
};

test("short answers omit dangling URL-only source footers while keeping plans and full quotations", async () => {
  const narrative = "Робот KUKA помогает создавать модели. В 2024 году институт объявил о намерении открыть отдельную лабораторию.";
  const card = { ...lab, referenceDescription: narrative + "\n\nМИДиС — https://example.org/source\nМИДиС (2024-10-18) — https://example.org/plan" };
  const answer = await answerCanonChat({ ...labRequest, cards: [card], ask: async (_request, _accountId, _instruction, payload) => {
    const { sources } = JSON.parse(payload);
    const source = sources[0];
    const reference = { sourceId: source.id, factId: source.facts.find((fact: { field: string }) => fact.field === "referenceDescription").id };
    return { status: "ready", output: { quotes: [reference], summary: [reference], service: null, clarify: false } };
  } });
  assert.equal(answer.message, narrative);
  assert.ok(answer.citations[0].quote.includes("МИДиС (2024-10-18) —"));
  assert.ok(answer.citations[0].quote.includes("намерении"));
});

test("a trailing dash in a time condition is narrative, including after a paragraph break", () => {
  for (const separator of ["\n", "\n\n"]) {
    const description = "Лаборатория будет работать на площадке МИДиС." + separator + "Только после ввода в 2027 году —";
    const sources = currentCanonSources([{ ...lab, referenceDescription: description }]);
    const source = sources[0];
    const fact = source.facts.find(item => item.field === "referenceDescription")!;
    const citation = resolveCanonReference({ sourceId: source.id, factId: fact.id }, sources)!;
    assert.equal(assistantFactSummary(citation), description);
    assert.equal(citation.quote, description);
  }
});

test("staff AI selects the order of supported short statements with full citations", async () => {
  const answer = await answerCanonChat({
    ...labRequest,
    ask: async (_request, _accountId, _instruction, payload) => {
      const { sources } = JSON.parse(payload);
      const source = sources[0];
      const quote = (field: string) => ({
        sourceId: source.id,
        factId: source.facts.find(
          (fact: { field: string }) => fact.field === field
        ).id,
      });
      const equipment = quote("equipment.0");
      const placement = quote("placementDetails");
      return {
        status: "ready",
        output: {
          quotes: [placement, equipment],
          summary: [equipment, placement],
          service: null,
          clarify: false,
        },
      };
    },
  });
  assert.equal(answer.status, "ready");
  assert.equal(answer.presentation, "summary");
  assert.equal(answer.citations[0].field, "equipment.0");
  assert.equal(answer.citations[1].field, "placementDetails");
  assert.ok(answer.message.includes(answer.citations[0].quote));
  assert.ok(answer.message.includes(answer.citations[1].quote));
  assert.ok(
    answer.message.indexOf(answer.citations[0].quote) <
      answer.message.indexOf(answer.citations[1].quote)
  );
  assert.ok(
    answer.citations.every(({ href }) => href.includes("&version=cv-"))
  );
});

test("model summary cannot insert prose, unsupported IDs, or uncited statements", async () => {
  for (const mutation of ["prose", "unknown", "unquoted"]) {
    const answer = await answerCanonChat({
      ...labRequest,
      ask: async (_request, _accountId, _instruction, payload) => {
        const { sources } = JSON.parse(payload);
        const source = sources[0];
        const reference = { sourceId: source.id, factId: source.facts[0].id };
        const summary =
          mutation === "prose"
            ? [{ ...reference, text: "KUKA ежедневно лечит 900 пациентов" }]
            : mutation === "unknown"
              ? [{ ...reference, factId: "fake" }]
              : [{ ...reference, factId: source.facts[1].id }];
        return {
          status: "ready",
          output: {
            quotes: [reference],
            summary,
            service: null,
            clarify: false,
          },
        };
      },
    });
    assert.equal(answer.status, "failed", mutation);
    assert.doesNotMatch(answer.message, /900 пациентов/u);
  }
});
