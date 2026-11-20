import assert from "node:assert/strict";
import { test } from "node:test";
import {
  searchKnowledgeCards,
  getSearchFragment,
} from "../lib/knowledge-search";
import { replaceCheckedFragment } from "../lib/fact-check-edit";
import { knowledgeSeedCards } from "../lib/knowledge";
import { findCampusServices } from "../lib/campus-services";
import { findHomeCards } from "../lib/home-card-search";
const passport = knowledgeSeedCards.find((card) => card.type === "campus")!;
assert(passport.type === "campus");
const metric = passport.campusMetrics[0];
for (const phrase of ["редактор", " РЕДАКТОР ", "написать статью"]) {
  assert.equal(findCampusServices(phrase)[0]?.href, "/editor");
}
assert.equal(findCampusServices("проверить факты")[0]?.href, "/check");
assert.equal(findCampusServices("сравнить вузы")[0]?.href, "/analytics");
assert.deepEqual(findCampusServices("полигон", false), []);
assert.equal(findCampusServices("полигон", true)[0]?.href, "/comparison");
assert.deepEqual(findCampusServices(" "), []);
const pending = {
  ...passport,
  title: "Скрытый черновик",
  status: "pending" as const,
};
assert.deepEqual(findHomeCards([pending], pending.title, null), []);
const revision = { ...pending, approvedSnapshot: passport };
assert.deepEqual(findHomeCards([revision], pending.title, null), []);
assert.equal(
  findHomeCards([revision], metric.value, null)[0]?.href,
  `/knowledge?card=${passport.id}&version=approved`
);
assert.deepEqual(
  Object.keys(findHomeCards([passport], metric.value, null)[0]).sort(),
  ["detail", "href", "title"]
);
assert(
  searchKnowledgeCards(knowledgeSeedCards, metric.value).some(
    (card) => card.id === passport.id
  ),
  "Find metric values"
);
assert(
  getSearchFragment(passport, metric.value).includes(metric.value),
  "Show matching metric fragment"
);
assert.deepEqual(
  searchKnowledgeCards([], metric.value),
  [],
  "Search only supplied ACL-visible cards"
);
assert.equal(
  replaceCheckedFragment(
    "Первый факт. Другой факт.",
    "Первый факт.",
    "Исправленный факт."
  ),
  "Исправленный факт. Другой факт."
);
assert.equal(
  replaceCheckedFragment("Факт. Факт.", "Факт.", "Правка."),
  null,
  "Reject ambiguous quote without offsets"
);
assert.equal(
  replaceCheckedFragment("Факт. Факт.", "Факт.", "Правка.", 6, 11),
  "Факт. Правка.",
  "Replace only indexed repeated quote"
);
assert.equal(
  replaceCheckedFragment("Изменённый текст", "Старый текст", "Правка", 0, 12),
  null,
  "Reject stale span"
);
console.log(
  "UI regression: search metrics, matching fragments, ACL scope, exact single replacement passed"
);

test("Search excerpts show a match after repeated whitespace", () => {
  const card = {
    ...passport,
    referenceDescription: `${"Раздел          ".repeat(35)}Контур   12 000 утверждён.`,
  };
  const query = "контур 12000";
  assert.equal(searchKnowledgeCards([card], query)[0]?.id, card.id);
  assert.match(getSearchFragment(card, query), /Контур   12 000/);
});

test("Home search excerpts show a match when the first word is in another field", () => {
  const card = {
    ...passport,
    title: "Архив проекта",
    referenceDescription: `${"Историческая справка. ".repeat(16)}Модуль предназначен для роботов.`,
  };
  const [result] = findHomeCards([card], "архив модуль роботов", null);
  assert.equal(result?.title, card.title);
  assert.ok(result.detail);
  assert.match(result.detail, /Модуль предназначен для роботов/);
});
