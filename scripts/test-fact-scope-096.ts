import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFactText } from "../lib/fact-check";
import {
  knowledgeSeedCards,
  type LaboratoryCard,
  type ProjectCard,
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
