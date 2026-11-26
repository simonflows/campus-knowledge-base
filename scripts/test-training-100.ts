import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApprovedFactExample } from "../lib/fact-training-example";
import { checkFactText } from "../lib/fact-check";
import { getCardVersionId } from "../lib/knowledge-versions";
import { knowledgeSeedCards, type CampusCard } from "../lib/knowledge";

const original = knowledgeSeedCards.find((card): card is CampusCard => card.type === "campus")!;
const passport: CampusCard = {
  ...original,
  referenceDescription: "",
  stopFormula: "",
  stopList: [],
  campusMetrics: [
    { label: "Первая очередь гостиниц", value: "2 корпуса, 336 мест", note: "Вместимость." },
    { label: "Вторая очередь гостиниц", value: "6 корпусов, 3 064 места", note: "Вместимость." },
    { label: "Общая вместимость гостиниц", value: "3 400 мест, 8 гостиниц", note: "Вместимость после двух очередей." },
  ],
};

test("training example is derived from current approved fields and uses the ordinary checker", () => {
  for (const total of ["3 400", "4 200"]) {
    const current = { ...passport, campusMetrics: passport.campusMetrics.map((row, index) => index === 2 ? { ...row, value: `${total} мест, 8 гостиниц` } : row) };
    const example = buildApprovedFactExample([current], getCardVersionId);
    assert.ok(example);
    assert.ok(example.text.includes(total));
    const checked = checkFactText(example.text, [current]);
    assert.equal(checked.summary.red + checked.summary.yellow, 0);
    assert.ok(checked.summary.green >= 3);
    assert.ok(example.sourceVersions[current.id]);
    const corrupted = checkFactText(example.text.replace(total, "9 999"), [current]);
    assert.ok(corrupted.summary.red > 0);
  }
});

test("training never fabricates an approved example when current data cannot prove it", () => {
  assert.equal(buildApprovedFactExample([], getCardVersionId), null);
  assert.equal(buildApprovedFactExample([{ ...passport, status: "pending", approvedSnapshot: undefined }], getCardVersionId), null);
  assert.equal(buildApprovedFactExample([{ ...passport, campusMetrics: [], referenceDescription: "Площадь неизвестна." }], getCardVersionId), null);
  assert.equal(buildApprovedFactExample([{ ...passport, campusMetrics: passport.campusMetrics.map(row => ({ ...row, note: "План на 2030 год." })) }], getCardVersionId), null);
});
