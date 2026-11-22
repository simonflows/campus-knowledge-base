import assert from "node:assert/strict";
import { test } from "node:test";
import { knowledgeCardInputSchema } from "../lib/validation/knowledge";
import { cardContent, isCardReadyForPublication, knowledgeSeedCards, type KnowledgeCard } from "../lib/knowledge";
import { knowledgeUpdateModeration } from "../lib/knowledge-lifecycle";

test("an external university co-author can be recorded without inventing a resident initiator or approval", () => {
  const seed = knowledgeSeedCards.find(card => card.type === "project")!;
  const parsed = knowledgeCardInputSchema.safeParse({ ...seed, folderId: "02_joint", isJoint: true, initiatorUniversityId: "", participantUniversityIds: ["susu"], externalParticipantNames: ["МГТУ имени Н. Э. Баумана"], readinessStage: "Не уточнено", contour: "не уточнён" });
  assert.equal(parsed.success, true, "a truthful incomplete external joint project must remain a valid draft");
  if (!parsed.success) return;
  const card = { ...parsed.data, id: "external-joint", createdAt: "2026-11-22T00:00:00Z", updatedAt: "2026-11-22T00:00:00Z", status: "pending" } as KnowledgeCard;
  assert.equal(isCardReadyForPublication(card), false);
  const content = cardContent(card);
  assert.equal(content.type, "project");
  if (content.type === "project") assert.deepEqual(content.externalParticipantNames, ["МГТУ имени Н. Э. Баумана"]);
  assert.equal(isCardReadyForPublication({ ...card, readinessStage: "Испытания", contour: "собственный проект вуза" } as KnowledgeCard), false, "public sources do not fabricate an external participant's approval");
});

test("editing a laboratory with two required university approvals invalidates both decisions", () => {
  const seed = knowledgeSeedCards.find(card => card.type === "laboratory")!;
  const current = { ...seed, status: "approved" as const, requiredApprovalUniversityIds: ["suspgu", "susmu"], participantApprovals: ["suspgu", "susmu"] } as KnowledgeCard;
  const input = knowledgeCardInputSchema.parse({ ...current, referenceDescription: current.referenceDescription + " Уточнение состава." });
  const patch = knowledgeUpdateModeration(current, input, { id: "coordinator", name: "Координатор", isAdmin: true });
  assert.equal(patch.status, "pending");
  assert.deepEqual(patch.participantApprovals, []);
  assert.deepEqual(patch.requiredApprovalUniversityIds, ["suspgu", "susmu"]);
});
