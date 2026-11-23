import assert from "node:assert/strict";
import { test } from "node:test";
import { answerCanonChat, type CanonChatAnswer } from "../lib/canon-ai";
import { readBrowserDemo } from "../lib/browser-demo";
import { createBrowserDemoRequest } from "../lib/browser-demo-http";
import { handleDemoTools } from "../lib/browser-demo-tools";
import { knowledgeSeedCards } from "../lib/knowledge";

async function ask(message: string): Promise<CanonChatAnswer> {
  const storage = {
    getItem: () => null,
    setItem: () => assert.fail("Assistant wrote data"),
  };
  const request = createBrowserDemoRequest(storage, readBrowserDemo(storage), [
    handleDemoTools,
  ]);
  const response = await request("/api/assistant", {
    method: "POST",
    body: JSON.stringify({ message }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

const examples = [
  { question: "Какова общая площадь кампуса?", quote: /121,8–123 тыс\. м²/iu },
  {
    question: "Какие вузы входят в кампус?",
    quote: /7 равноправных вузов-резидентов/iu,
  },
  { question: "Как проверить текст по справочнику?", route: /^\/check$/u },
  {
    question: "Сколько мест для проживания в кампусе?",
    quote: /3 400 мест для проживания/iu,
  },
  {
    question: "Где открыть паспорт кампуса?",
    route: /^\/knowledge\?card=campus-passport&version=cv-/u,
  },
  {
    question: "Как найти карточку университета?",
    route: /^\/knowledge\?folder=01_universities$/u,
  },
  {
    question: "Какие лаборатории проектируют в учебно-научном корпусе?",
    quote: /проектируется 40–44 лаборатории/iu,
  },
  {
    question: "Какие этапы строительства указаны в паспорте?",
    quote: /2024 \/ 2026 \/ 2027–2028/iu,
  },
  { question: "Где подготовить черновик публикации?", route: /^\/editor$/u },
  {
    question:
      "Подскажите, сколько мест для проживания предусмотрено в кампусе?",
    quote: /3 400 мест для проживания/iu,
  },
  { question: "Сколько мест в кампусе?", quote: /3 400 мест для проживания/iu },
  {
    question: "Сколько мест для проживания в гостиницах кампуса?",
    quote: /8 гостиниц на 3 400 мест для проживания/iu,
  },
  {
    question: "Каков региональный портфель программ кампуса?",
    quote: /Региональный портфель: 8 программ/iu,
  },
  { question: "Где можно проверить факты из статьи?", route: /^\/check$/u },
];

for (const { question, quote, route } of examples) {
  test(question, async () => {
    const answer = await ask(question);
    assert.equal(answer.status, "local");
    assert.doesNotMatch(answer.message, /ничего не найдено/iu);
    if (quote) {
      const citation = answer.citations.find((citation) =>
        quote.test(citation.quote)
      );
      assert.ok(citation, "A complete approved field answers the question");
      assert.match(
        citation.href,
        /^\/knowledge\?card=campus-passport&version=cv-/u
      );
    }
    if (route)
      assert.ok(
        answer.actions.some((action) => route.test(action.href)),
        "A relevant action opens the requested section"
      );
  });
}

for (const question of [
  "Сколько космодромов построили в кампусе?",
  "Какие лаборатории работают в учебно-научном корпусе?",
  "Какие этапы строительства были в 2011 году в кампусе?",
  "Сколько мест для проживания в кампусе в 2024 году?",
  "Сколько программ проектируют в УНК?",
  "Сколько обучающихся в гостиницах кампуса?",
]) {
  test(`unconfirmed: ${question}`, async () => {
    const answer = await ask(question);
    assert.deepEqual(answer.citations, []);
    assert.match(answer.message, /ничего не найдено/iu);
  });
}

for (const question of [
  "Сколько программ проектируют в УНК?",
  "Сколько обучающихся в гостиницах кампуса?",
]) {
  test(`working fallback keeps unrelated statistics out: ${question}`, async () => {
    const answer = await answerCanonChat({
      question,
      cards: knowledgeSeedCards,
      request: new Request("http://localhost:8080/api/assistant"),
      accountId: null,
      ask: async () => assert.fail("Guest fallback called AI"),
    });
    assert.deepEqual(answer.citations, []);
    assert.match(answer.message, /не найдены/iu);
  });
}

test("membership example guides to resident cards when the approved passport has only a count", async () => {
  const seed = knowledgeSeedCards.find((card) => card.type === "campus");
  assert.ok(seed && seed.type === "campus");
  const card = { ...seed, referenceDescription: "Паспорт межуниверситетского кампуса.",
    campusMetrics: [{ label: "Вузы-резиденты", value: "7 вузов", note: "Сведения из официального сообщения." }] };
  const answer = await answerCanonChat({
    question: "Какие вузы входят в кампус?", cards: [card],
    request: new Request("http://localhost:8080/api/assistant"), accountId: null,
    ask: async () => assert.fail("Guest guide called AI"),
  });
  assert.deepEqual(answer.citations, [], "A count is not a list of member names");
  assert.doesNotMatch(answer.message, /не найдены/iu);
  assert.ok(answer.actions.some(action => action.href === "/knowledge?folder=01_universities"));
  for (const question of ["Какие частные вузы входят в кампус?", "Какие вузы не входят в кампус?",
    "Какие вузы входят в кампус в 2020 году?", "Какие вузы входят в кампус «Северный Урал»?",
    "Сколько вузов входит в кампус?", "Какие вузы входят в кампусы?", "Вузы входят в кампус?"]) {
    const constrained = await answerCanonChat({
      question, cards: [card], request: new Request("http://localhost:8080/api/assistant"), accountId: null,
      ask: async () => assert.fail("Guest guide called AI"),
    });
    assert.deepEqual(constrained.citations, [], question);
    assert.ok(!constrained.actions.some(action => action.href === "/knowledge?folder=01_universities"), question);
  }
});
