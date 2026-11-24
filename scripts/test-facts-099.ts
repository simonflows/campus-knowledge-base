import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCanonicalRewrite, checkFactText } from "../lib/fact-check";
import { buildCanonSources } from "../lib/canon-context";
import { knowledgeSeedCards, type CampusCard } from "../lib/knowledge";
import { getCardVersionId } from "../lib/knowledge-versions";

const seed = knowledgeSeedCards.find((card): card is CampusCard => card.type === "campus")!;
const construction = "Межуниверситетский кампус «Южный Урал» строится в Челябинске.";
const residents = "К проекту относятся семь вузов региона.";
// Public approved passport, reduced to the fields used in these checks.
const passport: CampusCard = {
  ...seed,
  title: "Паспорт межуниверситетского кампуса «Южный Урал»",
  referenceDescription: construction + " " + residents +
    " В первую очередь вошли два гостиничных корпуса, во вторую — шесть.",
  stopFormula: "",
  stopList: [],
  campusMetrics: [
    { label: "Вузы-резиденты", value: "7 вузов", note: "Состав участников по сообщению ЮУрГУ от 13.02.2026." },
    { label: "Первая очередь гостиниц", value: "2 корпуса, 336 мест", note: "Вместимость. Разрешение на ввод датировано 22.03.2024." },
    { label: "Вторая очередь гостиниц", value: "6 корпусов, 3 064 места", note: "Вместимость. Разрешение на ввод датировано 16.06.2026." },
    { label: "Общая вместимость гостиниц", value: "3 400 мест, 8 гостиниц", note: "Вместимость после двух гостиничных очередей." },
    { label: "Апартаменты А5", value: "90 апартаментов", note: "Единица — апартаменты." },
  ],
};

const total = "Общая вместимость гостиниц кампуса составляет 3 400 мест.";
const first = "Первая очередь гостиниц кампуса рассчитана на 336 мест.";
const second = "Вторая очередь гостиниц кампуса рассчитана на 3 064 места.";
const wrong = total.replace("3 400", "9 999");
const area = "Общая площадь кампуса составляет 114 тыс. кв. метров.";

test("the local checker attributes each correctly scoped capacity to its own approved metric", () => {
  const versionId = getCardVersionId(passport);
  const [source] = buildCanonSources([passport], { [passport.id]: versionId });
  for (const [quote, index] of [[total, 3], [first, 1], [second, 2]] as const) {
    const checked = checkFactText("\n" + quote, [passport]);
    const finding = checked.findings.find(item => item.quote === quote && item.level === "green");
    assert.ok(finding, quote);
    assert.equal(finding.sourceCardId, passport.id);
    assert.equal(finding.sourceField, "campusMetrics." + index);
    assert.equal(finding.quoteStart, 1);
    assert.equal(checked.summary.red + checked.summary.yellow, 0);
    assert.equal(source.cardId, finding.sourceCardId);
    assert.equal(source.versionId, versionId);
    assert.ok(source.facts.some(fact => fact.field === finding.sourceField &&
      fact.label === passport.campusMetrics[index].label && fact.text.includes(passport.campusMetrics[index].value)));
  }
});

test("the exact construction assertion is attributed in full, including its predicate and place", () => {
  const checked = checkFactText(construction, [passport]);
  assert.ok(checked.findings.some(finding => finding.level === "green" &&
    finding.quote === construction && finding.sourceCardId === passport.id &&
    finding.sourceField === "referenceDescription"));
});

test("rewrite repairs only the incorrect capacity outside direct speech and rechecks the whole text", () => {
  const speech = "— " + wrong;
  const original = ["О гостиницах кампуса", speech, wrong, area].join("\n\n");
  const rewrite = buildCanonicalRewrite(original, [passport]);
  assert.ok(rewrite);
  assert.equal(rewrite.plainText, ["О гостиницах кампуса", speech, total, area].join("\n\n"));
  assert.deepEqual(rewrite.changes, [{ before: wrong, after: total, sourceCardId: passport.id }]);
  const checked = checkFactText(rewrite.plainText, [passport]);
  assert.ok(checked.findings.some(item => item.level === "green" &&
    item.quote === total && item.sourceField === "campusMetrics.3"));
  assert.ok(checked.findings.some(item => item.level === "yellow" && item.quote === area));
});

test("capacity evidence cannot be borrowed from a different queue, place, period, unit, plan or hypothesis", () => {
  for (const quote of [
    second.replace("3 064", "3 400"),
    "Первая очередь гостиниц кампуса рассчитана на 3 064 места.",
  ]) {
    const checked = checkFactText(quote, [passport]);
    assert.ok(checked.findings.some(item => item.level === "red" && item.quote === quote), quote);
    assert.equal(checked.summary.green, 0);
  }
  for (const quote of [
    "Вторая очередь гостиниц кампуса рассчитана на 3 064 номера.",
    "Вторая очередь гостиниц кампуса не рассчитана на 3 064 места.",
    "Вторая очередь гостиниц кампуса будет рассчитана на 3 064 места.",
    "Вторая очередь гостиниц кампуса рассчитана на 3 064 места только после обязательного ввода.",
    second.replace(/\.$/u, "?"),
    "В 2020 году " + second,
    "Вместимость агентства размещения составляет 3 064 места.",
    "Вторая очередь гостиниц кампуса «Северный Урал» рассчитана на 3 064 места.",
    "## Кампус «Северный Урал»\n\n" + second,
    "## ЮУрГУ\n\n" + second,
    "## Первая очередь гостиниц кампуса\n\n" + second,
    "## 1-я очередь гостиниц кампуса\n\n" + second,
    "## I очередь гостиниц кампуса\n\n" + second,
    first.slice(0, -1) + ", но это только гипотеза.",
    first.slice(0, -1) + ", если проект будет реализован.",
    "Вторая очередь гостиниц кампуса пока планирует принять 3 064 студентов.",
    "В шести новых корпусах второй очереди могут проживать 3,4 тыс. студентов.",
  ]) {
    const checked = checkFactText(quote, [passport]);
    assert.equal(checked.summary.green + checked.summary.red, 0, quote);
  }
});

test("only a unique approved row can prove the capacity for its matching scope and unit", () => {
  const [residents, firstRow, secondRow, totalRow] = passport.campusMetrics;
  for (const campusMetrics of [
    [residents, firstRow, { ...totalRow, value: "3 064 места, 8 гостиниц" }],
    [firstRow, secondRow, secondRow, totalRow],
    [firstRow, secondRow, { ...secondRow, value: "6 корпусов, 2 999 мест" }, totalRow],
    [firstRow, { ...secondRow, value: "6 корпусов, 3 064 номера" }, totalRow],
  ]) {
    const checked = checkFactText(second, [{ ...passport, campusMetrics }]);
    assert.equal(checked.summary.green + checked.summary.red, 0);
    assert.ok(checked.findings.some(item => item.quote === second && item.level === "yellow"));
  }
});

test("foreign campus, historical, dated and hypothetical context cannot verify a capacity", () => {
  const contexts = [
    "## Новый кампус МГУ\n\n",
    "## новый кампус мгу\n\n",
    "## Исторические данные\n\n",
    "## 2030 год\n\n",
    "## До открытия гостиниц\n\n",
    "## Прогноз\n\n",
    "## Гостиницы МГУ\n\n",
    "## Гостиницы мгу\n\n",
    "В 2020 году. ",
    "Например, рассмотрим гипотезу. ",
    "МИДиС в 2026 году получил 120 мест. Рассмотрим гипотезу. ",
    "В новом кампусе мгу. ",
  ];
  for (const context of contexts) {
    for (const quote of [total, wrong]) {
      const checked = checkFactText(context + quote, [passport]);
      assert.ok(checked.findings.some(item => item.quote === quote && item.level === "yellow"), context + quote);
      assert.ok(!checked.findings.some(item => item.quote === quote && item.level !== "yellow"), context + quote);
    }
  }
});

test("an unreadable or provisional duplicate still makes its passport metric ambiguous", () => {
  const row = passport.campusMetrics[3];
  for (const value of ["ориентировочно 9 999 мест", "данные уточняются"]) {
    const card = { ...passport, campusMetrics: [...passport.campusMetrics, { ...row, value }] };
    for (const quote of [total, wrong]) {
      const checked = checkFactText(quote, [card]);
      assert.ok(checked.findings.some(item => item.quote === quote && item.level === "yellow"), value);
      assert.equal(checked.summary.red + checked.summary.green, 0, value);
    }
  }
});

test("a row note marking a plan, estimate or example cannot prove a present capacity", () => {
  for (const note of [
    "План на 2030 год.",
    "Старая оценка на 2020 год, сейчас не подтверждена.",
    "Учебный пример, не подтверждено утверждённым паспортом.",
    "Расчёт действителен при условии ввода третьего этапа.",
    "По состоянию на 2020 год.",
    "После ввода третьей очереди.",
  ]) {
    const campusMetrics = passport.campusMetrics.map((metric, index) => index === 3 ? { ...metric, note } : metric);
    for (const quote of [total, wrong]) {
      const checked = checkFactText(quote, [{ ...passport, campusMetrics }]);
      assert.ok(checked.findings.some(item => item.quote === quote && item.level === "yellow"), note);
      assert.equal(checked.summary.red + checked.summary.green, 0, note);
    }
  }
});

test("under the campus heading a capacity does not need to repeat the campus name", () => {
  const heading = "## Кампус «Южный Урал»\n\n";
  const withoutCampus = (text: string) => text.replace("гостиниц кампуса", "гостиниц");
  for (const [text, index] of [[total, 3], [first, 1], [second, 2]] as const) {
    const quote = withoutCampus(text);
    const checked = checkFactText(heading + quote, [passport]);
    assert.ok(checked.findings.some(item => item.quote === quote && item.level === "green" &&
      item.sourceField === "campusMetrics." + index), quote);
    const unbound = checkFactText(quote, [passport]);
    assert.equal(unbound.summary.red + unbound.summary.green, 0, quote);
  }

  const quote = withoutCampus(wrong);
  const checked = checkFactText(heading + quote, [passport]);
  assert.ok(checked.findings.some(item => item.quote === quote && item.level === "red"));
  const rewrite = buildCanonicalRewrite(heading + quote, [passport]);
  assert.equal(rewrite?.plainText, heading + withoutCampus(total));
});

test("an interview's ambiguous accommodation quantity is available for manual checking", () => {
  const sentence = "В этом году вдобавок к двум гостиницам, которые были построены раньше, возвели еще шесть корпусов, в которых могут проживать 3,4 тыс. студентов.";
  const checked = checkFactText("О кампусе\n\n" + sentence, [passport]);
  assert.ok(checked.findings.some(item => item.quote === sentence && item.level === "yellow"));
  assert.equal(checked.summary.red + checked.summary.green, 0);
});

test("a recognisable exact claim still needs its subject and scope in the source and article", () => {
  assert.equal(checkFactText(residents, [passport]).summary.green, 0);
  for (const text of [
    "## Кампус «Северный Урал»\n\n" + construction,
    construction.slice(0, -1) + ", но это только гипотеза.",
  ]) assert.ok(!checkFactText(text, [passport]).findings.some(item =>
    item.level === "green" && item.quote === construction), text);
  const hypothetical = { ...passport, referenceDescription: "Гипотетический сценарий: " + construction };
  assert.ok(!checkFactText(construction, [hypothetical]).findings.some(item =>
    item.level === "green" && item.quote === construction));
});

test("an exact opening assertion inside a hypothesis needs manual confirmation", () => {
  const text = "## Гипотетический сценарий\n\n" + construction;
  const checked = checkFactText(text, [passport]);
  assert.equal(checked.canPublish, false);
  assert.ok(checked.findings.some(item => item.quote === construction && item.level === "yellow"));
  assert.ok(!checked.findings.some(item => item.quote === construction && item.level === "green"));
});
