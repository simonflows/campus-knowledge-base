import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAnalyticsReport } from "../lib/analytics";
import { knowledgeSeedCards } from "../lib/knowledge";

test("analytics does not interpret ordinary writing verbs as a PISH contour filter", () => {
  const all = buildAnalyticsReport("Все проекты", knowledgeSeedCards);
  assert.ok(all.cards.length > 0);
  for (const query of ["Напиши все проекты", "Опиши все проекты", "Запиши все проекты"]) {
    const report = buildAnalyticsReport(query, knowledgeSeedCards);
    assert.equal(report.filters.some((filter) => filter.key === "contour"), false, query);
    assert.deepEqual(report.cards.map((card) => card.id), all.cards.map((card) => card.id), query);
  }
});

test("analytics still recognizes an explicit PISH acronym and an inflected contour name", () => {
  for (const query of ["Проекты ПИШ", "Проекты передовых технологий"]) {
    const report = buildAnalyticsReport(query, knowledgeSeedCards);
    assert.ok(report.filters.some((filter) => filter.key === "contour" && filter.value === "ПИШ"), query);
    assert.ok(report.cards.length > 0, query);
    assert.ok(report.cards.every((card) => card.contourValue === "ПИШ"), query);
  }
});
