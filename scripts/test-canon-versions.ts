import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { DeleteCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db";
import {
  getPublicApprovedCard,
  knowledgeSeedCards,
  type KnowledgeCard,
  type ProjectCard,
} from "../lib/knowledge";
import {
  createKnowledgeCard,
  deleteKnowledgeCard,
  getKnowledgeCardById,
  setKnowledgeCardModeration,
  updateKnowledgeCard,
} from "../lib/models";
import {
  ensureApprovedCardVersion,
  getApprovedCardVersion,
  getCardVersionId,
} from "../lib/knowledge-versions";
import { TableName } from "../lib/schema";
import { knowledgeCardInputSchema } from "../lib/validation/knowledge";
import { requireFixtureDatabase } from "./qa-fixture";
import { installPilotFixture } from "./pilot-fixture";

async function storedVersions(cardId: string) {
  const page = await docClient.send(
    new ScanCommand({
      TableName: TableName.KNOWLEDGE_CARD_VERSIONS,
      FilterExpression: "cardId = :card",
      ExpressionAttributeValues: { ":card": cardId },
      ConsistentRead: true,
    })
  );
  return page.Items ?? [];
}

function removeFixtureCard(context: TestContext, card: KnowledgeCard) {
  context.after(async () => {
    await deleteKnowledgeCard(card.id);
    for (const version of await storedVersions(card.id)) {
      assert.equal(version.cardId, card.id);
      await docClient.send(
        new DeleteCommand({
          TableName: TableName.KNOWLEDGE_CARD_VERSIONS,
          Key: { id: version.id },
        })
      );
    }
  });
}

test("publishing a new approved card stores its snapshot", async (context) => {
  await requireFixtureDatabase();
  const input = knowledgeCardInputSchema.parse(knowledgeSeedCards[0]);
  const approved = await createKnowledgeCard(
    { ...input, title: "QA: новый утверждённый факт" },
    {
      status: "approved",
      submittedBy: "qa-coordinator",
      submittedByName: "Координатор QA",
    }
  );
  removeFixtureCard(context, approved);
  const history = await storedVersions(approved.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].snapshot.title, approved.title);
  assert.equal(history[0].actorId, "qa-coordinator");
  assert.equal(history[0].legacyBaseline, false);
});

const project = knowledgeSeedCards.find(
  (card): card is ProjectCard => card.type === "project" && !card.isJoint
)!;
const coordinator = {
  id: "qa-coordinator",
  name: "Координатор QA",
  isAdmin: true,
};

async function legacyCard(context: TestContext) {
  const card: ProjectCard = {
    ...project,
    id: "qa-legacy-versions-" + randomUUID(),
    title: "QA: первый опубликованный снимок",
    ownerIds: ["qa-internal-owner"],
    confirmedFigures: ["12 образцов"],
  };
  await docClient.send(
    new PutCommand({
      TableName: TableName.KNOWLEDGE_CARDS,
      Item: card,
      ConditionExpression: "attribute_not_exists(id)",
    })
  );
  removeFixtureCard(context, card);
  return card;
}

async function routeFixture() {
  Object.assign(globalThis, { AsyncLocalStorage });
  const pilot = installPilotFixture();
  const { NextRequest } = await import("next/server");
  const { workAsyncStorage } =
    await import("next/dist/server/app-render/work-async-storage.external");
  const { workUnitAsyncStorage } =
    await import("next/dist/server/app-render/work-unit-async-storage.external");
  const { SESSION_COOKIE, signSessionToken } =
    await import("../lib/auth-server");
  const origin = "http://127.0.0.2:8080";
  process.env.CAMPUS_PUBLIC_ORIGIN = origin;
  return {
    account: pilot.account,
    call<T>(
      path: string,
      handler: (request: InstanceType<typeof NextRequest>) => Promise<T>,
      options?: {
        method: "GET" | "PATCH" | "POST";
        account: string;
        expected?: string;
        body?: unknown;
      }
    ) {
      const uri = "/api/knowledge/cards/" + path;
      const request = new NextRequest(
        origin + uri,
        options && {
          method: options.method,
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            ...(options.expected !== undefined && {
              "If-Match": options.expected,
            }),
          },
          body: JSON.stringify(options.body),
        }
      );
      const token = options
        ? signSessionToken(pilot.account(options.account).id)
        : "";
      const cookies = {
        get: (name: string) =>
          token && name === SESSION_COOKIE ? { name, value: token } : undefined,
      };
      return workAsyncStorage.run({ route: uri } as never, () =>
        workUnitAsyncStorage.run(
          { type: "request", phase: "render", cookies } as never,
          () => handler(request)
        )
      );
    },
  };
}

test("a permalink opened before legacy capture keeps its exact contents across a new publication", async (context) => {
  await requireFixtureDatabase();
  const legacy = await legacyCard(context);
  const oldId = getCardVersionId(legacy);
  const { call } = await routeFixture();
  const { GET: openVersion } =
    await import("../app/api/knowledge/cards/[id]/versions/[versionId]/route");
  const { GET: listVersions } =
    await import("../app/api/knowledge/cards/[id]/versions/route");
  const selected = {
    params: Promise.resolve({ id: legacy.id, versionId: oldId }),
  };
  const oldHref = legacy.id + "/versions/" + oldId;
  const before = await call(oldHref, (request) =>
    openVersion(request, selected)
  );
  assert.equal(before.status, 200);
  assert.equal((await before.json()).legacyBaseline, true);
  assert.equal(
    await getApprovedCardVersion(oldId),
    null,
    "A public read never writes history"
  );

  const next = await updateKnowledgeCard(
    legacy.id,
    knowledgeCardInputSchema.parse({
      ...legacy,
      title: "QA: новая цифра",
      confirmedFigures: ["32 образца"],
      changeReason: "Новый отчёт",
    }),
    coordinator,
    legacy.updatedAt
  );
  assert.ok(next);
  assert.notEqual(getCardVersionId(next), oldId);
  assert.equal(
    (await getApprovedCardVersion(getCardVersionId(next)))?.snapshot.reviewedAt,
    next.updatedAt
  );
  const after = await call(oldHref, (request) =>
    openVersion(request, selected)
  );
  const opened = await after.json();
  assert.equal(after.status, 200);
  assert.equal(opened.snapshot.title, legacy.title);
  assert.deepEqual(opened.snapshot.confirmedFigures, ["12 образцов"]);
  assert.equal(opened.snapshot.ownerIds, undefined);
  assert.equal(opened.actorId, undefined);
  assert.ok(opened.recordedAt);
  const history = await call(legacy.id + "/versions", (request) =>
    listVersions(request, { params: Promise.resolve({ id: legacy.id }) })
  );
  const list = await history.json();
  assert.equal(list.currentVersionId, getCardVersionId(next));
  assert.equal(list.versions.length, 2);
  assert.ok(
    list.versions.some(
      (version: { reason: string }) => version.reason === "Новый отчёт"
    )
  );
  const wrongCard = await call(project.id + "/versions/" + oldId, (request) =>
    openVersion(request, {
      params: Promise.resolve({ id: project.id, versionId: oldId }),
    })
  );
  assert.equal(wrongCard.status, 404);

  await setKnowledgeCardModeration(
    legacy.id,
    { status: "rejected" },
    next.updatedAt
  );
  assert.equal(
    (await call(oldHref, (request) => openVersion(request, selected))).status,
    404,
    "Withdrawing the card also withdraws public history access"
  );
  assert.equal(
    (await storedVersions(legacy.id)).length,
    2,
    "Withdrawing must not rewrite or erase history"
  );
});

test("duplicate baseline pins and operational metadata preserve the content version", async (context) => {
  await requireFixtureDatabase();
  const card = await legacyCard(context);
  const expected = getCardVersionId(card);
  const [one, two] = await Promise.all([
    ensureApprovedCardVersion(card),
    ensureApprovedCardVersion(card),
  ]);
  assert.equal(one.id, expected);
  assert.deepEqual(one, two);
  assert.equal(one.legacyBaseline, true);
  assert.equal((await storedVersions(card.id)).length, 1);
  const operationalUpdate = {
    ...card,
    ownerIds: ["qa-other-owner"],
    updatedAt: "2027-01-01T00:00:00.000Z",
    reviewComment: "Служебное примечание",
    freshness: { nextReviewAt: "2027-02-01", verifiedVersionId: expected },
  };
  assert.equal(getCardVersionId(operationalUpdate), expected);
});

test("freshness privileges and stale verification preserve the already approved contents", async (context) => {
  await requireFixtureDatabase();
  const card = await legacyCard(context);
  const { call } = await routeFixture();
  const { PATCH } =
    await import("../app/api/knowledge/cards/[id]/freshness/route");
  const handler = (request: Request) =>
    PATCH(request, { params: Promise.resolve({ id: card.id }) });
  const options = {
    method: "PATCH" as const,
    account: "demo-admin",
    expected: card.updatedAt,
  };
  const body = { action: "schedule", nextReviewAt: "2021-01-01" };
  const update = (input: typeof options & { body: unknown }) =>
    call(card.id + "/freshness", handler, input);
  assert.equal(
    (await update({ ...options, body, account: "demo-guest" })).status,
    403
  );
  assert.equal(
    (
      await update({
        ...options,
        body: { ...body, nextReviewAt: "2026-02-30" },
      })
    ).status,
    400
  );
  const schedule = await update({ ...options, body });
  assert.equal(schedule.status, 200);
  const scheduled: KnowledgeCard = await schedule.json();
  assert.equal(scheduled.freshness?.nextReviewAt, "2021-01-01");
  assert.equal(
    getPublicApprovedCard(scheduled)?.id,
    card.id,
    "A missed date does not revoke approval"
  );
  const versionId = getCardVersionId(card);
  const action = { action: "verify", versionId };
  assert.equal((await update({ ...options, body: action })).status, 409);
  assert.equal(
    (
      await update({
        ...options,
        expected: scheduled.updatedAt,
        body: { ...action, versionId: "cv-" + "0".repeat(64) },
      })
    ).status,
    409
  );
  const verified = await update({
    ...options,
    expected: scheduled.updatedAt,
    body: action,
  });
  assert.equal(verified.status, 200);
  const saved = await getKnowledgeCardById(card.id);
  assert.equal(saved?.freshness?.verifiedVersionId, versionId);
  assert.ok(saved?.freshness?.lastVerifiedAt);
  assert.equal(
    saved?.freshness?.nextReviewAt,
    undefined,
    "Completing the scheduled check closes its work item"
  );
  assert.equal(saved?.status, card.status);
});

test("an assigned staff member can verify the approved version without seeing or editing a private revision", async (context) => {
  await requireFixtureDatabase();
  const published = await legacyCard(context);
  const { call, account } = await routeFixture();
  const assignedProfile = "demo-pr-" + published.initiatorUniversityId;
  const assigned = account(assignedProfile);
  const card: ProjectCard = {
    ...published,
    status: "pending",
    title: "QA: закрытая редакция",
    updatedAt: "2026-11-22T21:00:00.000Z",
    freshness: {
      responsibleId: assigned.id,
      responsibleName: assigned.name,
      nextReviewAt: "2026-11-21",
    },
    approvedSnapshot: published,
  };
  await docClient.send(
    new PutCommand({ TableName: TableName.KNOWLEDGE_CARDS, Item: card })
  );
  const { PATCH } =
    await import("../app/api/knowledge/cards/[id]/freshness/route");
  const { GET } =
    await import("../app/api/knowledge/cards/[id]/versions/route");
  const params = { params: Promise.resolve({ id: card.id }) };
  const path = card.id + "/freshness";
  const handler = (request: Request) => PATCH(request, params);
  const verify = { action: "verify", versionId: getCardVersionId(published) };
  const option = {
    method: "PATCH" as const,
    account: assignedProfile,
    expected: card.updatedAt,
  };
  assert.equal(
    (
      await call(path, handler, {
        ...option,
        account: "demo-owner-" + published.initiatorUniversityId,
        body: verify,
      })
    ).status,
    403
  );
  assert.equal(
    (
      await call(path, handler, {
        ...option,
        body: { action: "schedule", nextReviewAt: null },
      })
    ).status,
    403
  );
  assert.equal(
    (
      await call(path, handler, {
        ...option,
        expected: published.updatedAt,
        body: verify,
      })
    ).status,
    409
  );
  assert.equal(
    (
      await call(path, handler, {
        ...option,
        expected: undefined,
        body: verify,
      })
    ).status,
    428
  );
  const capability = await call(
    card.id + "/versions",
    (request) => GET(request, params),
    { method: "GET", account: assignedProfile }
  );
  const history = await capability.json();
  assert.equal(history.canVerifyFreshness, true);
  assert.equal(history.responsibleId, undefined);
  assert.equal(history.publishedUpdatedAt, published.updatedAt);
  assert.equal(history.cardUpdatedAt, card.updatedAt);
  const verified = await call(path, handler, { ...option, body: verify });
  assert.equal(verified.status, 200);
  const visible = await verified.json();
  assert.equal(visible.title, published.title);
  assert.equal(visible.freshness.responsibleId, undefined);
  assert.equal(visible.freshness.nextReviewAt, undefined);
  const saved = await getKnowledgeCardById(card.id);
  assert.equal(saved?.title, card.title);
  assert.equal(saved?.status, "pending");
  assert.equal(saved?.freshness?.verifiedVersionId, verify.versionId);
});

test("a reviewer for a future unpublished participant cannot be assigned to the current public version", async (context) => {
  await requireFixtureDatabase();
  const published = await legacyCard(context);
  const { call, account } = await routeFixture();
  const futureUniversity = published.initiatorUniversityId === "midis" ? "csu" : "midis";
  const futureReviewer = account("demo-owner-" + futureUniversity);
  const pending: ProjectCard = { ...published, status: "pending", isJoint: true, folderId: "02_joint",
    participantUniversityIds: [published.initiatorUniversityId, futureUniversity], approvedSnapshot: published };
  await docClient.send(new PutCommand({ TableName: TableName.KNOWLEDGE_CARDS, Item: pending }));
  const { PATCH } = await import("../app/api/knowledge/cards/[id]/freshness/route");
  const handler = (request: Request) => PATCH(request, { params: Promise.resolve({ id: pending.id }) });
  const response = await call(pending.id + "/freshness", handler, { method: "PATCH", account: "demo-admin",
    expected: pending.updatedAt, body: { action: "schedule", responsibleId: futureReviewer.id, nextReviewAt: "2026-12-01" } });
  assert.equal(response.status, 400, "The plan is for the published scope, which the future participant cannot verify");
  const currentReviewer = account("demo-owner-" + published.initiatorUniversityId);
  assert.equal((await call(pending.id + "/freshness", handler, { method: "PATCH", account: "demo-admin",
    expected: pending.updatedAt, body: { action: "schedule", responsibleId: currentReviewer.id, nextReviewAt: "2026-12-01" } })).status, 200);
});

test("unknown project parameters remain pending and joint participants need no invented lead", async (context) => {
  await requireFixtureDatabase();
  const input = knowledgeCardInputSchema.parse({
    ...project,
    title: "QA: сведения требуют уточнения",
    readinessStage: "Не уточнено",
    contour: "не уточнён",
  });
  const pending = await createKnowledgeCard(input, { status: "approved" });
  removeFixtureCard(context, pending);
  assert.equal(pending.status, "pending");
  assert.equal(getPublicApprovedCard(pending), null);
  assert.equal((await storedVersions(pending.id)).length, 0);
  const { call } = await routeFixture();
  const { POST: approve } =
    await import("../app/api/knowledge/cards/[id]/moderation/route");
  const { GET: getHistory } =
    await import("../app/api/knowledge/cards/[id]/versions/route");
  const params = { params: Promise.resolve({ id: pending.id }) };
  const publicHistory = await call(pending.id + "/versions", (request) =>
    getHistory(request, params)
  );
  assert.equal(publicHistory.status, 404);
  const settle = await call(
    pending.id + "/moderation",
    (request) => approve(request, params),
    {
      method: "POST",
      account: "demo-admin",
      expected: pending.updatedAt,
      body: { action: "approve" },
    }
  );
  assert.equal(settle.status, 409);

  assert.equal(
    knowledgeCardInputSchema.safeParse({
      ...project,
      initiatorUniversityId: "",
    }).success,
    false
  );
  assert.equal(
    knowledgeCardInputSchema.safeParse({
      ...project,
      isJoint: true,
      initiatorUniversityId: "",
      participantUniversityIds: ["midis", "susu"],
    }).success,
    true
  );
});
