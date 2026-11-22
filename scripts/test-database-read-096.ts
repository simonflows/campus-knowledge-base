import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { ScanCommand, type ScanCommandOutput } from "@aws-sdk/lib-dynamodb";
import { docClient, resetDbAvailableCache } from "../lib/db";
import { knowledgeSeedCards, type CardTypeDefinition } from "../lib/knowledge";
import { getAllCardTypes, getAllKnowledgeCards } from "../lib/models";
import { TableName } from "../lib/schema";

const fixtureType: CardTypeDefinition = {
  id: "qa-read-type",
  name: "Учебный тип",
  description: "",
  fields: [],
  createdAt: "2026-11-23T00:00:00Z",
  updatedAt: "2026-11-23T00:00:00Z",
};

function serviceError(name: string, httpStatusCode: number) {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}

function mockReads(
  context: TestContext,
  table: TableName,
  read: (command: ScanCommand, signal?: AbortSignal) => Omit<ScanCommandOutput, "$metadata">
) {
  const settings = {
    DOCUMENT_API_ENDPOINT: "http://127.0.0.1:1",
    USE_DATABASE: "true",
    OUTPUT_MODE: "",
    CAMPUS_LOCAL_DEMO: "false",
  };
  Object.assign(process.env, settings);
  resetDbAvailableCache();
  context.after(() => {
    for (const name of Object.keys(settings)) delete process.env[name];
    resetDbAvailableCache();
  });
  const calls: Array<{ cursor: ScanCommand["input"]["ExclusiveStartKey"]; signal?: AbortSignal }> = [];
  context.mock.method(docClient, "send", async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
    if (command instanceof ListTablesCommand) return { $metadata: {} };
    assert.ok(command instanceof ScanCommand, "The read fixture has no other I/O");
    assert.equal(command.input.TableName, table);
    assert.equal(command.input.ConsistentRead, true);
    const signal = options?.abortSignal;
    calls.push({ cursor: command.input.ExclusiveStartKey, signal });
    return { ...read(command, signal), $metadata: {} };
  });
  return calls;
}

test("card types recover from two DynamoDB throttles and return the third response", async (context) => {
  let remaining = 2;
  const calls = mockReads(context, TableName.KNOWLEDGE_CARD_TYPES, () => {
    if (remaining-- > 0) throw serviceError("ProvisionedThroughputExceededException", 400);
    return { Items: [fixtureType] };
  });
  assert.deepEqual(await getAllCardTypes(), [fixtureType]);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].signal);
  assert.ok(calls.every(({ signal }) => signal === calls[0].signal));
});

test("the bounded read keeps the final service error when all three attempts fail", async (context) => {
  let attempt = 0;
  const last = serviceError("ServiceUnavailable", 503);
  const calls = mockReads(context, TableName.KNOWLEDGE_CARD_TYPES, () => {
    if (++attempt < 3) throw serviceError("ServiceUnavailable", 503);
    throw last;
  });
  await assert.rejects(getAllCardTypes(), (error) => error === last);
  assert.equal(calls.length, 3);
});

test("temporary HTTP errors, DynamoDB request timeouts and a narrow transport error can recover", async (context) => {
  let failure: Error | null = null;
  const calls = mockReads(context, TableName.KNOWLEDGE_CARD_TYPES, () => {
    if (failure) {
      const previous = failure;
      failure = null;
      throw previous;
    }
    return { Items: [fixtureType] };
  });
  const failures = [
    serviceError("RequestTimeout", 400),
    serviceError("RequestTimeoutException", 400),
    ...[408, 429, 500, 502, 503, 504].map((status) => serviceError("ReadFailure", status)),
    Object.assign(new Error("Read connection reset"), { code: "ECONNRESET" }),
  ];
  for (const error of failures) {
    failure = error;
    assert.deepEqual(await getAllCardTypes(), [fixtureType]);
  }
  assert.equal(calls.length, failures.length * 2);
});

test("validation, authorization, missing resources, conditional and aborted errors fail without retries", async (context) => {
  let failure: Error;
  const calls = mockReads(context, TableName.KNOWLEDGE_CARD_TYPES, () => { throw failure; });
  const failures = [
    serviceError("ValidationException", 400),
    serviceError("AccessDeniedException", 403),
    serviceError("ResourceNotFoundException", 400),
    serviceError("ConditionalCheckFailedException", 400),
    serviceError("InvalidSignatureException", 403),
    serviceError("AccessDeniedException", 503),
    serviceError("AbortError", 503),
    serviceError("ReadFailure", 404),
    new Error("Ordinary application error"),
  ];
  for (const error of failures) {
    const before = calls.length;
    failure = error;
    await assert.rejects(getAllCardTypes(), (caught) => caught === error);
    assert.equal(calls.length, before + 1, error.name);
  }
});

test("aborting while waiting to retry does not start a second Scan", async (context) => {
  const caller = new AbortController();
  const started = Promise.withResolvers<void>();
  const calls = mockReads(context, TableName.KNOWLEDGE_CARD_TYPES, () => {
    started.resolve();
    throw serviceError("ThrottlingException", 400);
  });
  await Promise.all([
    assert.rejects(getAllCardTypes(caller.signal), { name: "AbortError" }),
    (async () => {
      await started.promise;
      await nextTurn();
      caller.abort();
    })(),
  ]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].signal?.aborted);
});

test("cancellation before the Scan starts makes no Scan request", async (context) => {
  const caller = new AbortController();
  const calls = mockReads(context, TableName.KNOWLEDGE_CARD_TYPES, () => ({ Items: [fixtureType] }));
  const pending = getAllCardTypes(caller.signal);
  caller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls.length, 0);
});

test("the 8-second page deadline covers the first attempt and its retry", async (context) => {
  const deadline = new AbortController();
  const reason = new DOMException("Test page deadline elapsed", "TimeoutError");
  const nativeTimeout = AbortSignal.timeout;
  const durations: number[] = [];
  context.mock.method(AbortSignal, "timeout", (duration: number) => {
    if (duration !== 8_000) return nativeTimeout(duration);
    durations.push(duration);
    return deadline.signal;
  });
  let scans = 0;
  const calls = mockReads(context, TableName.KNOWLEDGE_CARD_TYPES, (_command, signal) => {
    if (++scans === 1) throw serviceError("ServiceUnavailable", 503);
    deadline.abort(reason);
    assert.ok(signal?.aborted);
    return { Items: [fixtureType] };
  });
  await assert.rejects(getAllCardTypes(), (error) => error === reason);
  assert.deepEqual(durations, [8_000]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].signal, calls[1].signal);
});

test("retrying a later knowledge cards page preserves its cursor and does not duplicate the first page", async (context) => {
  const [first, second] = knowledgeSeedCards;
  const cursor = { id: first.id };
  let laterCalls = 0;
  const calls = mockReads(context, TableName.KNOWLEDGE_CARDS, ({ input }) => {
    if (!input.ExclusiveStartKey) return { Items: [first], LastEvaluatedKey: cursor };
    if (++laterCalls < 3) throw serviceError("Throttling", 400);
    return { Items: [second] };
  });
  assert.deepEqual(await getAllKnowledgeCards(), [first, second]);
  assert.deepEqual(calls.map(({ cursor: sent }) => sent), [undefined, cursor, cursor, cursor]);
  assert.notEqual(calls[0].signal, calls[1].signal);
  assert.ok(calls.slice(1).every(({ signal }) => signal === calls[1].signal));
});

test("a second knowledge cards read fetches current data after a fixture update", async (context) => {
  let row = knowledgeSeedCards[0];
  const calls = mockReads(context, TableName.KNOWLEDGE_CARDS, () => ({ Items: [structuredClone(row)] }));
  const original = await getAllKnowledgeCards();
  row = { ...row, title: "Актуальный заголовок после изменения" };
  assert.deepEqual(await getAllKnowledgeCards(), [row]);
  assert.notEqual(original[0].title, row.title);
  assert.equal(calls.length, 2);
});
