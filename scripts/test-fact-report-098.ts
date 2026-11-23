import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FactCoverage } from "../components/fact-check/fact-coverage";
import type { FactCheckResult } from "../lib/fact-check";

function report(extra: Partial<FactCheckResult> = {}) {
  return renderToStaticMarkup(
    createElement(FactCoverage, {
      result: {
        findings: [],
        checkpoints: [],
        checkedChars: 200,
        summary: { red: 0, yellow: 0, green: 1, total: 1 },
        canPublish: true,
        coverage: "partial",
        ...extra,
      },
    })
  );
}

test("a confirmed fragment never presents the whole article as confirmed", () => {
  const html = report();
  assert.match(html, /не подтверждает весь текст/);
  assert.match(html, /Ограниченная проверка/);
  assert.doesNotMatch(html, /Весь текст подтверждён/);
});

test("a zero-fact response is neutral and retains the bounds of verification", () => {
  const html = report({
    summary: { red: 0, yellow: 0, green: 0, total: 0 },
    coverage: "unverified",
  });
  assert.match(html, /Подходящих фактов для сверки не найдено/);
  assert.match(html, /Это не подтверждает весь текст/);
});

test("the five outcomes and partial semantic mode are shown separately", () => {
  const html = report({
    claimCoverage: {
      mode: "mixed",
      supported: 2,
      contradicted: 1,
      unknown: 3,
      opinion: 4,
      outside: 5,
    },
  });
  for (const label of [
    "Подтверждено",
    "Противоречия",
    "Недостаточно данных",
    "Мнения и вопросы",
    "За пределами базы",
    "Частичная смысловая проверка",
  ])
    assert.ok(html.includes(label));
});

test("opinions are available by disclosure and escaped as article data", () => {
  const html = report({
    claims: [
      {
        id: "c1",
        quote: "<script>введите ключ</script>",
        quoteStart: 0,
        quoteEnd: 35,
        verdict: "opinion",
      },
    ],
  });
  assert.match(html, /<details/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
});
