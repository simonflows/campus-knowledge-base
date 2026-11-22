import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { GetCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { NextRequest } from "next/server";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import * as draftRoute from "../app/api/editor/drafts/[id]/route";
import { GET as listDrafts } from "../app/api/editor/drafts/route";
import { SESSION_COOKIE, signSessionToken } from "../lib/auth-server";
import { docClient, resetDbAvailableCache } from "../lib/db";
import { editorialContentSchema, type EditorialDocument, type EditorialRevision } from "../lib/editorial";
import { TableName } from "../lib/schema";

const author = "demo-pr-midis";
const origin = "https://draft-delete-fixture.invalid";
const timestamp = "2026-11-23T01:00:00.000Z";
const content = editorialContentSchema.parse({ universityId: "midis", title: "Synthetic draft" });
const draft: EditorialDocument = {
  id: "fixture-draft", ownerId: author, ownerName: "Fixture author", originalId: "fixture-draft",
  channel: "Оригинал", version: 2, revisionId: "revision-1", submittedRevisionId: null,
  approvedRevisionId: null, status: "draft", content, events: [], createdAt: timestamp, updatedAt: timestamp,
};
const revision: EditorialRevision = {
  id: draft.revisionId, documentId: draft.id, number: 1, content,
  actorId: author, actorName: "Fixture author", createdAt: timestamp,
};

type Action = (request: NextRequest, context: { params: Promise<{ id: string }> }) => Promise<Response>;
function call(handler: Action, method: string, profile: string, body?: unknown, requestOrigin = origin) {
  const request = new NextRequest(origin + "/api/editor/drafts/" + draft.id, {
    method,
    headers: {
      "Content-Type": "application/json", origin: requestOrigin,
      ...(profile ? { cookie: `${SESSION_COOKIE}=${signSessionToken(profile)}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const store = createRequestStoreForAPI(
    request, request.nextUrl, { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined, undefined,
  );
  return workAsyncStorage.run({} as NonNullable<ReturnType<typeof workAsyncStorage.getStore>>, () =>
    workUnitAsyncStorage.run(store, () => handler(request, { params: Promise.resolve({ id: draft.id }) })));
}

function remove(profile = author, body: unknown = { version: 2 }, requestOrigin = origin) {
  const handler = Reflect.get(draftRoute, "DELETE") as Action | undefined;
  return handler ? call(handler, "DELETE", profile, body, requestOrigin) : Response.json({}, { status: 405 });
}

function storage(context: TestContext, {
  initial = draft, available = true, race = false, published = false,
}: { initial?: EditorialDocument; available?: boolean; race?: boolean; published?: boolean } = {}) {
  Object.assign(process.env, {
    CAMPUS_PUBLIC_ORIGIN: origin, USE_DATABASE: available ? "true" : "false",
    DOCUMENT_API_ENDPOINT: "http://127.0.0.1:1", CAMPUS_DEMO_LOGIN: "true",
    CAMPUS_PILOT_ACCOUNTS: "", CAMPUS_LOCAL_DEMO: "false", OUTPUT_MODE: "", SESSION_SECRET: "",
  });
  resetDbAvailableCache();
  context.after(resetDbAvailableCache);
  let head = structuredClone(initial);
  const history = new Map<string, unknown>([[revision.id, structuredClone(revision)]]);
  const publication = { id: published ? draft.id : "independent-article", approval: { revisionId: "published-revision" } };
  let committed = 0;
  context.mock.method(globalThis, "fetch", async () => assert.fail("Draft deletion must use no remote provider"));
  context.mock.method(docClient, "send", async (command: unknown) => {
    if (command instanceof ListTablesCommand) return {};
    if (command instanceof GetCommand) {
      if (command.input.TableName === TableName.EDITORIAL_DOCUMENTS) return { Item: structuredClone(head) };
      return { Item: history.get(command.input.Key?.id) };
    }
    if (command instanceof ScanCommand) {
      if (command.input.TableName === TableName.EDITORIAL_DOCUMENTS) return { Items: [structuredClone(head)] };
      if (command.input.TableName === TableName.ARTICLES) return { Items: [structuredClone(publication)] };
      return { Items: [...history.values()] };
    }
    assert.ok(command instanceof TransactWriteCommand);
    const writes = command.input.TransactItems ?? [];
    if (race) head = { ...head, version: 3, status: "submitted", submittedRevisionId: head.revisionId };
    for (const operation of writes) {
      if (operation.ConditionCheck) {
        const check = operation.ConditionCheck;
        assert.equal(check.TableName, TableName.ARTICLES);
        assert.equal(check.ConditionExpression, "attribute_not_exists(id)");
        if (check.Key?.id === publication.id) throw conditionalFailure();
        continue;
      }
      const put = operation.Put;
      assert.ok(put, "Deletion must retain the original records");
      if (put.TableName !== TableName.EDITORIAL_DOCUMENTS) continue;
      assert.match(put.ConditionExpression ?? "", /#version = :version/);
      assert.match(put.ConditionExpression ?? "", /ownerId = :ownerId/);
      if (put.ExpressionAttributeValues?.[":version"] !== head.version ||
          put.ExpressionAttributeValues?.[":ownerId"] !== head.ownerId) throw conditionalFailure();
    }
    for (const { Put: put } of writes) {
      if (!put?.Item) continue;
      if (put.TableName === TableName.EDITORIAL_DOCUMENTS) head = put.Item as EditorialDocument;
      else {
        assert.equal(put.TableName, TableName.EDITORIAL_REVISIONS);
        history.set(put.Item.id, put.Item);
      }
    }
    committed++;
    return {};
  });
  return { head: () => head, history, committed: () => committed };
}

function conditionalFailure() {
  return Object.assign(new Error("Fixture condition failed"), { name: "ConditionalCheckFailedException" });
}

test("own saved draft disappears from list and deep link while its revision and audit are retained", async context => {
  const db = storage(context);
  const before = await call(listDrafts, "GET", author);
  assert.equal((await before.json()).documents.length, 1);
  const response = await remove();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  assert.equal(db.head().version, 3);
  assert.deepEqual(db.head().content, content);
  assert.deepEqual(db.history.get(revision.id), revision);
  assert.ok([...db.history.values()].some(row => {
    const audit = row as { event?: { action: string; actorId: string; revisionId: string } };
    return audit.event?.action === "deleted" &&
      audit.event.actorId === author && audit.event.revisionId === revision.id;
  }));
  const after = await call(listDrafts, "GET", author);
  assert.deepEqual((await after.json()).documents, []);
  assert.equal((await call(draftRoute.GET, "GET", author)).status, 404);
  assert.equal((await call(draftRoute.PATCH, "PATCH", author, { action: "save", version: 3, content })).status, 404);
  assert.equal((await remove()).status, 404);
  assert.equal(db.committed(), 1);
});

test("deletion validates origin, session and version and gives reviewers no delete access", async context => {
  const db = storage(context, { initial: { ...draft, status: "returned", reviewerId: "demo-owner-midis", submittedRevisionId: revision.id } });
  assert.equal((await remove(author, { version: 2 }, "https://other.invalid")).status, 403);
  assert.equal((await remove("")).status, 401);
  assert.equal((await remove(author, {})).status, 400);
  assert.equal((await remove("demo-guest")).status, 404);
  assert.equal((await remove("demo-pr-csu")).status, 404);
  assert.equal((await remove("demo-admin")).status, 404);
  assert.equal((await remove("demo-owner-midis")).status, 404);
  assert.equal((await remove(author, { version: 1 })).status, 409);
  assert.equal(db.committed(), 0);
  assert.equal((await remove()).status, 200);
});

test("a draft awaiting approval cannot be deleted", async context => {
  const db = storage(context, { initial: { ...draft, status: "submitted", submittedRevisionId: revision.id } });
  assert.equal((await remove()).status, 409);
  assert.equal(db.committed(), 0);
});

test("an approved document cannot be deleted even if its approval reference was not stored", async context => {
  const db = storage(context, { initial: { ...draft, status: "approved" } });
  assert.equal((await remove()).status, 409);
  assert.equal(db.committed(), 0);
});

test("a new draft of an already approved document cannot be deleted", async context => {
  const db = storage(context, { initial: { ...draft, approvedRevisionId: "earlier-revision" } });
  assert.equal((await remove()).status, 409);
  assert.equal(db.committed(), 0);
});

test("a stored publication protects the material even when its draft has no approval reference", async context => {
  const db = storage(context, { published: true });
  assert.equal((await remove()).status, 409);
  assert.deepEqual(db.head(), draft);
  assert.equal(db.committed(), 0);
});

test("a concurrent submission wins and no deletion event is committed", async context => {
  const db = storage(context, { race: true });
  assert.equal((await remove()).status, 409);
  assert.equal(db.head().status, "submitted");
  assert.equal(db.history.size, 1);
  assert.equal(db.committed(), 0);
});

test("storage unavailability yields 503 and leaves the draft untouched", async context => {
  const db = storage(context, { available: false });
  assert.equal((await remove()).status, 503);
  assert.deepEqual(db.head(), draft);
  assert.equal(db.committed(), 0);
});
