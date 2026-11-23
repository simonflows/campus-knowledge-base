import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptsFactCheckStream, streamFactCheck } from "../lib/fact-check-stream";

const endpoint = "https://canon.invalid/api/fact-check";

test("the semantic stream is opt-in and emits progress before the final payload", async () => {
  const request = new Request(endpoint, { headers: { Accept: "application/x-ndjson" } });
  assert.equal(acceptsFactCheckStream(request), true);
  assert.equal(acceptsFactCheckStream(new Request(endpoint)), false);
  assert.equal(acceptsFactCheckStream(new Request(endpoint, { headers: { Accept: "application/x-ndjson;q=0" } })), false);
  const final = { summary: { red: 0, yellow: 1, green: 0, total: 1 } };
  const response = streamFactCheck(request, async (_scoped, onProgress) => {
    onProgress({ stage: "extract", completed: 0, total: 4 });
    onProgress({ stage: "extract", completed: 4, total: 4 });
    onProgress({ stage: "verify", completed: 1, total: 1 });
    return { ok: true, result: final };
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") ?? "", /^application\/x-ndjson/u);
  assert.equal(response.headers.get("X-Accel-Buffering"), "no");
  const records = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(records, [
    { type: "heartbeat" },
    { type: "progress", stage: "extract", completed: 0, total: 4 },
    { type: "progress", stage: "extract", completed: 4, total: 4 },
    { type: "progress", stage: "verify", completed: 1, total: 1 },
    { type: "result", result: final },
  ]);
});

test("an error after headers becomes a safe terminal record", async () => {
  const request = new Request(endpoint);
  const failed = streamFactCheck(request, async () => ({ ok: false, status: 503, error: "База недоступна." }));
  assert.equal(failed.status, 200);
  assert.deepEqual((await failed.text()).trim().split("\n").map(line => JSON.parse(line)).at(-1), {
    type: "error", status: 503, error: "База недоступна.",
  });
  const unexpected = streamFactCheck(request, async () => { throw new Error("private adapter failure"); });
  const body = await unexpected.text();
  assert.doesNotMatch(body, /private adapter failure/u);
  assert.equal(JSON.parse(body.trim().split("\n").at(-1)!).status, 500);
});

test("cancelling the reader aborts the in-flight task and releases its wait", async () => {
  let scoped: AbortSignal | undefined;
  let done: () => void = () => {};
  const released = new Promise<void>(resolve => { done = resolve; });
  const response = streamFactCheck(new Request(endpoint), async (request) => {
    scoped = request.signal;
    await new Promise<void>(resolve => {
      if (request.signal.aborted) resolve();
      else request.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    done();
    return { ok: true, result: {} };
  });
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  assert.equal(scoped?.aborted, false);
  await reader.cancel();
  await released;
  assert.equal(scoped?.aborted, true);
  assert.equal((await reader.read()).done, true);
});
