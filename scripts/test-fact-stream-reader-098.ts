import assert from "node:assert/strict";
import { test } from "node:test";
import { readFactCheckResponse } from "../lib/read-fact-check-response";
import { factCheckResultSchema } from "../lib/validation/fact-check-result";
import { checkFactText, FACT_CHECK_EXAMPLE_TEXT } from "../lib/fact-check";
import { knowledgeSeedCards } from "../lib/knowledge";

function stream(text: string, split = false) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        if (split)
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        else controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } }
  );
}

test("legacy JSON and pre-stream HTTP errors keep their existing payload", async () => {
  assert.deepEqual(
    await readFactCheckResponse(Response.json({ summary: "legacy" })),
    { summary: "legacy" }
  );
  assert.deepEqual(
    await readFactCheckResponse(
      Response.json({ error: "Войдите" }, { status: 401 })
    ),
    { error: "Войдите" }
  );
});

test("split UTF-8, progress and heartbeat produce exactly the final payload", async () => {
  const progress: unknown[] = [];
  const response = stream(
    [
      { type: "heartbeat" },
      { type: "progress", stage: "extract", completed: 1, total: 2 },
      { type: "progress", stage: "verify", completed: 1, total: 1 },
      { type: "result", result: { text: "Площадь кампуса — 123 тыс. м²." } },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
    true
  );
  assert.deepEqual(
    await readFactCheckResponse(response, (p) => progress.push(p)),
    { text: "Площадь кампуса — 123 тыс. м²." }
  );
  assert.deepEqual(progress, [
    { stage: "extract", completed: 1, total: 2 },
    { stage: "verify", completed: 1, total: 1 },
  ]);
});

test("stream errors and truncated streams never become completed checks", async () => {
  await assert.rejects(
    readFactCheckResponse(
      stream('{"type":"error","error":"Источники изменились","status":409}\n')
    ),
    /Источники изменились/
  );
  await assert.rejects(
    readFactCheckResponse(stream('{"type":"heartbeat"}\n')),
    /не завершена/
  );
  await assert.rejects(
    readFactCheckResponse(stream('{"type":"result","result":')),
    /не завершена|Некорректный/
  );
});

test("invalid counts, unknown events and duplicate terminal records are rejected", async () => {
  for (const text of [
    '{"type":"progress","stage":"extract","completed":4,"total":2}\n',
    '{"type":"progress","stage":"extract","completed":0.5,"total":2}\n',
    '{"type":"other"}\n',
    '{"type":"result","result":{}}\n{"type":"result","result":{}}\n',
  ])
    await assert.rejects(readFactCheckResponse(stream(text)), /Некорректный/);
});

test("reader cancellation aborts a stalled connection without a final result", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"heartbeat"}\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const pending = readFactCheckResponse(
    new Response(body, { headers: { "Content-Type": "application/x-ndjson" } }),
    undefined,
    abort.signal
  );
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("a large planned verification count survives a smaller execution budget", async () => {
  const progress: unknown[] = [];
  const response = stream(
    '{"type":"progress","stage":"verify","completed":0,"total":1095}\n{"type":"result","result":{"mode":"mixed"}}\n'
  );
  assert.deepEqual(
    await readFactCheckResponse(response, (value) => progress.push(value)),
    { mode: "mixed" }
  );
  assert.deepEqual(progress, [{ stage: "verify", completed: 0, total: 1095 }]);
});

test("the runtime report schema accepts the actual engine response and rejects render-breaking fields", () => {
  const result = checkFactText(FACT_CHECK_EXAMPLE_TEXT, knowledgeSeedCards);
  assert.equal(factCheckResultSchema.safeParse(result).success, true);
  for (const patch of [
    { checkedChars: undefined },
    { checkedChars: -1 },
    { checkedChars: "100" },
    { checkpoints: [null] },
    { findings: [null] },
    { findings: [{ level: "green" }] },
    { ai: { status: "ready", claims: null } },
    { rewrite: { plainText: "bad" } },
  ])
    assert.equal(
      factCheckResultSchema.safeParse({ ...result, ...patch }).success,
      false
    );
});
