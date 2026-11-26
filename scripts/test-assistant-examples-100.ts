import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAssistantAnswer } from "../components/assistant/assistant-answer";
import { readBrowserDemo } from "../lib/browser-demo";
import { createBrowserDemoRequest } from "../lib/browser-demo-http";
import { handleDemoTools } from "../lib/browser-demo-tools";
import { answerCanonChat, currentCanonSources } from "../lib/canon-ai";
import { knowledgeSeedCards, type KnowledgeCard } from "../lib/knowledge";

const campus = knowledgeSeedCards.find(card => card.type === "campus");
assert.ok(campus);
const kuka = knowledgeSeedCards.find(card => card.id === "lab-midis-kuka" && card.type === "laboratory");
assert.ok(kuka && kuka.type === "laboratory");
const request = new Request("http://localhost:8080/api/assistant");
const local = (question: string, cards: KnowledgeCard[] = knowledgeSeedCards) =>
  answerCanonChat({
    request, accountId: null, question, cards,
    ask: async () => assert.fail("Anonymous assistant called AI"),
  });

const examples = [
  {
    question: "Чем отличаются первая и вторая очереди гостиниц кампуса?",
    content: [/336 мест/u, /3 064 места/u],
    ids: ["campus-passport"],
  },
  {
    question: "Как различаются 1-я и 2-я очереди гостиниц кампуса «Южный Урал»?",
    content: [/336 мест/u, /3 064 места/u],
    ids: ["campus-passport"],
  },
  {
    question: "Сколько мест в первой очереди гостиниц кампуса?",
    content: [/336 мест/u],
    ids: ["campus-passport"],
  },
  {
    question: "Сколько мест во второй очереди гостиниц кампуса?",
    content: [/3 064 места/u],
    ids: ["campus-passport"],
  },
  {
    question: "Сколько мест в первой и во второй очередях гостиниц кампуса?",
    content: [/336 мест/u, /3 064 места/u],
    ids: ["campus-passport"],
  },
  {
    question: "Где расположен центр промышленного дизайна МИДиС с роботом KUKA?",
    content: [/Ворошилова, 12/u, /планируется в УНК кампуса/u],
    ids: ["lab-midis-kuka"],
  },
  {
    question: "Где находится робот KUKA?",
    content: [/Ворошилова, 12/u, /планируется в УНК кампуса/u],
    ids: ["lab-midis-kuka"],
  },
  {
    question: "Какие вузы участвуют в совместных проектах?",
    content: [/МИДиС/u, /ЮУГМУ/u, /ЮУрГАУ/u, /ЧелГУ/u],
    ids: ["joint-midis-susmu-trauma", "joint-sursau-csu-agro-ai"],
  },
  {
    question: "Какие сведения о размещении лабораторий подтверждены?",
    content: [/Ворошилова, 12/u, /Ленина, 76/u, /Планируется к открытию/u],
    ids: ["lab-midis-kuka", "lab-susu-digital-twins", "lab-susmu-vr-biomed", "lab-csu-microelectronics-insmart"],
  },
  {
    question: "Какие проекты связаны с экологией?",
    content: [/Экомонитор/u, /мониторинг водоёмов/u],
    ids: ["project-susu-ecomonitor", "project-csu-water-monitoring"],
  },
  {
    question: "Что известно о виртуальном тренажёре «Травмпункт»?",
    content: [/МИДиС отвечает за 3D-моделирование/u, /ЮУГМУ — за медицинскую экспертизу/u],
    ids: ["joint-midis-susmu-trauma"],
  },
] as const;

test("natural questions answer from current full approved fields", async () => {
  const sources = currentCanonSources(knowledgeSeedCards);
  for (const { question, content, ids } of examples) {
    const answer = parseAssistantAnswer(await local(question));
    assert.ok(answer, question);
    assert.equal(answer.presentation, "summary", question);
    for (const part of content) assert.match(answer.message, part, question);
    assert.deepEqual([...new Set(answer.citations.map(citation => citation.cardId))].sort(), [...ids].sort(), question);
    for (const citation of answer.citations) {
      const source = sources.find(source => source.cardId === citation.cardId);
      assert.equal(citation.href, source?.href, question);
      assert.equal(citation.quote, source?.facts.find(fact => fact.id === citation.factId)?.text, question);
    }
  }
});

test("the campus area answer includes the approved passport version when asked for sources", async () => {
  const question = "Какова общая площадь кампуса и из каких источников это известно?";
  const answer = await answerCanonChat({
    request, accountId: "author-fixture", question, cards: knowledgeSeedCards,
    ask: async () => ({ status: "failed" }),
  });
  assert.equal(answer.status, "local");
  assert.equal(answer.presentation, "summary");
  assert.match(answer.message, /121,8–123 тыс\. м²/u);
  assert.equal(answer.citations.length, 1);
  const [citation] = answer.citations;
  assert.equal(citation.cardId, "campus-passport");
  assert.equal(citation.label, "Общая площадь объектов");
  assert.match(citation.quote, /^121,8–123 тыс\. м²/u);
  const sourceUrl = new URL(citation.href, request.url);
  assert.equal(sourceUrl.pathname, "/knowledge");
  assert.equal(sourceUrl.searchParams.get("card"), citation.cardId);
  assert.equal(sourceUrl.searchParams.get("version"), citation.versionId);
  assert.ok(citation.versionId);
});

test("asking for sources preserves the constraints of a campus area question", async () => {
  for (const question of [
    "Какова площадь УНК кампуса и из каких источников это известно?",
    "Какова общая площадь кампуса без УНК и из каких источников это известно?",
    "Какова общая площадь кампуса в 2024 году и из каких источников это известно?",
    "Какова общая площадь кампуса «Северный Урал» и из каких источников это известно?",
    "Какова планируемая общая площадь кампуса и из каких источников это известно?",
    "Какова общая площадь кампуса и из каких источников это известно за 2024 год?",
  ]) {
    const answer = await local(question);
    assert.deepEqual(answer.citations, [], question);
    assert.ok(!answer.actions.some(action => action.href.includes("card=campus-passport")), question);
  }
});

test("access help explains Yandex sign-in and the roles for authors and coordinators", async () => {
  const answer = await local("Как получить доступ?");
  assert.match(answer.message, /Войти через Яндекс/u);
  assert.match(answer.message, /роль автора/u);
  assert.match(answer.message, /координатор/u);
  assert.doesNotMatch(answer.message, /подтвердите электронную почту/u);
  assert.ok(answer.actions.some(action => action.href === "/login"));
});

test("hotel queries preserve the phase boundary and choose approved standalone rows", async () => {
  const current = { ...campus, campusMetrics: [
    { label: "Первая очередь гостиниц", value: "2 корпуса на 352 места", note: "Проектный показатель." },
    { label: "Вторая очередь гостиниц", value: "6 корпусов на 3 032 места", note: "Разрешение на ввод от 16.06.2026." },
    { label: "Общая вместимость гостиниц", value: "3 384 места", note: "" },
  ] };
  const answer = await local("Сравни первую и вторую очереди гостиниц кампуса", [current]);
  assert.match(answer.message, /352 места[^\n]*Проектный показатель/u);
  assert.match(answer.message, /3 032 места[^\n]*16\.06\.2026/u);
  assert.doesNotMatch(answer.message, /336 мест|3 064|3 384/u);
  assert.deepEqual(answer.citations.map(citation => citation.label), [
    "Первая очередь гостиниц", "Вторая очередь гостиниц",
  ]);
  const descriptionOnly = { ...campus, campusMetrics: [] };
  const unrelated = { ...descriptionOnly, referenceDescription: "В первой очереди УНК предусмотрено 240 мест в аудиториях. Общая вместимость гостиниц — 3 400 мест." };
  assert.deepEqual((await local("Сколько мест в первой очереди гостиниц кампуса?", [unrelated])).citations, []);
  const education = { ...unrelated, campusMetrics: [{
    label: "Этапы строительства (3 очереди)",
    value: "2024 / 2026 / 2027–2028",
    note: "1-я (авг 2024): 2 учебных корпуса на 700 мест; 2-я (сент 2026): 3 учебных корпуса на 303 места; 3-я (УНК): 2027 / 2028 г.",
  }] };
  assert.deepEqual((await local("Сравни первую и вторую очереди гостиниц кампуса", [education])).citations, []);
});

test("legacy hotel capacity cannot come from a nearby academic building", async () => {
  const current = { ...campus, campusMetrics: [{
    label: "Этапы строительства (3 очереди)",
    value: "2024 / 2026 / 2027–2028",
    note: "1-я (авг 2024): гостиница без подтверждённой вместимости, 2 учебных корпуса на 700 мест; 2-я (сент 2026): 3 гостиницы / 303 места; 3-я (УНК): 2027 / 2028 г.",
  }] };
  assert.deepEqual((await local("Сколько мест в первой очереди гостиниц кампуса?", [current])).citations, []);
  assert.match((await local("Сколько мест во второй очереди гостиниц кампуса?", [current])).message, /303 места/u);
});

test("conflicting legacy schedules do not return a capacity", async () => {
  const metrics = [100, 300].map(first => ({
    label: "Этапы строительства (3 очереди)",
    value: "2024 / 2026 / 2027–2028",
    note: `1-я (авг 2024): 2 гост. / ${first} мест; 2-я (сент 2026): 3 гостиницы / ${first + 100} мест; 3-я (УНК): 2027 / 2028 г.`,
  }));
  assert.deepEqual((await local(examples[0].question, [{ ...campus, campusMetrics: metrics }])).citations, []);
});

test("standalone hotel capacity values must describe the named hotel phase", async () => {
  const current = { ...campus, campusMetrics: [{
    label: "Первая очередь гостиниц",
    value: "Вместимость гостиниц уточняется; на 2 учебных объектах 700 мест",
    note: "",
  }] };
  assert.deepEqual((await local("Сколько мест в первой очереди гостиниц кампуса?", [current])).citations, []);
});

test("free-form campus descriptions cannot establish separate hotel capacities", async () => {
  const current = {
    ...campus,
    campusMetrics: [],
    referenceDescription: "Ниже приведена неподтверждённая ранняя концепция. Строительство разделено на 3 этапа: 1-я очередь (2 гостиницы на 336 мест), 2-я очередь (6 корпусов на 888 мест) и 3-я очередь (УНК). Проектная вместимость гостиниц пока не утверждена. Шесть корпусов — учебные.",
  };
  assert.deepEqual((await local("Сколько мест во второй очереди гостиниц кампуса?", [current])).citations, []);
});

test("campus location stays a constraint regardless of its position and the equipment alias", async () => {
  for (const question of [
    "Где в УНК кампуса находится робот KUKA?",
    "Где находится робот KUKA на площадке кампуса?",
    "Где находится KUKA в УНК кампуса?",
    "Где находится КУКА в УНК кампуса?",
  ]) {
    assert.deepEqual((await local(question, [kuka])).citations, [], question);
  }
  const card = { ...kuka, placementDetails: "Робот KUKA установлен в УНК кампуса, этаж 2." };
  const supported = await local("Где в УНК кампуса находится робот KUKA?", [card]);
  assert.match(supported.message, /этаж 2/u);
  assert.deepEqual(supported.citations.map(citation => citation.quote), [card.placementDetails]);
});

test("a nearby clause with another model cannot answer equipment placement", async () => {
  const card = {
    ...kuka,
    equipment: ["Робот KUKA", "Робот FANUC"],
    placementDetails: "Робот KUKA ожидает поставки. Робот FANUC установлен в МИДиС, ул. Ворошилова, 12.",
  };
  for (const question of ["Где находится робот KUKA?", "Где находится KUKA?"]) {
    assert.deepEqual((await local(question, [card])).citations, [], question);
  }
  const onlyKuka = { ...card, placementDetails: "Робот KUKA установлен на площадке МИДиС (ул. Ворошилова, 12)." };
  assert.deepEqual((await local("Где находится робот FANUC?", [onlyKuka])).citations, []);

  const answer = await answerCanonChat({
    request, accountId: "staff", question: "Где находится KUKA?", cards: [card],
    ask: async () => ({
      status: "ready",
      output: { quotes: [{ sourceId: "s1", factId: currentCanonSources([card])[0].facts.find(fact => fact.field === "placementDetails")!.id }], service: null, clarify: false },
    }),
  });
  assert.deepEqual(answer.citations, []);
});

test("a model that appears only in an example cannot borrow the catalogued model's placement", async () => {
  const card = {
    ...kuka,
    equipment: ["Робот KUKA"],
    placementDetails: "Робот KUKA установлен в МИДиС.",
    referenceDescription: "В учебном сравнении приведён робот FANUC.",
  };
  assert.deepEqual((await local("Где находится робот FANUC?", [card])).citations, []);
  assert.deepEqual((await local("Где находится робот ФАНУК?", [card])).citations, []);
});

test("a project called УНК cannot stand in for the location predicate", async () => {
  const card = { ...kuka, placementDetails: "Робот KUKA находится на площадке МИДиС рядом с экспозицией проекта «УНК»." };
  assert.deepEqual((await local("Где находится робот KUKA в УНК кампуса?", [card])).citations, []);
});

test("unapproved equipment updates cannot match a question about the old approved model", async () => {
  const pending = {
    ...kuka, status: "pending" as const, approvedSnapshot: kuka,
    title: "Центр МИДиС с роботом FANUC", equipment: ["Робот FANUC"],
  };
  assert.deepEqual((await local("Где находится робот FANUC?", [pending])).citations, []);
  const approved = await local("Где находится робот KUKA?", [pending]);
  assert.match(approved.message, /Ворошилова, 12/u);
  assert.ok(approved.citations.every(citation => citation.title === kuka.title));
});

test("the location of delivered equipment cannot be substituted for its institution", async () => {
  const card = { ...kuka, placementDetails: "Робот KUKA хранится на складе поставщика. Адрес центра не подтверждён." };
  const answer = await local("Где расположен центр промышленного дизайна МИДиС с роботом KUKA?", [card]);
  assert.doesNotMatch(answer.message, /складе поставщика/u);
  assert.deepEqual(answer.citations, []);
});

test("equipment placement hints preserve a separately recorded planned status", async () => {
  const card = { ...kuka, placementStatus: "planned" as const, placementDetails: "Робот KUKA — УНК кампуса, 2-й этаж." };
  const listings = await local("Где размещены лаборатории?", [card]);
  assert.match(listings.message, /планируется/iu);
  assert.ok(listings.citations.some(citation => citation.field === "placementStatus"));
  const answer = await local("Где находится робот KUKA?", [card]);
  if (answer.citations.length) {
    assert.match(answer.message, /планируется/iu);
    assert.ok(answer.citations.some(citation => citation.field === "placementStatus"));
  }
});

test("partial approved snapshots, additional constraints and other models do not become answers", async () => {
  for (const question of [
    "Сколько свободных мест в первой очереди гостиниц кампуса?",
    "Сколько мест в первой очереди гостиниц кампуса в 2024 году?",
    "Сравни первую и вторую очереди гостиниц кампуса «Северный Урал»",
    "Где расположен центр промышленного дизайна ЧелГУ с роботом KUKA?",
    "Где расположен центр промышленного дизайна МИДиС с роботом FANUC?",
    "Где находится робот KUKA в УНК кампуса?",
    "Где находится робот KUKA в УНК кампуса? Дайте ссылку.",
    "Какие проекты по химии связаны с экологией?",
    "Какие вузы участвуют в совместных проектах в 2010 году?",
  ]) {
    assert.deepEqual((await local(question)).citations, [], question);
  }
  const noTitleMatch = { ...campus, title: "Паспорт кампуса", campusMetrics: [] };
  const draft = { ...noTitleMatch, status: "pending" as const, approvedSnapshot: undefined };
  assert.deepEqual((await local(examples[0].question, [draft])).citations, []);
});

test("examples use browser-local approved data with the same summaries", async () => {
  const storage = {
    getItem: () => null,
    setItem: () => assert.fail("Assistant wrote data"),
  };
  const ask = createBrowserDemoRequest(storage, readBrowserDemo(storage), [handleDemoTools]);
  for (const { question, content } of examples) {
    const response = await ask("/api/assistant", {
      method: "POST", body: JSON.stringify({ message: question }),
    });
    assert.equal(response.status, 200, question);
    const answer = parseAssistantAnswer(await response.json());
    assert.equal(answer?.presentation, "summary", question);
    for (const part of content) assert.match(answer.message, part, question);
    assert.ok(answer.citations.length, question);
  }
  const response = await ask("/api/assistant", {
    method: "POST", body: JSON.stringify({ message: "Как проверить текст по справочнику?" }),
  });
  assert.ok(parseAssistantAnswer(await response.json())?.actions.some(action => action.href === "/check"));
});
