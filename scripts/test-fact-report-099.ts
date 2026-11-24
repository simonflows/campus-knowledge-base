import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RewriteCheckSummary } from "../components/fact-check/rewrite-check-summary";
import { previewFindings, summarizeRewrite } from "../lib/fact-report";
import { checkFactText, type FactCheckFinding } from "../lib/fact-check";
import { factCheckResultSchema } from "../lib/validation/fact-check-result";
import { knowledgeSeedCards } from "../lib/knowledge";

const finding = (
  level: FactCheckFinding["level"],
  id: number
): FactCheckFinding => ({
  id: String(id),
  level,
  checkpoint: "figures",
  checkpointLabel: "Числа",
  title: "Проверка",
  quote: "Утверждение",
  explanation: "Сверено",
  suggestion: "Сохраните источник",
  sourceCardId: null,
  sourceCardTitle: null,
  sourceFolder: null,
});

test("a confirmed finding stays visible below many unresolved findings", () => {
  const input = [
    ...Array.from({ length: 8 }, (_, id) => finding("yellow", id)),
    finding("green", 9),
  ];
  const shown = previewFindings(input);
  assert.equal(shown.length, 6);
  assert.ok(shown.some((item) => item.level === "green"));
  assert.equal(new Set(shown.map((item) => item.id)).size, 6);
  assert.equal(input.length, 9);
  assert.deepEqual(previewFindings(input, 0), []);
});

test("preview preserves severity order and an example of each available verdict", () => {
  const input = [
    ...Array.from({ length: 8 }, (_, id) => finding("red", id)),
    finding("yellow", 8),
    finding("green", 9),
  ];
  assert.deepEqual(
    previewFindings(input).map((item) => item.level),
    ["red", "red", "red", "red", "yellow", "green"]
  );
  assert.deepEqual(previewFindings(input, 1), [input[0]]);
});

test("mixed rewrite summary includes green even when yellow remains", () => {
  const html = renderToStaticMarkup(
    createElement(RewriteCheckSummary, {
      check: {
        summary: { red: 0, yellow: 2, green: 3, total: 5 },
        canPublish: false,
        isClean: false,
      },
    })
  );
  assert.match(html, /Новая редакция требует сверки/);
  assert.match(html, /Красных: 0/);
  assert.match(html, /Жёлтых: 2/);
  assert.match(html, /Зелёных: 3/);
});

test("rewrite report validates its own findings while legacy summaries remain compatible", () => {
  const result = checkFactText(
    "Площадь кампуса составляет 114 тыс. кв. метров.",
    knowledgeSeedCards
  );
  result.findings[0].sourceField = "campusMetrics.3";
  const check = summarizeRewrite(result);
  assert.deepEqual(
    factCheckResultSchema.parse({ ...result, rewriteCheck: check }).rewriteCheck
      ?.findings,
    check.findings
  );
  const legacy = { summary: check.summary, canPublish: check.canPublish, isClean: check.isClean };
  assert.ok(
    factCheckResultSchema.safeParse({ ...result, rewriteCheck: legacy }).success
  );
  assert.ok(
    !factCheckResultSchema.safeParse({
      ...result,
      rewriteCheck: { ...check, findings: [{ level: "purple" }] },
    }).success
  );
});
