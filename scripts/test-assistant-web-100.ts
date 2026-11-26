import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebChat } from "../lib/assistant-web";
import { createMetadataIamToken } from "../lib/yandex-metadata-iam";

const searchEndpoint = "https://searchapi.api.cloud.yandex.net/v2/gen/search";
const metadataEndpoint = "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token";
const env = {
  CAMPUS_WEB_SEARCH_ENABLED: "true",
  CAMPUS_WEB_SEARCH_API_KEY: "fixture-only",
  CAMPUS_WEB_SEARCH_FOLDER_ID: "fixture-folder",
};
const data = {
  message: { content: "**Короткий ответ** [1] <i>внешнего поиска</i>.", role: "ROLE_ASSISTANT" },
  sources: [
    { url: "https://www.example.org/article", title: "<b>Статья</b>", used: true },
    { url: "http://localhost/private", title: "Внутренний ресурс", used: true },
    { url: "https://www.example.org/article", title: "Повтор", used: true },
    { url: "https://www.example.net/unused", title: "Другой материал", used: false },
  ],
  hints: ["Подсказка провайдера"],
};

function input(accountId = "synthetic-account", question = "Текущий вопрос", signal?: AbortSignal) {
  return { request: new Request("https://application.invalid/api/assistant", { signal }), accountId, question };
}

function createFixture(settings: Partial<Parameters<typeof createWebChat>[0]> = {}) {
  const calls: Array<{ endpoint: string; settings?: RequestInit }> = [];
  const attempts: string[] = [];
  const answer = createWebChat({
    env,
    fetcher: async (url, settings) => {
      calls.push({ endpoint: String(url), settings });
      return Response.json([data]);
    },
    budget: async accountId => { attempts.push(accountId); return { allowed: true }; },
    getMetadataToken: async () => assert.fail("The fixture must not contact VM metadata"),
    ...settings,
  });
  return { answer, calls, attempts };
}

test("REST search sends only the current question and labels external sources separately", async () => {
  const fx = createFixture();
  const result = await fx.answer(input());
  assert.equal(result.status, "ready");
  assert.equal(result.mode, "web");
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.actions, []);
  assert.equal(result.message, "Короткий ответ внешнего поиска.");
  assert.deepEqual(result.externalSources.map(({ title, url }) => ({ title, url })), [{ title: "Статья", url: "https://www.example.org/article" }]);
  assert.equal(fx.calls[0].endpoint, searchEndpoint);
  assert.equal(fx.calls[0].settings?.method, "POST");
  assert.equal(fx.calls[0].settings?.redirect, "error");
  assert.equal(new Headers(fx.calls[0].settings?.headers).get("Authorization"), "Api-Key fixture-only");
  assert.deepEqual(JSON.parse(String(fx.calls[0].settings?.body)), {
    folderId: "fixture-folder", messages: [{ role: "ROLE_USER", content: "Текущий вопрос" }],
    fixMisspell: true, getPartialResults: false,
  });
  assert.equal(fx.attempts.length, 1);
});

test("the object response is accepted and metadata authentication is opt-in", async () => {
  let metadata = 0;
  const { answer } = createFixture({
    env: { CAMPUS_WEB_SEARCH_ENABLED: "true", CAMPUS_WEB_SEARCH_USE_METADATA: "true", YANDEX_AI_STUDIO_FOLDER_ID: "fallback-folder" },
    getMetadataToken: async () => { metadata++; return "fixture-token"; },
    fetcher: async (url, settings) => {
      assert.equal(String(url), searchEndpoint);
      assert.equal(new Headers(settings?.headers).get("Authorization"), "Bearer fixture-token");
      assert.equal(JSON.parse(String(settings?.body)).folderId, "fallback-folder");
      return Response.json(data);
    },
  });
  assert.equal((await answer(input())).status, "ready");
  assert.equal(metadata, 1);

  const unconfigured = createFixture({ env: { CAMPUS_WEB_SEARCH_ENABLED: "true", CAMPUS_WEB_SEARCH_FOLDER_ID: "fixture-folder", YANDEX_AI_STUDIO_API_KEY: "not-a-search-key" } });
  assert.equal((await unconfigured.answer(input())).status, "unavailable");
  assert.deepEqual(unconfigured.calls, []);
  assert.deepEqual(unconfigured.attempts, []);
});

test("feature, input, quota and cancellation gates run before calling the search endpoint", async () => {
  const disabled = createFixture({ env: {} });
  assert.equal((await disabled.answer(input())).status, "unavailable");
  assert.deepEqual(disabled.attempts, []);

  const fx = createFixture();
  assert.equal((await fx.answer(input("fixture", "q".repeat(2001)))).status, "failed");
  assert.equal((await fx.answer(input("fixture", "q", AbortSignal.abort()))).status, "failed");
  assert.deepEqual(fx.attempts, []);
  assert.deepEqual(fx.calls, []);

  for (const reason of ["quota", "unavailable"] as const) {
    const denied = createFixture({ budget: async () => ({ allowed: false, reason }) });
    assert.equal((await denied.answer(input())).status, reason === "quota" ? "busy" : "unavailable");
    assert.deepEqual(denied.calls, []);
  }

  const abort = new AbortController();
  const canceled = createFixture({ budget: async () => { abort.abort(); return { allowed: true }; } });
  assert.equal((await canceled.answer(input("fixture", "q", abort.signal))).status, "failed");
  assert.deepEqual(canceled.calls, []);
});

test("only safe used sources count and empty or invalid provider data fails without exposing it", async () => {
  for (const invalid of [
    {},
    [data, data],
    { ...data, isAnswerRejected: true },
    { ...data, problematicAnswer: true },
    { ...data, message: { content: "<br> [3]", role: "ROLE_ASSISTANT" } },
    { ...data, sources: ["https://example.org/", ...["file:///document", "https://user@example.org/", "http://127.0.0.1/", "http://[::1]/", "http://host.local/"].map(url => ({ url, used: true, title: "Тестовый источник" }))] },
  ]) {
    const fx = createFixture({ fetcher: async () => Response.json(invalid) });
    const result = await fx.answer(input());
    assert.equal(result.status, "failed");
    assert.deepEqual(result.externalSources, []);
  }
  const cut = createFixture({ fetcher: async () => Response.json({
    ...data, message: { content: "x".repeat(5000), role: "ROLE_ASSISTANT" },
    sources: Array.from({ length: 14 }, (_, i) => ({ title: "t".repeat(250), url: `https://example.org/${i}`, used: true })),
  }) });
  const result = await cut.answer(input());
  assert.equal(result.status, "ready");
  assert.ok(result.message.length < 5000);
  assert.ok(result.externalSources.length <= 8);
  assert.ok(result.externalSources.every(source => source.title.length <= 200));
});

test("slow, oversized and failing provider requests have bounded handling and zero retries", async () => {
  for (const [httpStatus, expected] of [[429, "busy"], [403, "unavailable"], [500, "failed"]] as const) {
    let calls = 0;
    const fx = createFixture({ fetcher: async () => { calls++; return new Response("private upstream error", { status: httpStatus }); } });
    const result = await fx.answer(input());
    assert.equal(result.status, expected);
    assert.ok(!result.message.includes("private upstream error"));
    assert.equal(calls, 1);
  }
  let canceled = false;
  const oversized = createFixture({ fetcher: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel() { canceled = true; },
  })) });
  assert.equal((await oversized.answer(input())).status, "failed");
  assert.equal(canceled, true);
  const announced = createFixture({ fetcher: async () => new Response("{}", { headers: { "content-length": "1048577" } }) });
  assert.equal((await announced.answer(input())).status, "failed");

  let started: () => void = () => {};
  const active = new Promise<void>(resolve => { started = resolve; });
  const timeout = new AbortController();
  const slow = createFixture({ timeoutSignal: () => timeout.signal, fetcher: async (_url, settings) => {
    assert.ok(settings?.signal);
    const signal = settings.signal;
    started();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  const pending = slow.answer(input());
  await active;
  timeout.abort();
  assert.equal((await pending).status, "failed");
});

test("canceling an already started request stops a pending provider body", async () => {
  let stop: () => void = () => {};
  const reading = new Promise<void>(resolve => { stop = resolve; });
  let canceled = false;
  const client = new AbortController();
  const fx = createFixture({ fetcher: async () => new Response(new ReadableStream<Uint8Array>({
    pull() { stop(); },
    cancel() { canceled = true; },
  })) });
  const pending = fx.answer(input("fixture", "Текущий вопрос", client.signal));
  await reading;
  client.abort();
  const response = await pending;
  assert.equal(response.status, "failed");
  assert.equal(canceled, true);
  assert.ok(response.message.includes("отменён"));
});

test("at most two searches run concurrently and each account has a ten second cooldown", async () => {
  let now = 20_000;
  const pending: Array<() => void> = [];
  const fx = createFixture({ now: () => now, fetcher: async () => new Promise<Response>(resolve => {
    pending.push(() => resolve(Response.json(data)));
  }) });
  const first = fx.answer(input("one"));
  const second = fx.answer(input("two"));
  assert.equal((await fx.answer(input("three"))).status, "busy");
  assert.equal((await fx.answer(input("one"))).status, "busy");
  for (const finish of pending) finish();
  assert.equal((await first).status, "ready");
  assert.equal((await second).status, "ready");
  now += 9999;
  assert.equal((await fx.answer(input("one"))).status, "busy");
  now++;
  const resumed = fx.answer(input("one"));
  await new Promise(resolve => setImmediate(resolve));
  pending.at(-1)?.();
  assert.equal((await resumed).status, "ready");
});

test("IAM tokens use a fixed metadata endpoint, concurrent refresh and expiry-aware cache", async () => {
  let now = 1_000_000;
  let requests = 0;
  const token = createMetadataIamToken(async (url, settings) => {
    requests++;
    assert.equal(String(url), metadataEndpoint);
    assert.equal(new Headers(settings?.headers).get("Metadata-Flavor"), "Google");
    assert.equal(settings?.redirect, "error");
    assert.equal(settings?.cache, "no-store");
    return Response.json({ access_token: `fixture-${requests}`, expires_in: 120, token_type: "Bearer" });
  }, () => now);
  assert.deepEqual(await Promise.all([token(), token()]), ["fixture-1", "fixture-1"]);
  now += 59_000;
  assert.equal(await token(), "fixture-1");
  now += 2_000;
  assert.equal(await token(), "fixture-2");
  assert.equal(requests, 2);
});

test("a failed metadata refresh cannot reuse a stale token", async () => {
  let now = 1_000_000;
  let requests = 0;
  const token = createMetadataIamToken(async () => {
    requests++;
    if (requests === 2) return Response.json({ access_token: "fixture-invalid", expires_in: 0 });
    return Response.json({ access_token: `fixture-${requests}`, expires_in: 120, token_type: "Bearer" });
  }, () => now);
  assert.equal(await token(), "fixture-1");
  now += 120_000;
  await assert.rejects(token(), /Invalid metadata authentication response/u);
  assert.equal(await token(), "fixture-3");
});
