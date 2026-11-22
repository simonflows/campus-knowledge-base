import assert from "node:assert/strict";
import { test } from "node:test";
import candidates from "../data/pilot-0.9.5-candidates.json";
import verification from "../data/pilot-0.9.5-verification.json";
import { checkFactText } from "../lib/fact-check";
import {
  knowledgeSeedCards,
  type KnowledgeCard,
  type LaboratoryCard,
  type ProjectCard,
  type UniversityCard,
} from "../lib/knowledge";

const baseLab = knowledgeSeedCards.find(
  (card): card is LaboratoryCard => card.type === "laboratory"
)!;
const active = {
  ...baseLab,
  id: "qa-active-plant",
  title: "Лаборатория орбитальных приводов",
  placementStatus: "active",
  placementDetails: "Действует на площадке вуза с 2022 года",
  referenceDescription:
    "Лаборатория орбитальных приводов уже работает на площадке вуза.",
} satisfies LaboratoryCard;
const planned = {
  ...baseLab,
  id: "qa-planned-plant",
  title: "Лаборатория аэрозольных фильтров",
  placementStatus: "planned",
  placementDetails: "Планируется к открытию в УНК кампуса в 2031 году",
  referenceDescription:
    "Лаборатория аэрозольных фильтров планируется к открытию в УНК кампуса в 2031 году.",
} satisfies LaboratoryCard;

const joint = knowledgeSeedCards.find(
  (card): card is ProjectCard => card.id === "joint-midis-susmu-trauma"
)!;
const twin = knowledgeSeedCards.find(
  (card): card is ProjectCard => card.id === "project-susu-digital-twin"
)!;

const photons: LaboratoryCard = {
  ...active,
  id: "qa-lab-photon-sensors",
  title: "Лаборатория фотонных сенсоров",
  head: "Анна Соколова, заведующая лабораторией",
  partner: "ООО «Азимут»",
};
const optics: LaboratoryCard = {
  ...planned,
  id: "qa-lab-adaptive-optics",
  title: "Лаборатория адаптивной оптики",
  head: "Елена Фёдорова, руководитель",
  partner: "ООО «Меридиан»",
};

test("named roles and partners use the exact approved object's fields", () => {
  const pending: LaboratoryCard = {
    ...photons,
    status: "pending",
    head: optics.head,
    partner: optics.partner,
    approvedSnapshot: photons,
  };
  const cards = [pending, optics, joint];
  for (const text of [
    "Лабораторией фотонных сенсоров руководит Анна Соколова.",
    "Анна Соколова — заведующая лабораторией фотонных сенсоров.",
    "Анна Соколова заведует лабораторией фотонных сенсоров.",
    "Партнёр лаборатории фотонных сенсоров — ООО «Азимут».",
    photons.title + ".\nРуководитель: Анна Соколова.\nПартнёр: ООО Азимут.",
  ]) {
    const result = checkFactText(text, cards);
    assert.equal(
      result.canPublish,
      true,
      text + " " + JSON.stringify(result.findings)
    );
    assert.ok(
      result.findings.some(
        ({ level, checkpoint, sourceCardId }) =>
          level === "green" &&
          checkpoint === "names" &&
          sourceCardId === photons.id
      ),
      text
    );
  }

  for (const text of [
    "Лабораторией фотонных сенсоров руководит Елена Фёдорова.",
    "Анна Соколова — заместитель заведующего лабораторией фотонных сенсоров.",
    "Партнёр лаборатории фотонных сенсоров — ООО «Меридиан».",
    "Партнёр лаборатории фотонных сенсоров — АО «Азимут».",
    "Лабораторией фотонных сенсоров не руководит Анна Соколова.",
    "ООО «Азимут» не является партнёром лаборатории фотонных сенсоров.",
    photons.title + ".\nПартнёр: ООО «Меридиан».",
    photons.title + ".\nПартнёр: не ООО «Азимут».",
  ]) {
    const result = checkFactText(text, cards);
    assert.equal(result.canPublish, false, text);
    assert.ok(
      result.findings.some(
        ({ level, checkpoint, sourceCardId }) =>
          level === "red" &&
          checkpoint === "names" &&
          sourceCardId === photons.id
      ),
      text + " " + JSON.stringify(result.findings)
    );
  }
});

test("a current partner field only verifies claims from the same period", () => {
  for (const text of [
    "Планируемый партнёр лаборатории фотонных сенсоров — ООО «Меридиан».",
    "Будущий партнёр лаборатории фотонных сенсоров — ООО «Азимут».",
    "Бывший партнёр лаборатории фотонных сенсоров — ООО «Меридиан».",
  ]) {
    const result = checkFactText(text, [photons, optics]);
    assert.equal(result.canPublish, false, text);
    assert.equal(result.summary.red, 0, JSON.stringify(result.findings));
    assert.ok(
      result.findings.some(
        ({ level, checkpoint, sourceCardId }) =>
          level === "yellow" &&
          checkpoint === "names" &&
          sourceCardId === photons.id
      ),
      text
    );
  }
  const future: LaboratoryCard = {
    ...photons,
    partner: "ООО «Азимут» названо будущим партнёром в анонсе",
  };
  for (const [text, level] of [
    ["Будущий партнёр лаборатории фотонных сенсоров — ООО «Азимут».", "green"],
    [
      "Планируемый партнёр лаборатории фотонных сенсоров — ООО «Меридиан».",
      "red",
    ],
    [
      "Действующий партнёр лаборатории фотонных сенсоров — ООО «Меридиан».",
      "yellow",
    ],
    [
      "Бывший партнёр лаборатории фотонных сенсоров — ООО «Меридиан».",
      "yellow",
    ],
  ] as const) {
    const result = checkFactText(text, [future, optics]);
    assert.equal(
      result.canPublish,
      level === "green",
      JSON.stringify(result.findings)
    );
    assert.equal(
      result.summary.red,
      level === "red" ? 1 : 0,
      JSON.stringify(result.findings)
    );
    assert.ok(
      result.findings.some(
        (finding) =>
          finding.level === level &&
          finding.checkpoint === "names" &&
          finding.sourceCardId === photons.id
      ),
      text
    );
  }
});

test("a role mentioned without a link or with missing data stays unconfirmed", () => {
  const unknown: LaboratoryCard = {
    ...optics,
    head: "Не установлено по проверенным источникам",
    partner: "Партнёр действующей площадки не установлен",
  };
  for (const text of [
    "Елена Фёдорова руководит лабораторией адаптивной оптики.",
    "Партнёр лаборатории адаптивной оптики — ООО «Меридиан».",
    photons.title + ". Елена Фёдорова руководит обсерваторией.",
    photons.title +
      " сотрудничает с обсерваторией, которой руководит Елена Фёдорова.",
    "Анна Соколова и Елена Фёдорова руководят лабораториями фотонных сенсоров и адаптивной оптики.",
    "Лаборатория фотонных сенсоров — не только образовательная площадка. Партнёр: ООО «Азимут».",
  ]) {
    const result = checkFactText(text, [photons, unknown]);
    assert.equal(result.canPublish, false, text);
    assert.equal(
      result.summary.red,
      0,
      text + " " + JSON.stringify(result.findings)
    );
    assert.ok(
      result.findings.some(
        ({ level, checkpoint }) => level === "yellow" && checkpoint === "names"
      ),
      text
    );
  }
  const mixed = checkFactText(
    "Лабораторией фотонных сенсоров руководит Анна Соколова, а партнёр лаборатории адаптивной оптики — ООО «Меридиан».",
    [photons, optics]
  );
  assert.equal(mixed.canPublish, true, JSON.stringify(mixed.findings));
  assert.deepEqual(
    mixed.findings
      .filter(
        ({ checkpoint, level }) => checkpoint === "names" && level === "green"
      )
      .map(({ sourceCardId }) => sourceCardId)
      .sort(),
    [photons.id, optics.id].sort()
  );
});

test("a project partner is independent from the partner of a participating university's laboratory", () => {
  const project: ProjectCard = { ...joint, industrialPartner: "ООО «Тензор»" };
  const unrelated: LaboratoryCard = { ...photons, partner: "ООО «Орбита»" };
  const correct = checkFactText(
    "Индустриальный партнёр проекта «" +
      project.title.split(" (")[0] +
      "» — ООО «Тензор».",
    [project, unrelated]
  );
  assert.equal(correct.canPublish, true, JSON.stringify(correct.findings));
  const wrong = checkFactText(
    project.title + ".\nИндустриальный партнёр: ООО «Орбита».",
    [project, unrelated]
  );
  assert.ok(
    wrong.findings.some(
      ({ sourceCardId, checkpoint, level }) =>
        sourceCardId === project.id && checkpoint === "names" && level === "red"
    ),
    JSON.stringify(wrong.findings)
  );
});

test("attributive numeric lines must be checked without a grammatical verb", () => {
  const text = [
    joint.title + ".",
    "Бюджет: 800 млн руб.",
    "Эффективность: 98%.",
    "Партнёр: ООО «Меридиан».",
    "Прототипов: 175.",
    "Показатель эффективности: 97 процентов.",
  ].join("\n");
  const report = checkFactText(text, [joint]);
  assert.equal(report.canPublish, false);
  for (const line of text.split("\n").slice(1)) {
    const finding = report.findings.find(
      ({ quote, level }) => quote === line && level !== "green"
    );
    assert.equal(
      finding?.checkpoint,
      line.startsWith("Партнёр") ? "names" : "figures",
      line + " " + JSON.stringify(report.findings)
    );
  }
  const identifierOnly = checkFactText(joint.title + ".", [joint]);
  assert.equal(
    identifierOnly.summary.yellow,
    0,
    JSON.stringify(identifierOnly.findings)
  );
  assert.ok(
    !identifierOnly.findings.some(({ checkpoint }) => checkpoint === "figures")
  );
});

test("a question heading cannot hide a numerical or qualitative presupposition", () => {
  for (const heading of [
    "Почему бюджет увеличился на 98%",
    "Почему бюджет увеличился на 98%?",
    "Как проект выиграл международный конкурс",
    "### Как проект выиграл международный конкурс?",
  ]) {
    const result = checkFactText(joint.title + "\n" + heading, [joint]);
    assert.equal(
      result.canPublish,
      false,
      heading + " " + JSON.stringify(result.findings)
    );
    assert.equal(result.summary.red, 0);
    assert.ok(
      result.findings.some(
        ({ level, quote, checkpoint }) =>
          level === "yellow" &&
          quote === heading &&
          checkpoint === (heading.includes("98%") ? "figures" : "names")
      ),
      heading
    );
  }
  const neutral = checkFactText(
    joint.title +
      "\n## Кто участвует?\n### Кто участвует в проекте\nСтруктура проекта\nЧто дальше?",
    [joint]
  );
  assert.equal(neutral.canPublish, true, JSON.stringify(neutral.findings));
});

test("a scoped university metric cannot cover a different clause of its sentence", () => {
  const passport = knowledgeSeedCards.find(
    (card): card is UniversityCard =>
      card.type === "university" && card.universityId === "midis"
  )!;
  const university: UniversityCard = {
    ...passport,
    structuredMetrics: [
      {
        id: "qa-scope-quota",
        label: "Квота мест",
        value: 120,
        unit: "мест",
        year: 2026,
        kind: "actual",
        evidenceUrl: "https://example.test/approved-metric",
        verifiedAt: "2026-11-21",
        owner: "Синтетический ответственный",
      },
    ],
  };
  const result = checkFactText(
    "МИДиС в 2026 году получил 120 мест, и академическая экспедиция выиграла международный конкурс.",
    [university]
  );
  assert.equal(result.canPublish, false);
  assert.ok(
    result.findings.some(
      ({ level, quote, sourceCardId }) =>
        level === "green" &&
        quote === "МИДиС в 2026 году получил 120 мест" &&
        sourceCardId === university.id
    )
  );
  assert.ok(
    result.findings.some(
      ({ level, quote }) =>
        level === "yellow" && quote.includes("международный конкурс")
    )
  );
});

test("activity at one laboratory does not change the planned status of the next laboratory", () => {
  const result = checkFactText(
    active.referenceDescription + " " + planned.referenceDescription,
    [active, planned]
  );
  assert.equal(result.summary.red, 0, JSON.stringify(result.findings));
});

test("negated opening is not read as an opening and an actual contradiction uses the current card", () => {
  const denial = checkFactText(
    planned.title + " ещё не открыта в УНК кампуса.",
    [active, planned]
  );
  assert.equal(denial.summary.red, 0, JSON.stringify(denial.findings));
  const contradiction = checkFactText(
    planned.title + " уже открыта в УНК кампуса.",
    [active, planned]
  );
  const finding = contradiction.findings.find(
    (item) => item.checkpoint === "placement" && item.level === "red"
  );
  assert.equal(finding?.sourceCardId, planned.id);
  assert.match(finding?.suggestion ?? "", /2031/);
  assert.doesNotMatch(finding?.suggestion ?? "", /2027/);
  const wrongYear = checkFactText(
    planned.title + " откроется в УНК кампуса в 2027 году.",
    [planned]
  );
  assert.ok(
    wrongYear.findings.some(
      (item) =>
        item.level === "red" &&
        item.checkpoint === "placement" &&
        /2031/.test(item.suggestion)
    )
  );
});

test("an explicit current denial or a plan-only status contradicts an active laboratory", () => {
  for (const text of [
    active.title + " сегодня не действует.",
    "Сейчас " + active.title + " не работает.",
    active.title + " пока только планируется к открытию.",
  ]) {
    const result = checkFactText(text, [active, planned]);
    const placement = result.findings.find(
      ({ level, checkpoint }) => level === "red" && checkpoint === "placement"
    );
    assert.equal(
      placement?.sourceCardId,
      active.id,
      text + " " + JSON.stringify(result.findings)
    );
    assert.match(
      placement?.suggestion ?? "",
      /Действует на площадке вуза с 2022 года/
    );
  }

  const approved = new Set(verification.approvedIds);
  const cards = candidates.cards
    .filter(({ card }) => approved.has(card.id))
    .map(({ card }) => ({ ...card, status: "approved" }) as KnowledgeCard);
  assert.equal(cards.length, 16);
  const liveText =
    "Центр промышленного дизайна МИДиС с роботом KUKA только планируется к открытию в УНК кампуса и сегодня не действует.";
  const result = checkFactText(liveText, cards);
  assert.ok(
    result.findings.some(
      ({ level, checkpoint, sourceCardId, quote }) =>
        level === "red" &&
        checkpoint === "placement" &&
        sourceCardId === "lab-midis-kuka" &&
        quote === liveText
    ),
    JSON.stringify(result.findings)
  );
});

test("a denial in another time, location, or entity cannot negate an active laboratory", () => {
  for (const text of [
    planned.title + " сейчас не действует.",
    active.title + " в 2021 году не работала.",
    "В 2033 году " + active.title + " не будет действовать.",
    active.title + " не действует в УНК кампуса.",
    active.title + " в новом УНК кампуса сегодня не действует.",
    active.title + " только планируется к открытию в новом УНК кампуса.",
    active.title +
      " не только планируется к открытию, но и работает на площадке вуза.",
    active.title +
      " планируется к открытию в УНК кампуса и соседний склад сегодня не действует.",
    active.title +
      " планируется к открытию в УНК кампуса и соседний склад строится и сегодня не действует.",
    active.title + " откроется в УНК кампуса в 2033 году и не действует.",
    active.title + " сотрудничает с обсерваторией, которая сейчас не работает.",
    active.title + " сегодня не действует?",
  ]) {
    const result = checkFactText(text, [active, planned]);
    assert.ok(
      !result.findings.some(
        ({ level, checkpoint }) => level === "red" && checkpoint === "placement"
      ),
      text + " " + JSON.stringify(result.findings)
    );
  }
});

test("an unrelated single author claim does not alter an explicitly joint project", () => {
  const claim = joint.title + " — совместный проект МИДиС и ЮУГМУ.";
  const result = checkFactText(
    claim + " Экспериментальная установка разработана одним вузом.",
    [joint]
  );
  assert.ok(
    !result.findings.some(
      (item) =>
        item.sourceCardId === joint.id &&
        item.checkpoint === "authorship" &&
        item.level === "red"
    ),
    JSON.stringify(result.findings)
  );
  const contradiction = checkFactText(joint.title + " создан только МИДиС.", [
    joint,
  ]);
  assert.ok(
    contradiction.findings.some(
      (item) =>
        item.level === "red" &&
        item.checkpoint === "authorship" &&
        item.sourceCardId === joint.id
    )
  );
});

test("an unrelated or negated contour is not assigned to the recognized project", () => {
  for (const text of [
    twin.title + " реализуется в контуре ПИШ. Доклад состоялся в рамках УМНОЦ.",
    twin.title + " не относится к контуру УМНОЦ.",
  ]) {
    const result = checkFactText(text, [twin]);
    assert.ok(
      !result.findings.some(
        (item) => item.checkpoint === "contour" && item.level === "red"
      ),
      text + " " + JSON.stringify(result.findings)
    );
  }
  const result = checkFactText(twin.title + " относится к контуру УМНОЦ.", [
    twin,
  ]);
  assert.ok(
    result.findings.some(
      (item) =>
        item.sourceCardId === twin.id &&
        item.level === "red" &&
        item.checkpoint === "contour"
    )
  );
  const negation = checkFactText(twin.title + " не относится к контуру ПИШ.", [
    twin,
  ]);
  assert.ok(
    negation.findings.some(
      (item) =>
        item.sourceCardId === twin.id &&
        item.level === "red" &&
        item.checkpoint === "contour"
    )
  );
});

test("official university and legal entity names use their identified record", () => {
  const campus = knowledgeSeedCards.find((card) => card.type === "campus")!;
  const midis = knowledgeSeedCards.find(
    (card) => card.id === "university-midis"
  )!;
  const susu = knowledgeSeedCards.find(
    (card) => card.id === "university-susu"
  )!;
  for (const [text, source, level] of [
    [
      "Официальное название МИДиС — Международный институт дизайна и сервиса.",
      midis,
      "green",
    ],
    [
      "Официальное название МИДиС — Южно-Уральский государственный университет.",
      midis,
      "red",
    ],
    [
      "Технический заказчик кампуса «Южный Урал» — Компания «ВТБ Девелопмент».",
      campus,
      "green",
    ],
    [
      "Технический заказчик кампуса «Южный Урал» — ООО «Отельные решения».",
      campus,
      "red",
    ],
  ] as const) {
    const result = checkFactText(text, [campus, midis, susu]);
    assert.equal(
      result.canPublish,
      level === "green",
      text + " " + JSON.stringify(result.findings)
    );
    assert.ok(
      result.findings.some(
        ({ checkpoint, level: found, sourceCardId }) =>
          checkpoint === "names" &&
          found === level &&
          sourceCardId === source.id
      ),
      JSON.stringify(result.findings)
    );
  }
});

test("a correct name cannot ground a new event or a bare relationship in another section", () => {
  const partner = { ...joint, industrialPartner: "ООО «Азимут»" };
  for (const text of [
    "Партнёр лаборатории фотонных сенсоров — ООО «Азимут» по сообщению главы совета, который подписал контракт.",
    "Лабораторией фотонных сенсоров руководит Анна Соколова, подписавшая контракт.",
    photons.title +
      ".\nРешения отделения\nИндустриальный партнёр: ООО «Азимут».",
    "Индустриальный партнёр: ООО «Азимут».\n" + photons.title + ".",
    "Лаборатория фотонных сенсоров. Партнёр: ООО «Азимут».",
  ]) {
    const result = checkFactText(text, [photons, partner]);
    assert.equal(
      result.canPublish,
      false,
      text + " " + JSON.stringify(result.findings)
    );
    assert.equal(
      result.summary.red,
      0,
      text + " " + JSON.stringify(result.findings)
    );
  }
});

test("recognizing a title does not confirm either a connected or a neighboring new claim", () => {
  for (const text of [
    twin.title + " получил международную награду.",
    twin.title + ". Экспедиция получила международную награду.",
  ]) {
    const result = checkFactText(text, [twin]);
    assert.equal(result.canPublish, false, text);
    assert.ok(
      result.findings.some(
        (item) =>
          item.level === "yellow" && /международную награду/.test(item.quote)
      ),
      JSON.stringify(result.findings)
    );
  }
});

test("a legacy quantity never confirms a different period, plan, negation or extra predicate", () => {
  const project = {
    ...twin,
    id: "qa-seismic-greenhouses",
    title: "Сейсмотеплицы",
    referenceDescription:
      "Проект «Сейсмотеплицы» выпустил 12 прототипов в 2023 году.",
    confirmedFigures: [
      "В 2023 году проект «Сейсмотеплицы» выпустил 12 прототипов.",
    ],
  };
  assert.equal(
    checkFactText(project.referenceDescription, [project]).canPublish,
    true
  );
  for (const text of [
    "Проект «Сейсмотеплицы» запланировал на 2027 год 12 прототипов.",
    "Проект «Сейсмотеплицы» не выпускал 12 прототипов в 2023 году.",
    "Проект «Сейсмотеплицы» выпустил 12 прототипов в 2024 году.",
    "Проект «Сейсмотеплицы» в 2027 году запланировал выпуск 12 прототипов и построил орбитальную больницу.",
    "Проект «Сейсмотеплицы» выпустил 12 прототипов в 2023 году и построил орбитальную больницу.",
  ]) {
    const report = checkFactText(text, [project]);
    assert.equal(report.canPublish, false, text);
    assert.ok(report.summary.red + report.summary.yellow > 0, text);
  }
});
