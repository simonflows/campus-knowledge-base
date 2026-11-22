import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAnalyticsReport } from "../lib/analytics";
import { assistAnalytics, assistFactCheck } from "../lib/flash-assist";
import { knowledgeSeedCards } from "../lib/knowledge";
import { analyticsQuerySchema } from "../lib/validation/analytics";
import { factCheckInputSchema } from "../lib/validation/fact-check";

test("analytics accepts an explicit boolean Flash opt-in", () => {
  const query = "Покажи проекты МИДиС";
  assert.equal(
    Reflect.get(analyticsQuerySchema.parse({ query, flashAssist: true }), "flashAssist"),
    true,
  );
  assert.equal(analyticsQuerySchema.safeParse({ query, flashAssist: "true" }).success, false);
  assert.equal(Reflect.get(analyticsQuerySchema.parse({ query }), "flashAssist"), undefined);
});

test("fact-check accepts an explicit boolean Flash opt-in", () => {
  const text = "Достаточно длинный текст для проверки фактов.";
  assert.equal(
    Reflect.get(factCheckInputSchema.parse({ text, flashAssist: true }), "flashAssist"),
    true,
  );
  assert.equal(factCheckInputSchema.safeParse({ text, flashAssist: "true" }).success, false);
  assert.equal(Reflect.get(factCheckInputSchema.parse({ text, mode: "rewrite" }), "flashAssist"), undefined);
});

test("Flash suggestions preserve local criteria and surface source text only", async (t) => {
  const settings = {
    YANDEX_AI_STUDIO_API_KEY: "synthetic-key",
    YANDEX_AI_STUDIO_FOLDER_ID: "synthetic-folder",
    YANDEX_AI_STUDIO_MODEL_URI: "gpt://synthetic-folder/aliceai-llm-flash",
  };
  Object.assign(process.env, settings);
  t.after(() => {
    for (const key of Object.keys(settings)) delete process.env[key];
  });

  const request = new Request("http://localhost:8080");
  const text = "Лаборатория открывается осенью. В испытаниях участвовали специалисты вуза.";
  const query = "Покажи проекты МИДиС по лечению и восстановлению";
  const responses = [
    { ids: [2, 99, 2] },
    { query: "Покажи проекты МИДиС в сфере медицины" },
    { query: "Покажи проекты ЮУрГУ в сфере медицины" },
    { query: "Покажи лаборатории МИДиС в сфере медицины" },
    { query: "Покажи проекты МИДиС и ЮУрГУ" },
    { query: "Покажи проекты МИДиС в сфере медицины" },
    { query: "Покажи 99 проектов МИДиС" },
    { ids: [1], verdict: "верно" },
  ];
  const fetch = t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://ai.api.cloud.yandex.net/v1/chat/completions");
    assert.equal(new Headers(options.headers).get("x-data-logging-enabled"), "false");
    const payload = JSON.parse(String(options.body));
    assert.equal(payload.max_completion_tokens, 256);
    assert.ok(options.signal);
    const output = responses.shift();
    return Response.json({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }],
    });
  });

  assert.deepEqual(await assistFactCheck(request, "facts", text), {
    status: "ready", fragments: ["В испытаниях участвовали специалисты вуза."],
  });
  assert.deepEqual(await assistFactCheck(request, "facts", text), { status: "busy" });
  assert.deepEqual(await assistFactCheck(request, "long", "а".repeat(6001)), { status: "too-long" });
  const proposal = "Покажи проекты МИДиС в сфере медицины";
  assert.deepEqual(
    await assistAnalytics(request, "analytics", query, []),
    { status: "ready", suggestion: { query: proposal, filters: buildAnalyticsReport(proposal, knowledgeSeedCards, []).filters } },
  );
  assert.deepEqual(
    await assistAnalytics(request, "wrong-university", query, []),
    { status: "ready", suggestion: null },
  );
  assert.deepEqual(
    await assistAnalytics(request, "wrong-type", query, []),
    { status: "ready", suggestion: null },
  );
  assert.deepEqual(
    await assistAnalytics(request, "extra-university", query, []),
    { status: "ready", suggestion: null },
  );
  const implicitQuery = "Покажи, что придумали в МИДиС для лечения";
  assert.deepEqual(
    await assistAnalytics(request, "implicit-type", implicitQuery, []),
    { status: "ready", suggestion: { query: proposal, filters: buildAnalyticsReport(proposal, knowledgeSeedCards, []).filters } },
  );
  assert.deepEqual(
    await assistAnalytics(request, "fake-total", query, []),
    { status: "failed" },
  );
  assert.deepEqual(await assistFactCheck(request, "no-verdict", text), { status: "failed" });
  assert.equal(fetch.mock.callCount(), 8);
});
