import assert from "node:assert/strict";
import { test } from "node:test";
import { getDemoAccount, missingJointOwnerUniversityIds, toSessionUser } from "../lib/auth";
import { knowledgeUpdateModeration } from "../lib/knowledge-lifecycle";
import { getCardVersionId } from "../lib/knowledge-versions";
import { folderIds, getApprovedVersion, getRequiredStakeholderApprovals, getRequiredUniversityApprovals, type LaboratoryCard, type ProjectCard } from "../lib/knowledge";
import { knowledgeCardInputSchema } from "../lib/validation/knowledge";

const createdAt = "2026-11-20T09:00:00.000Z";
const base = {
  id: "synthetic-workflow-card", title: "Синтетическая карточка для проверки согласования",
  owners: ["Ответственный в тестовом сценарии"],
  referenceDescription: "Проверяемый синтетический пример для согласования.",
  stopFormula: "Использовать после согласования.", createdAt, updatedAt: createdAt,
};
const project: ProjectCard = {
  ...base, type: "project", folderId: folderIds.subfolder("midis", "products"),
  sphere: "Образование", initiatorUniversityId: "midis", coExecutors: [],
  industrialPartner: "Не указан", readinessStage: "Прототип", contour: "кампус",
  confirmedFigures: [], isJoint: false, participantUniversityIds: ["midis"],
};
const lab: LaboratoryCard = {
  ...base, type: "laboratory", folderId: folderIds.subfolder("midis", "infrastructure"),
  affiliation: "Тестовый вуз", partner: "Тестовый партнёр", head: "Тестовый руководитель",
  placementStatus: "planned", placementDetails: "Планируется в УНК",
  workDirections: [], equipment: [], confirmedIndicators: [],
};
const admin = { id: "fixture-coordinator", name: "Координатор", isAdmin: true };
const decision = (revisionId: string, actorId: string) => ({ revisionId, actorId, at: createdAt });

test("a joint project includes each resident university once", () => {
  const result = knowledgeCardInputSchema.safeParse({ ...project, isJoint: true, participantUniversityIds: ["midis", "susu", "midis"] });
  assert.equal(result.success, false);
  assert.deepEqual(result.error?.issues[0]?.path, ["participantUniversityIds"]);
});

test("a non-joint project accepts its initiator as the only listed resident university", () => {
  assert.ok(knowledgeCardInputSchema.safeParse(project).success);
  assert.ok(knowledgeCardInputSchema.safeParse({ ...project, participantUniversityIds: [] }).success);
  const result = knowledgeCardInputSchema.safeParse({ ...project, participantUniversityIds: ["midis", "susu"] });
  assert.equal(result.success, false);
  assert.deepEqual(result.error?.issues[0]?.path, ["participantUniversityIds"]);
});

test("changing an approved joint project's contour retains the published baseline and clears decisions", () => {
  const previous: ProjectCard = {
    ...project, folderId: folderIds.joint, isJoint: true, participantUniversityIds: ["midis", "susu"],
    status: "approved", ownerIds: ["demo-owner-midis", "demo-owner-susu"],
  };
  const version = getCardVersionId(previous);
  previous.stakeholderApprovals = { rio: decision(version, "demo-rio") };
  previous.participantApprovalRecords = {
    midis: decision(version, "demo-owner-midis"), susu: decision(version, "demo-owner-susu"),
  };
  const revision = { ...previous, contour: "собственный проект вуза" as const };
  const updated = { ...revision, ...knowledgeUpdateModeration(previous, knowledgeCardInputSchema.parse(revision), admin) };
  assert.equal(updated.contour, "собственный проект вуза");
  assert.equal(getApprovedVersion(updated)?.id, previous.id);
  assert.equal(getCardVersionId(updated), version);
  assert.deepEqual(getRequiredStakeholderApprovals(updated), ["rio"]);
  assert.deepEqual(getRequiredUniversityApprovals(updated), ["midis", "susu"]);
  assert.deepEqual(updated.stakeholderApprovals, {});
  assert.deepEqual(updated.participantApprovalRecords, {});
  assert.notEqual(getCardVersionId({ ...updated, approvedSnapshot: undefined }), version);
});

test("moving a laboratory to or from the campus building requires CHKK on the current revision", () => {
  for (const previousPlacement of ["active", "planned"] as const) {
    const previous: LaboratoryCard = { ...lab, placementStatus: previousPlacement, status: "approved" };
    previous.stakeholderApprovals = { chkk: decision(getCardVersionId(previous), "demo-chkk") };
    const revision = { ...previous, placementStatus: previousPlacement === "planned" ? "active" as const : "planned" as const };
    const updated = { ...revision, ...knowledgeUpdateModeration(previous, knowledgeCardInputSchema.parse(revision), admin) };
    assert.equal(updated.status, "pending");
    assert.equal(getCardVersionId(updated), getCardVersionId(previous));
    assert.deepEqual(getRequiredStakeholderApprovals(updated), ["chkk"]);
    assert.deepEqual(updated.stakeholderApprovals, {});
  }
});

test("changing the assigned owner on a pending joint project resets previous decisions", () => {
  const previous: ProjectCard = {
    ...project, folderId: folderIds.joint, isJoint: true, participantUniversityIds: ["midis", "susu"],
    status: "pending", ownerIds: ["demo-owner-midis", "demo-owner-susu"],
  };
  const version = getCardVersionId(previous);
  previous.participantApprovalRecords = { midis: decision(version, "demo-owner-midis") };
  previous.stakeholderApprovals = { rio: decision(version, "demo-rio") };
  const revision = { ...previous, ownerIds: ["demo-owner-susu"] };
  const updated = { ...revision, ...knowledgeUpdateModeration(previous, knowledgeCardInputSchema.parse(revision), admin) };
  assert.equal(updated.status, "pending");
  assert.deepEqual(updated.participantApprovalRecords, {});
  assert.deepEqual(updated.stakeholderApprovals, {});
  const directory = ["demo-owner-midis", "demo-owner-susu"].map(id => toSessionUser(getDemoAccount(id)!));
  assert.deepEqual(missingJointOwnerUniversityIds(updated, directory), ["midis"]);
});
