import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { NextRequest } from "next/server";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { POST as create } from "../app/api/knowledge/cards/route";
import { POST as createType } from "../app/api/knowledge/card-types/route";
import { PATCH as updateType } from "../app/api/knowledge/card-types/[id]/route";
import { PUT as update } from "../app/api/knowledge/cards/[id]/route";
import { POST as moderate } from "../app/api/knowledge/cards/[id]/moderation/route";
import { POST as requestEdit } from "../app/api/knowledge/cards/[id]/edit-requests/route";
import { canEditCard, getDemoAccount, toSessionUser, visibleKnowledgeCard } from "../lib/auth";
import { SESSION_COOKIE, signSessionToken } from "../lib/auth-server";
import { universities } from "../lib/data";
import { docClient, resetDbAvailableCache } from "../lib/db";
import { folderIds, getPublicApprovedCard, knowledgeSeedCards, type CardTypeDefinition, type KnowledgeCard, type ProjectCard, type UniversityCard } from "../lib/knowledge";
import { TableName } from "../lib/schema";
import { getCardVersionId } from "../lib/knowledge-versions";
import { buildWorkQueue } from "../lib/work-queue";

process.env.CAMPUS_PUBLIC_ORIGIN = "https://access-fixture.invalid";
process.env.DOCUMENT_API_ENDPOINT = "http://127.0.0.1:1";
process.env.CAMPUS_DEMO_LOGIN = "true";
process.env.CAMPUS_PILOT_ACCOUNTS = "";
process.env.CAMPUS_LOCAL_DEMO = "false";
process.env.USE_DATABASE = "true";
process.env.OUTPUT_MODE = "";
process.env.ADMIN_ACCESS_PIN = "";
process.env.SESSION_SECRET = "";
process.env.YANDEX_DISK_OAUTH_TOKEN = "";

const basePath = "/api/knowledge/cards";
const staff = (profile: string) => toSessionUser(getDemoAccount(profile)!);

type Action = (request: NextRequest, context: { params: Promise<{ id: string }> }) => Promise<Response>;
function call(handler: Action, method: string, path: string, profile: string, body: unknown, card?: { id: string; updatedAt: string }) {
  const headers = {
    "Content-Type": "application/json",
    origin: "https://access-fixture.invalid",
    cookie: `${SESSION_COOKIE}=${signSessionToken(profile)}`,
    ...(card ? { "If-Match": card.updatedAt } : {}),
  };
  const request = new NextRequest(`https://access-fixture.invalid${basePath}${path}`, {
    method, headers, body: JSON.stringify(body),
  });
  const store = createRequestStoreForAPI(
    request, request.nextUrl, { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined, undefined,
  );
  return workAsyncStorage.run({} as NonNullable<ReturnType<typeof workAsyncStorage.getStore>>, () =>
    workUnitAsyncStorage.run(store, () => handler(request, { params: Promise.resolve({ id: card?.id ?? path.split("/")[1] }) })));
}

function database(context: TestContext, initial: KnowledgeCard[] = [], types = new Map<string, CardTypeDefinition>()) {
  const cards = new Map(initial.map(card => [card.id, card]));
  function write(input: PutCommand["input"]) {
    if (input.TableName === TableName.KNOWLEDGE_CARDS) {
      const item = input.Item as KnowledgeCard;
      cards.set(item.id, item);
    }
    if (input.TableName === TableName.KNOWLEDGE_CARD_TYPES) {
      const definition = input.Item as CardTypeDefinition;
      types.set(definition.id, definition);
    }
  }
  resetDbAvailableCache();
  context.after(resetDbAvailableCache);
  context.mock.method(globalThis, "fetch", async () => assert.fail("The fixture must not contact any provider"));
  context.mock.method(docClient, "send", async (command: unknown) => {
    if (command instanceof ListTablesCommand) return { TableNames: [] };
    if (command instanceof GetCommand) {
      return { Item: command.input.TableName === TableName.KNOWLEDGE_CARDS ? cards.get(command.input.Key?.id)
        : command.input.TableName === TableName.KNOWLEDGE_CARD_TYPES ? types.get(command.input.Key?.id) : undefined };
    }
    if (command instanceof ScanCommand) {
      return { Items: command.input.TableName === TableName.KNOWLEDGE_CARDS ? [...cards.values()] : [] };
    }
    if (command instanceof UpdateCommand) {
      const card = cards.get(command.input.Key?.id);
      assert.ok(card);
      const updated = { ...card, diskSync: command.input.ExpressionAttributeValues?.[":diskSync"] };
      cards.set(card.id, updated);
      return { Attributes: updated };
    }
    if (command instanceof PutCommand) write(command.input);
    else if (command instanceof TransactWriteCommand) {
      for (const action of command.input.TransactItems ?? []) if (action.Put) write(action.Put);
    } else assert.fail(`Unexpected fixture DB command ${String(command)}`);
    return {};
  });
  return cards;
}

const passports = knowledgeSeedCards.filter((card): card is UniversityCard => card.type === "university");
const sourceJoint = knowledgeSeedCards.find((card): card is ProjectCard => card.type === "project" && card.isJoint)!;
const midisOwner = staff("demo-owner-midis");
const csuOwner = staff("demo-owner-csu");

test("PR from each of the seven universities sends a request for the published passport and cannot write it", async context => {
  assert.equal(passports.length, universities.length);
  const cards = database(context, passports.map(card => ({ ...card, ownerIds: [], status: "approved" })));
  for (const passport of passports) {
    const id = passport.id;
    const profile = `demo-pr-${passport.universityId}`;
    const edit = await call(update, "PUT", `/${id}`, profile, { ...passport, title: "Updated passport" }, passport);
    assert.equal(edit.status, 403, passport.universityId);
    const sent = await call(requestEdit, "POST", `/${id}/edit-requests`, profile, { message: "Please correct the wording." }, passport);
    assert.equal(sent.status, 201, passport.universityId);
    assert.equal(cards.get(id)?.title, passport.title);
    assert.equal(cards.get(id)?.editRequests?.length, 1);
  }
});

test("a joint draft is stored in the joint folder without automatic PR ownership or confirmation", async context => {
  const cards = database(context);
  const input = { ...sourceJoint, folderId: folderIds.subfolder("midis", "products"), initiatorUniversityId: "midis", participantUniversityIds: ["midis", "csu"], externalParticipantNames: [] };
  const created = await call(create, "POST", "", "demo-pr-midis", input);
  assert.equal(created.status, 201);
  const stored = cards.get((await created.json()).id)!;
  assert.equal(stored.folderId, folderIds.joint);
  assert.deepEqual(stored.ownerIds, []);
  assert.deepEqual(stored.participantApprovals, []);
});

test("only a designated joint owner can confirm a displayed revision", async context => {
  const joint: ProjectCard = {
    ...sourceJoint, id: "fixture-joint", folderId: folderIds.joint, status: "pending",
    initiatorUniversityId: "midis", participantUniversityIds: ["midis", "csu"], externalParticipantNames: [],
    ownerIds: [midisOwner.id, csuOwner.id], participantApprovals: [],
  };
  const cards = database(context, [joint]);
  const path = `/${joint.id}/moderation`;
  const action = { action: "confirm-participation" };
  assert.equal((await call(moderate, "POST", path, "demo-pr-midis", action, joint)).status, 403);
  assert.equal((await call(moderate, "POST", path, "demo-owner-midis", action)).status, 428);
  assert.equal((await call(moderate, "POST", path, "demo-owner-midis", action, joint)).status, 200);
  assert.equal((await call(moderate, "POST", path, "demo-owner-csu", action, joint)).status, 409);
  assert.deepEqual(cards.get(joint.id)?.participantApprovals, ["midis"]);
});

test("old unbound confirmations cannot publish a joint project; all responsible parties can confirm it", async context => {
  const joint: ProjectCard = {
    ...sourceJoint, id: "fixture-joint-legacy", folderId: folderIds.joint, status: "pending",
    initiatorUniversityId: "midis", participantUniversityIds: ["midis", "csu"], externalParticipantNames: [],
    ownerIds: [midisOwner.id, csuOwner.id], participantApprovals: ["midis", "csu"],
  };
  const cards = database(context, [joint]);
  const path = `/${joint.id}/moderation`;
  const action = { action: "approve" };
  const rejected = await call(moderate, "POST", path, "demo-admin", action, joint);
  assert.equal(rejected.status, 409);
  assert.deepEqual((await rejected.json()).missingUniversityIds, ["midis", "csu"]);
  for (const [profile, type] of [
    ["demo-rio", "confirm-stakeholder"],
    ["demo-owner-midis", "confirm-participation"],
    ["demo-owner-csu", "confirm-participation"],
  ]) {
    const response = await call(moderate, "POST", path, profile, { action: type }, cards.get(joint.id));
    assert.equal(response.status, 200, profile);
  }
  assert.equal((await call(moderate, "POST", path, "demo-admin", action, cards.get(joint.id))).status, 200);
  assert.equal(getPublicApprovedCard(cards.get(joint.id)!)?.id, joint.id);
});

test("campus passport publication requires scoped ministry, RION and CHKK decisions", async context => {
  const passport = { ...knowledgeSeedCards.find(card => card.type === "campus")!, status: "pending" as const };
  const cards = database(context, [passport]);
  const path = `/${passport.id}/moderation`;
  const approve = { action: "approve" };
  const confirm = { action: "confirm-stakeholder" };
  assert.equal((await call(moderate, "POST", path, "demo-pr-csu", confirm, passport)).status, 403);
  assert.equal((await call(moderate, "POST", path, "demo-admin", approve, passport)).status, 409);
  for (const profile of ["demo-ministry", "demo-rio", "demo-chkk"]) {
    const current = cards.get(passport.id)!;
    const response = await call(moderate, "POST", path, profile, confirm, current);
    assert.equal(response.status, 200, profile);
    assert.equal(cards.get(passport.id)?.status, "pending");
  }
  const published = await call(moderate, "POST", path, "demo-admin", approve, cards.get(passport.id));
  assert.equal(published.status, 200);
  assert.equal(cards.get(passport.id)?.status, "approved");
  assert.deepEqual(Object.keys(cards.get(passport.id)?.stakeholderApprovals ?? {}).sort(), ["chkk", "ministry", "rio"]);
});

test("a campus revision keeps the published baseline and requires fresh confirmations after a content edit", async context => {
  const passport = { ...knowledgeSeedCards.find(card => card.type === "campus")!, status: "approved" as const, ownerIds: [] };
  const cards = database(context, [passport]);
  const path = `/${passport.id}`;
  const first = await call(update, "PUT", path, "demo-admin", { ...passport, title: "First draft" }, passport);
  assert.equal(first.status, 200);
  const firstDraft = cards.get(passport.id)!;
  assert.equal(firstDraft.status, "pending");
  assert.equal(getPublicApprovedCard(firstDraft)?.title, passport.title);
  assert.equal((await call(moderate, "POST", `${path}/moderation`, "demo-ministry",
    { action: "confirm-stakeholder" }, firstDraft)).status, 200);
  const confirmed = cards.get(passport.id)!;
  assert.ok(confirmed.stakeholderApprovals?.ministry);
  assert.equal((await call(update, "PUT", path, "demo-admin", { ...confirmed, title: "Second draft" }, confirmed)).status, 200);
  const secondDraft = cards.get(passport.id)!;
  assert.equal(getPublicApprovedCard(secondDraft)?.title, passport.title);
  assert.deepEqual(secondDraft.stakeholderApprovals, {});
  assert.equal((await call(moderate, "POST", `${path}/moderation`, "demo-ministry",
    { action: "confirm-stakeholder" }, confirmed)).status, 409);
});

test("RION cannot create an ordinary lab in a resident's folder", async context => {
  database(context);
  const lab = knowledgeSeedCards.find(card => card.type === "laboratory")!;
  const response = await call(create, "POST", "", "demo-rio", {
    ...lab, folderId: folderIds.subfolder("midis", "infrastructure"),
  });
  assert.equal(response.status, 403);
});

test("RION and CHKK can send their own scoped cards for review", async context => {
  const cards = database(context);
  const rio = await call(create, "POST", "", "demo-rio", {
    ...sourceJoint, isJoint: false, initiatorUniversityId: "", participantUniversityIds: [],
    externalParticipantNames: [], folderId: folderIds.rioProjects,
  });
  assert.equal(rio.status, 201);
  const project = cards.get((await rio.json()).id)!;
  assert.equal(project.organizationScope, "rio");
  assert.equal(project.folderId, folderIds.rioProjects);
  assert.deepEqual(project.ownerIds, [staff("demo-rio").id]);
  assert.equal(project.status, "pending");
  const lab = knowledgeSeedCards.find(card => card.type === "laboratory")!;
  const chkk = await call(create, "POST", "", "demo-chkk", { ...lab, folderId: folderIds.campus });
  assert.equal(chkk.status, 201);
  const facility = cards.get((await chkk.json()).id)!;
  assert.equal(facility.organizationScope, "chkk");
  assert.equal(facility.folderId, folderIds.campus);
  assert.deepEqual(facility.ownerIds, [staff("demo-chkk").id]);
  assert.equal(facility.status, "pending");
});

test("an unassigned approved card sends a request to the coordinator and keeps the published card", async context => {
  const passport: UniversityCard = { ...passports[0], status: "approved", ownerIds: [] };
  const cards = database(context, [passport]);
  const response = await call(requestEdit, "POST", `/${passport.id}/edit-requests`, "demo-ministry",
    { message: "Please correct the wording." }, passport);
  assert.equal(response.status, 201);
  const stored = cards.get(passport.id)!;
  assert.equal(stored.status, "approved");
  const queue = buildWorkQueue(staff("demo-admin"), { cards: [stored], documents: [], requests: [], workflows: [], readiness: {} });
  const item = queue.find(item => item.kind === "card-request");
  assert.ok(item);
  assert.equal(item.responsibleName, staff("demo-admin").name);
});

test("a departing university PR can comment on the visible joint publication but cannot change the draft", async context => {
  const published: ProjectCard = {
    ...sourceJoint, folderId: folderIds.joint, status: "approved",
    initiatorUniversityId: "midis", participantUniversityIds: ["midis", "csu"],
  };
  const pending: ProjectCard = {
    ...published, status: "pending", participantUniversityIds: ["midis", "susu"],
    title: "Private revision", approvedSnapshot: published,
  };
  database(context, [pending]);
  const path = `/${pending.id}`;
  const request = await call(requestEdit, "POST", `${path}/edit-requests`, "demo-pr-csu", {
    message: "Clarify the facts of the approved project.",
  });
  assert.equal(request.status, 201);
  assert.equal((await request.json()).title, published.title);
  assert.equal((await call(update, "PUT", path, "demo-pr-csu", pending, pending)).status, 403);
});

test("only the coordinator can enable an immutable construction type for CHKK", async context => {
  const catalog = new Map<string, CardTypeDefinition>();
  const cards = database(context, [], catalog);
  const input = {
    name: "Очередь УНК", organizationScope: "chkk",
    fields: [{ id: "value", name: "Номер очереди", type: "number", required: true, options: [] }],
  };
  assert.equal((await call(createType, "POST", "", "demo-chkk", input)).status, 403);
  const createDefinition = await call(createType, "POST", "", "demo-admin", input);
  assert.equal(createDefinition.status, 201);
  const definition = await createDefinition.json();
  assert.equal(definition.organizationScope, "chkk");
  const generalDefinition = await (await call(createType, "POST", "", "demo-admin", {
    name: "Обычный тип", fields: input.fields,
  })).json();
  assert.ok([400, 409].includes((await call(updateType, "PATCH", `/${generalDefinition.id}`, "demo-admin", {
    name: "Попытка смены доступа", organizationScope: "chkk",
  }, generalDefinition)).status));

  const proposed = {
    type: "custom", customTypeId: definition.id,
    title: "Очередь 2", owners: ["ООО «ЧКК»"], referenceDescription: "Вторая очередь УНК",
    stopFormula: "", customFields: { value: 2 },
  };
  assert.equal((await call(create, "POST", "", "demo-pr-csu", proposed)).status, 403);
  assert.equal((await call(create, "POST", "", "demo-chkk", { ...proposed, customTypeId: generalDefinition.id })).status, 403);
  const response = await call(create, "POST", "", "demo-chkk", proposed);
  assert.equal(response.status, 201);
  const card = cards.get((await response.json()).id)!;
  assert.equal(card.type, "custom");
  assert.equal(card.organizationScope, "chkk");
  assert.equal(card.folderId, "00_campus/construction");
  assert.deepEqual(card.ownerIds, [staff("demo-chkk").id]);
  assert.equal(card.status, "pending");
});

test("a legacy custom draft remains editable by its own university submitter", async context => {
  const type: CardTypeDefinition = {
    id: "legacy-type", name: "Legacy type", description: "", fields: [],
    createdAt: sourceJoint.createdAt, updatedAt: sourceJoint.updatedAt,
  };
  const draft: KnowledgeCard = {
    id: "legacy-custom", type: "custom", customTypeId: type.id, customFields: {},
    status: "pending", title: "Legacy draft", folderId: folderIds.subfolder("csu", "products"),
    submittedBy: csuOwner.id, owners: ["Подпись прежней формы"], referenceDescription: "", stopFormula: "",
    createdAt: sourceJoint.createdAt, updatedAt: sourceJoint.updatedAt,
  };
  const cards = database(context, [draft], new Map([[type.id, type]]));
  assert.equal(canEditCard(csuOwner, draft), true);
  assert.equal(canEditCard(csuOwner, { ...draft, universityId: "midis" }), false);
  assert.equal(canEditCard(csuOwner, { ...draft, folderId: folderIds.subfolder("midis", "products") }), false);
  assert.equal(canEditCard(csuOwner, { ...draft, folderId: "01_universities/csu/invalid" }), false);
  assert.equal(canEditCard(csuOwner, { ...draft, ownerIds: [midisOwner.id] }), false);
  assert.equal((await call(update, "PUT", `/${draft.id}`, "demo-owner-csu", { ...draft, title: "Reviewed draft" }, draft)).status, 200);
  assert.equal(cards.get(draft.id)?.folderId, draft.folderId);
  assert.equal(canEditCard(csuOwner, cards.get(draft.id)!), true);
});

test("legacy shared laboratories keep both designated approvals through edits and publication", async context => {
  const source = knowledgeSeedCards.find((card) => card.type === "laboratory")!;
  const required = ["suspgu", "susmu"];
  const bothOwners = [staff("demo-owner-suspgu"), staff("demo-owner-susmu")];
  const shared = {
    ...source, id: "legacy-shared-lab", folderId: folderIds.subfolder("suspgu", "infrastructure"),
    status: "pending" as const, placementStatus: "active" as const, requiredApprovalUniversityIds: required, ownerIds: [],
  };
  const ordinary = { ...shared, id: "ordinary-lab", requiredApprovalUniversityIds: undefined };
  const legacyPublished = { ...shared, id: "legacy-published-lab", status: "approved" as const };
  const cards = database(context, [shared, ordinary, legacyPublished]);
  const updatePath = `/${shared.id}`;
  const moderationPath = `${updatePath}/moderation`;
  const confirm = { action: "confirm-participation" };
  assert.equal((await call(moderate, "POST", moderationPath, "demo-owner-susmu", confirm, shared)).status, 403);
  assert.equal((await call(update, "PUT", `/${ordinary.id}`, "demo-admin", {
    ...ordinary, ownerIds: [bothOwners[1].id], requiredApprovalUniversityIds: required,
  }, ordinary)).status, 400);
  assert.equal((await call(update, "PUT", updatePath, "demo-admin", {
    ...shared, ownerIds: [csuOwner.id],
  }, shared)).status, 400);
  assert.equal((await call(update, "PUT", `/${legacyPublished.id}`, "demo-admin", {
    ...legacyPublished, ownerIds: bothOwners.map(owner => owner.id),
  }, legacyPublished)).status, 200);
  assert.deepEqual(cards.get(legacyPublished.id)?.requiredApprovalUniversityIds, required);
  assert.equal((await call(update, "PUT", updatePath, "demo-admin", {
    ...shared, ownerIds: bothOwners.map(owner => owner.id),
    requiredApprovalUniversityIds: ["csu"],
  }, shared)).status, 200);

  const assigned = cards.get(shared.id)!;
  assert.deepEqual(assigned.requiredApprovalUniversityIds, required);
  assert.equal((await call(moderate, "POST", moderationPath, "demo-pr-suspgu", confirm, assigned)).status, 403);
  assert.equal((await call(moderate, "POST", moderationPath, "demo-owner-csu", confirm, assigned)).status, 403);
  assert.equal((await call(moderate, "POST", moderationPath, "demo-owner-suspgu", confirm, assigned)).status, 200);
  assert.equal((await call(moderate, "POST", moderationPath, "demo-owner-susmu", confirm, assigned)).status, 409);
  const oneDecision = cards.get(shared.id)!;
  assert.equal((await call(moderate, "POST", moderationPath, "demo-admin", { action: "approve" }, oneDecision)).status, 409);
  assert.equal((await call(moderate, "POST", moderationPath, "demo-owner-susmu", confirm, oneDecision)).status, 200);
  const twoDecisions = cards.get(shared.id)!;
  assert.equal(twoDecisions.participantApprovalRecords?.suspgu.actorId, bothOwners[0].id);
  assert.equal(twoDecisions.participantApprovalRecords?.susmu.actorId, bothOwners[1].id);
  assert.equal((await call(moderate, "POST", moderationPath, "demo-admin", { action: "approve" }, twoDecisions)).status, 200);

  const published = cards.get(shared.id)!;
  assert.equal(published.status, "approved");
  assert.deepEqual(published.requiredApprovalUniversityIds, required);
  assert.equal((await call(update, "PUT", updatePath, "demo-owner-susmu", {
    ...published, title: "Future shared laboratory revision",
  }, published)).status, 200);
  const revised = cards.get(shared.id)!;
  assert.equal(revised.status, "pending");
  assert.deepEqual(revised.requiredApprovalUniversityIds, required);
  assert.deepEqual(revised.participantApprovalRecords, {});
  assert.equal(getPublicApprovedCard(revised)?.title, published.title);
});

test("both university PR teams can request edits to their published shared laboratory", async context => {
  const source = knowledgeSeedCards.find(card => card.type === "laboratory")!;
  const shared: KnowledgeCard = {
    ...source, id: "shared-lab-pr-requests", folderId: folderIds.subfolder("suspgu", "infrastructure"),
    status: "approved", placementStatus: "active", requiredApprovalUniversityIds: ["suspgu", "susmu"], ownerIds: [],
  };
  const cards = database(context, [shared]);
  const endpoint = `/${shared.id}/edit-requests`;
  const body = { message: "Уточните утверждённые сведения нашей совместной лаборатории." };
  for (const profile of ["demo-pr-suspgu", "demo-pr-susmu"]) {
    assert.equal((await call(requestEdit, "POST", endpoint, profile, body)).status, 201, profile);
    const view: KnowledgeCard = visibleKnowledgeCard(staff(profile), cards.get(shared.id)!)!;
    assert.deepEqual(view.requiredApprovalUniversityIds, shared.requiredApprovalUniversityIds);
    assert.deepEqual(view.ownerIds, []);
  }
  assert.equal((await call(requestEdit, "POST", endpoint, "demo-pr-csu", body)).status, 403);
  assert.deepEqual(getPublicApprovedCard(shared)?.requiredApprovalUniversityIds, shared.requiredApprovalUniversityIds);
  assert.equal(visibleKnowledgeCard(null, shared)?.ownerIds, undefined);
  assert.equal(getCardVersionId(shared), getCardVersionId({ ...shared, requiredApprovalUniversityIds: undefined }), "Governance metadata must preserve existing historical version IDs");
  const published = cards.get(shared.id)!;
  const pending = { ...published, status: "pending" as const, title: "Неопубликованная правка", approvedSnapshot: published };
  cards.set(shared.id, pending);
  const response = await call(requestEdit, "POST", endpoint, "demo-pr-susmu", body);
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.title, published.title);
  assert.deepEqual(result.requiredApprovalUniversityIds, shared.requiredApprovalUniversityIds);
});

test("a shared university laboratory cannot be reassigned to incompatible CHKK scope", async context => {
  const source = knowledgeSeedCards.find(card => card.type === "laboratory")!;
  const shared = {
    ...source, id: "shared-lab-scope-guard", folderId: folderIds.subfolder("suspgu", "infrastructure"),
    status: "pending" as const, requiredApprovalUniversityIds: ["suspgu", "susmu"], ownerIds: [],
  };
  const cards = database(context, [shared]);
  const response = await call(update, "PUT", `/${shared.id}`, "demo-admin", { ...shared, organizationScope: "chkk" }, shared);
  assert.equal(response.status, 409);
  assert.equal(cards.get(shared.id)?.organizationScope, undefined);
  assert.equal(cards.get(shared.id)?.folderId, shared.folderId);
});
