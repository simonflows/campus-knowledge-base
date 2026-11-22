import assert from "node:assert/strict";
import { test } from "node:test";
import { demoAccounts, type SessionUser } from "../lib/auth";
import { knowledgeSeedCards, type KnowledgeCard } from "../lib/knowledge";
import { editorialContentSchema, type EditorialDocument } from "../lib/editorial";
import { buildWorkQueue, buildUniversityCoverage } from "../lib/work-queue";

const owner = demoAccounts.find(user => user.id === "demo-owner-susu")! as SessionUser;
const foreign = demoAccounts.find(user => user.id === "demo-owner-midis")! as SessionUser;
const admin = demoAccounts.find(user => user.id === "demo-admin")! as SessionUser;
const project = knowledgeSeedCards.find(card => card.type === "project" && card.initiatorUniversityId === "susu")!;
function draft(): EditorialDocument {
  return { id: "document-one", ownerId: owner.id, ownerName: owner.name, originalId: "document-one", channel: "Сайт", version: 1,
    revisionId: "revision-one", submittedRevisionId: null, approvedRevisionId: null, status: "returned",
    content: editorialContentSchema.parse({ title: "Материал", sourceCardIds: [project.id] }),
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-22T00:00:00Z", events: [],
  };
}
const base = { cards: [] as KnowledgeCard[], documents: [] as EditorialDocument[], requests: [], workflows: [], readiness: {}, now: "2026-11-22T12:00:00Z" };

test("explicit overdue card verification becomes one task for its owner, without changing approval", () => {
  const card: KnowledgeCard = { ...project, ownerIds: [owner.id], freshness: { responsibleId: owner.id, responsibleName: owner.name, nextReviewAt: "2026-11-21" } };
  const queue = buildWorkQueue(owner, { ...base, cards: [card] });
  assert.equal(queue.filter(row => row.kind === "freshness").length, 1);
  assert.equal(queue[0].dueDate, "2026-11-21");
  assert.equal(queue[0].responsibleId, owner.id);
  assert.equal(card.status ?? "approved", "approved");
  assert.equal(buildWorkQueue(foreign, { ...base, cards: [card] }).length, 0);
  assert.equal(buildWorkQueue(owner, { ...base, cards: [{ ...card, freshness: undefined }] }).length, 0, "no invented default interval");
});

test("the UTC deadline day is inclusive even if the instant arrives with an offset", () => {
  const card: KnowledgeCard = { ...project, ownerIds: [owner.id], freshness: { nextReviewAt: "2026-11-21" } };
  const beforeMidnight = "2026-11-22T00:30:00+02:00";
  assert.equal(buildWorkQueue(owner, { ...base, cards: [card], now: beforeMidnight }).length, 0);
  assert.equal(buildWorkQueue(owner, { ...base, cards: [card], now: "2026-11-22T00:00:00Z" }).length, 1);
});

test("an assigned non-owner sees a due task for the published title while the private revision stays hidden", () => {
  const published: KnowledgeCard = { ...project, status: "approved", ownerIds: [] };
  const card: KnowledgeCard = {
    ...published, status: "pending", title: "Закрытая редакция", approvedSnapshot: published,
    freshness: { responsibleId: owner.id, responsibleName: owner.name, nextReviewAt: "2026-11-21" },
  };
  const queue = buildWorkQueue(owner, { ...base, cards: [card] });
  assert.deepEqual(queue.map(row => [row.kind, row.title]), [["freshness", published.title]]);
});

test("returned material and changed sources are visible only within existing editorial access", () => {
  const document = draft();
  const data = { ...base, documents: [document], readiness: { [document.id]: { changedSources: [
    { cardId: project.id, usedVersionId: "old", currentVersionId: "new" },
    { cardId: project.id, usedVersionId: "old", currentVersionId: "new" },
  ], unknownSources: [] } } };
  const queue = buildWorkQueue(owner, data);
  assert.equal(queue.filter(row => row.kind === "article-return").length, 1);
  assert.equal(queue.filter(row => row.kind === "source-change").length, 1, "a repeated source event cannot create duplicate work");
  assert.equal(buildWorkQueue(foreign, data).length, 0);
  const reviewed = buildWorkQueue(owner, { ...data, readiness: { [document.id]: { changedSources: [], unknownSources: [] } } });
  assert.equal(reviewed.filter(row => row.kind === "source-change").length, 0, "a review using the new version closes the derived task");
});

test("coordinator coverage explains required gaps without treating optional partner or review deadline as errors", () => {
  const passport = knowledgeSeedCards.find(card => card.type === "university" && card.universityId === "susu")!;
  const complete = { ...passport, owners: [owner.name], referenceDescription: "Официальный паспорт. Источник: https://example.org/report", freshness: { responsibleId: owner.id, lastVerifiedAt: "2026-11-21T00:00:00Z" } } as KnowledgeCard;
  const coverage = buildUniversityCoverage(admin, [complete], "2026-11-22T00:00:00Z");
  const susu = coverage.find(row => row.universityId === "susu")!;
  assert.equal(susu.cards, 1);
  assert.deepEqual(susu.gaps, []);
  const missing = buildUniversityCoverage(admin, [{ ...complete, owners: [], referenceDescription: "Паспорт без источника", freshness: undefined }], "2026-11-22T00:00:00Z").find(row => row.universityId === "susu")!;
  assert.ok(missing.gaps.some(gap => gap.reason.includes("источник")));
  assert.ok(missing.gaps.some(gap => gap.reason.includes("ответствен")));
  assert.throws(() => buildUniversityCoverage(foreign, [complete]), /координатор/i);
});
