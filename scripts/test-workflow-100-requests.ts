import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { NextRequest } from "next/server";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { POST as createRequest } from "../app/api/requests/route";
import { GET as getRequest, PATCH as updateRequest } from "../app/api/requests/[id]/route";
import { canEditCard, demoAccounts, getDemoAccount } from "../lib/auth";
import { SESSION_COOKIE, signSessionToken } from "../lib/auth-server";
import { readBrowserDemo } from "../lib/browser-demo";
import { handleDemoCollaboration } from "../lib/browser-demo-collaboration";
import { docClient, resetDbAvailableCache } from "../lib/db";
import { canSeeInformationRequest, type InformationRequest, updateInformationRequestSchema } from "../lib/information-requests";
import { createInformationRequest, listInformationRequests, mutateInformationRequest } from "../lib/information-requests-models";
import type { ProjectCard } from "../lib/knowledge";
import { sessionDirectory } from "../lib/pilot-auth";
import { TableName } from "../lib/schema";
import { knowledgeCardInputSchema } from "../lib/validation/knowledge";
import { installPilotFixture } from "./pilot-fixture";

const origin = "https://workflow-fixture.invalid";
const createdAt = "2026-11-20T09:00:00.000Z";

function fixture(context: TestContext, { multipleLeads = false, answerLength = 50, mode = "" } = {}) {
  const people = installPilotFixture();
  if (multipleLeads) {
    process.env.CAMPUS_PILOT_ACCOUNTS = JSON.stringify([...people.rows, {
      login: "qa-second-lead",
      name: "QA second lead",
      profile: "demo-owner-midis",
      keyHash: createHash("sha256").update(randomUUID()).digest("hex"),
    }]);
  }
  process.env.DOCUMENT_API_ENDPOINT = "http://127.0.0.1:1";
  process.env.USE_DATABASE = "true";
  process.env.OUTPUT_MODE = mode;
  process.env.CAMPUS_LOCAL_DEMO = "false";
  process.env.CAMPUS_EMAIL_ACCOUNTS_ENABLED = "false";
  process.env.CAMPUS_PUBLIC_ORIGIN = origin;
  resetDbAvailableCache();
  context.after(resetDbAvailableCache);

  const requester = people.account("demo-pr-susu");
  const recipient = people.account("demo-pr-midis");
  const item: InformationRequest = {
    id: "test-request", authorId: requester.id, authorName: requester.name,
    authorOrganization: requester.organization, recipientUniversityId: "midis",
    subject: "Проверка сведений о проекте", question: "Предоставьте сведения о стадии проекта.",
    linkedCardId: null, status: "answered", answer: "а".repeat(answerLength),
    evidenceUrl: "https://example.org/official-evidence", answeredBy: recipient.id,
    candidateCardId: null, createdAt, updatedAt: createdAt, revision: 1,
    creationDigest: "fixture", lastOperationId: null, lastOperationDigest: null,
  };
  let candidate: ProjectCard | undefined;
  let sharedReads = 0;
  context.mock.method(globalThis, "fetch", async () => assert.fail("Fixture must not contact any provider"));
  context.mock.method(docClient, "send", async (command: unknown) => {
    if (command instanceof ListTablesCommand) return { TableNames: [] };
    if (command instanceof GetCommand && command.input.TableName === TableName.INFORMATION_REQUESTS) {
      sharedReads++;
      return { Item: item };
    }
    if (command instanceof TransactWriteCommand) {
      candidate = command.input.TransactItems?.find(entry => entry.Put?.TableName === TableName.KNOWLEDGE_CARDS)?.Put?.Item as ProjectCard | undefined;
      return {};
    }
    return assert.fail("Unexpected fixture DB operation");
  });
  async function submit() {
    const submitted = await mutateInformationRequest(requester, item.id, {
      action: "submit", revision: item.revision, operationId: randomUUID(),
    });
    assert.equal(submitted.status, "submitted");
    assert.ok(candidate);
    assert.equal(submitted.candidateCardId, candidate.id);
    return candidate;
  }
  return { item, requester, submit, sharedReads: () => sharedReads };
}

type RequestHandler = (request: NextRequest, context: { params: Promise<{ id: string }> }) => Promise<Response>;
function call(handler: RequestHandler, method: "GET" | "POST" | "PATCH", path: string, requesterId: string, requestOrigin = origin) {
  const request = new NextRequest(`${origin}/api/requests${path}`, {
    method,
    headers: { origin: requestOrigin, cookie: `${SESSION_COOKIE}=${signSessionToken(requesterId)}` },
    ...(method === "GET" ? {} : { body: JSON.stringify({}) }),
  });
  const store = createRequestStoreForAPI(
    request, request.nextUrl, { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined, undefined,
  );
  return workAsyncStorage.run({} as NonNullable<ReturnType<typeof workAsyncStorage.getStore>>, () =>
    workUnitAsyncStorage.run(store, () => handler(request, { params: Promise.resolve({ id: path.slice(1) }) })));
}

test("a maximum-length answer becomes a valid card with its complete source", async context => {
  const db = fixture(context, { answerLength: 10_000 });
  const candidate = await db.submit();
  const ready = knowledgeCardInputSchema.safeParse({ ...candidate, readinessStage: "Идея", contour: "собственный проект вуза" });
  assert.ok(ready.success, JSON.stringify(ready.error?.issues));
  assert.equal(ready.data.referenceDescription, db.item.answer);
  assert.equal(ready.data.sources?.[0]?.url, db.item.evidenceUrl);
  assert.equal(candidate.status, "pending");
  const owner = sessionDirectory().find(account => account.id === candidate.ownerIds?.[0]);
  assert.ok(owner);
  assert.equal(canEditCard(owner, candidate), true);
});

test("an answer by PR with multiple eligible leads leaves the new card for explicit coordinator assignment", async context => {
  const db = fixture(context, { multipleLeads: true });
  assert.equal(sessionDirectory().filter(account => account.role === "university_owner" && account.universityId === "midis").length, 2);
  const candidate = await db.submit();
  assert.deepEqual(candidate.ownerIds, []);
  assert.equal(candidate.status, "pending");
});

test("a designated lead can edit the candidate when more than one lead is eligible", async context => {
  const db = fixture(context, { multipleLeads: true });
  const lead = sessionDirectory().find(account => account.id === "pilot-qa-second-lead");
  assert.ok(lead);
  db.item.responsibleId = lead.id;
  const candidate = await db.submit();
  assert.deepEqual(candidate.ownerIds, [lead.id]);
  assert.equal(canEditCard(lead, candidate), true);
});

test("an export instance does not access the shared request table", async context => {
  const db = fixture(context, { mode: "export" });
  assert.equal((await call(getRequest, "GET", `/${db.item.id}`, db.requester.id)).status, 503);
  assert.equal((await call(createRequest, "POST", "", db.requester.id)).status, 503);
  assert.equal((await call(updateRequest, "PATCH", `/${db.item.id}`, db.requester.id)).status, 503);
  assert.equal(db.sharedReads(), 0);
});

test("information request writes reject another browser origin before reading requests", async context => {
  const db = fixture(context);
  const otherOrigin = "https://another-fixture.invalid";
  assert.equal((await call(createRequest, "POST", "", db.requester.id, otherOrigin)).status, 403);
  assert.equal((await call(updateRequest, "PATCH", `/${db.item.id}`, db.requester.id, otherOrigin)).status, 403);
  assert.equal(db.sharedReads(), 0);
});

test("an author cannot access former staff requests after a role change", async context => {
  const db = fixture(context);
  const author = { ...db.requester, role: "author" as const };
  assert.equal(canSeeInformationRequest(author, db.item), false);
  const denied = { status: 403 };
  await assert.rejects(listInformationRequests(author), denied);
  await assert.rejects(createInformationRequest(author, {
    operationId: randomUUID(), recipientUniversityId: "midis", subject: db.item.subject,
    question: db.item.question, linkedCardId: null,
  }), denied);
  await assert.rejects(mutateInformationRequest(author, db.item.id, {
    action: "submit", revision: db.item.revision, operationId: randomUUID(),
  }), denied);
  assert.equal(db.sharedReads(), 0);
});

test("the demo staff queue rejects a guest and an author before producing its response", async context => {
  const guest = getDemoAccount("demo-guest");
  assert.ok(guest);
  const author = { ...guest, id: "fixture-demo-author", role: "author" as const };
  const accountCount = demoAccounts.length;
  demoAccounts.push(author);
  context.after(() => { demoAccounts.splice(accountCount, 1); });
  const state = readBrowserDemo({ getItem: () => null, setItem: () => {} });
  for (const { id } of [guest, author]) {
    const response = await handleDemoCollaboration({
      state: { ...state, profile: id }, url: new URL("/api/work", origin), method: "GET",
      headers: new Headers(), body: () => assert.fail("GET must not read a payload"),
      save: () => assert.fail("GET must not change demo state"),
    });
    assert.equal(response?.status, 403);
  }
});

test("request answers use the same HTTPS source validation as cards", () => {
  const result = updateInformationRequestSchema.safeParse({
    action: "answer", operationId: randomUUID(), revision: 0,
    answer: "Официальный источник ответа",
    evidenceUrl: "HTTPS://example.org/official-evidence",
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});
