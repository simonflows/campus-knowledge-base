import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { requireFixtureDatabase } from "./qa-fixture";
import { installPilotFixture } from "./pilot-fixture";
import { createEditorial, mutateEditorial } from "../lib/editorial-models";
import { createEditorialSchema } from "../lib/editorial";
import { createKnowledgeCard } from "../lib/models";
import { docClient } from "../lib/db";
import { TableName } from "../lib/schema";
import { updateEditorialReadiness } from "../lib/editorial-readiness";
import { knowledgeCardInputSchema } from "../lib/validation/knowledge";
import { knowledgeSeedCards } from "../lib/knowledge";
import { getCardVersionId } from "../lib/knowledge-versions";
import { findCardUsage } from "../lib/card-usage";

test("where-used returns accessible materials and publications without disclosing another private draft", async () => {
  await requireFixtureDatabase(); const people = installPilotFixture();
  const author = people.account("demo-pr-susu"), outsider = people.account("demo-pr-midis"), coordinator = people.account("demo-admin");
  const seed = knowledgeSeedCards.find(card => card.type === "project" && !card.isJoint)!;
  const card = await createKnowledgeCard(knowledgeCardInputSchema.parse({ ...seed, title: "QA источник " + randomUUID() }), { status: "approved" });
  const content = { title: "Материал с источником", lead: "В материале используется официальная карточка.", universityId: author.universityId,
    sections: [{ id: "context", heading: "Основание", level: 2 as const, chunks: [{ id: "body", content: "При подготовке материала используется утверждённый источник из справочника." }] }],
    sourceCardIds: [card.id], sourceCardTitles: [card.title], sourceVersions: [{ cardId: card.id, versionId: getCardVersionId(card) }] };
  const own = await createEditorial(author, createEditorialSchema.parse({ content }));
  const privateOther = await createEditorial(outsider, createEditorialSchema.parse({ content: { ...content, universityId: outsider.universityId, title: "Чужой личный черновик" } }));
  const usage = await findCardUsage(author, card.id);
  assert.ok(usage.some(row => row.id === own.id));
  assert.ok(!usage.some(row => row.id === privateOther.id));
  assert.ok(!(await findCardUsage(coordinator, card.id)).some(row => row.id === privateOther.id), "coordinator has no blanket access to unsent private drafts");
  const submitted = await mutateEditorial(own.id, author, { action: "submit", version: own.version, revisionId: own.revisionId, comment: "На проверку" });
  await mutateEditorial(own.id, coordinator, { action: "approve", version: submitted.document.version, revisionId: submitted.document.revisionId, comment: "Согласована тестовая редакция" });
  const published = await findCardUsage(outsider, card.id);
  assert.ok(published.some(row => row.kind === "publication" && row.versionId === getCardVersionId(card)), "a published article is discoverable by its exact source version");

  const variant = await createEditorial(author, createEditorialSchema.parse({ content, originalId: own.id, channel: "Сайт вуза" }));
  const sentVariant = await mutateEditorial(variant.id, author, { action: "submit", version: variant.version, revisionId: variant.revisionId, comment: "Вариант" });
  const approvedVariant = (await mutateEditorial(variant.id, coordinator, { action: "approve", version: sentVariant.document.version, revisionId: sentVariant.document.revisionId, comment: "Проверен" })).document;
  const authorRows = (await findCardUsage(author, card.id)).filter(row => row.id === variant.id);
  assert.equal(authorRows.length, 1, "an approved variant is one material, not a draft and a duplicate publication");

  const changedCard = { ...card, title: card.title + " — новая версия", updatedAt: new Date().toISOString() };
  await docClient.send(new PutCommand({ TableName: TableName.KNOWLEDGE_CARDS, Item: changedCard }));
  const nextVersion = getCardVersionId(changedCard);
  assert.equal((await findCardUsage(outsider, card.id)).find(row => row.id === variant.id)?.needsReview, true);
  const match = { version: approvedVariant.version, revisionId: approvedVariant.revisionId };
  await updateEditorialReadiness(author, variant.id, { action: "review-sources", ...match,
    sourceVersions: [{ cardId: card.id, versionId: nextVersion }], comment: "Приватный комментарий автора о сверке" });
  await updateEditorialReadiness(author, variant.id, { action: "check", ...match });
  for (const viewer of [author, outsider]) {
    const row = (await findCardUsage(viewer, card.id)).find(item => item.id === variant.id)!;
    assert.equal(row.needsReview, false, "the exact published revision's review is visible to every authorized publication reader");
    assert.equal(row.versionId, getCardVersionId(card), "review must not rewrite the publication's original pin");
    assert.equal(row.reviewedVersionId, nextVersion);
    assert.doesNotMatch(JSON.stringify(row), /Приватный комментарий|reviewedBy/);
  }
  const laterDraft = (await mutateEditorial(variant.id, author, { action: "save", version: approvedVariant.version,
    content: { ...approvedVariant.content, lead: "Новая личная редакция материала." } })).document;
  assert.notEqual(laterDraft.revisionId, approvedVariant.revisionId);
  const publicAfterEdit = (await findCardUsage(outsider, card.id)).find(row => row.id === variant.id)!;
  assert.equal(publicAfterEdit.kind, "publication");
  assert.equal(publicAfterEdit.needsReview, false, "a later private draft cannot override the exact public revision's receipt");
  assert.doesNotMatch(JSON.stringify(publicAfterEdit), /Новая личная редакция/);
});
