import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { editorialContentSchema, editorialText, type EditorialDocument, type EditorialRevision } from "../lib/editorial";
import { evaluateEditorialReadiness, getEditorialReadiness, updateEditorialReadiness, type MaterialCheckRecord } from "../lib/editorial-readiness";
import type { ReadyArticle } from "../lib/articles";
import { demoAccounts } from "../lib/auth";
import { docClient } from "../lib/db";
import { assistEditorial } from "../lib/editor-assist";
import { createEditorial, getCurrentEditorialSnapshot, getEditorialSourceVersions, mutateEditorial } from "../lib/editorial-models";
import { knowledgeSeedCards, type KnowledgeCard } from "../lib/knowledge";
import { getCardVersionId } from "../lib/knowledge-versions";
import { TableName } from "../lib/schema";
import { buildArticleMarkdown, buildArticlesSummaryCsv } from "../lib/yandex-disk";
import { requireFixtureDatabase } from "./qa-fixture";

const now = "2026-11-22T10:00:00.000Z";
const pinned = { cardId: "lab", versionId: "first" };
const updated = { cardId: "lab", versionId: "second" };
const content = editorialContentSchema.parse({
  title: "Лаборатория МИДиС",
  lead: "Открыта лаборатория робототехники",
  sourceCardIds: ["lab"],
  sourceCardTitles: ["Робототехника"],
  sourceVersions: [pinned],
});
const revision: EditorialRevision = {
  id: "r1", documentId: "paper", number: 1, content,
  actorId: "author", actorName: "Автор", createdAt: now,
};
const document: EditorialDocument = {
  id: "paper", ownerId: "author", ownerName: "Автор", originalId: "paper",
  channel: "Оригинал", version: 3, revisionId: "r1", submittedRevisionId: "r1",
  approvedRevisionId: "r1", status: "approved", content, createdAt: now,
  updatedAt: now, events: [],
};
const publication: ReadyArticle = {
  ...content, id: "paper", createdAt: now, updatedAt: now,
  approval: { revisionId: "r1", approvedBy: "reviewer", approvedAt: now },
  diskSync: {
    status: "synced", sourceRevisionId: "r1", lastAttemptAt: now, lastSyncedAt: now,
    message: null, folderPath: null, filePath: null, summaryPath: null,
  },
};
const record: MaterialCheckRecord = {
  id: "material-check:paper:r1", kind: "material-check", documentId: "paper", revisionId: "r1",
  etag: "v1", textHash: createHash("sha256").update(editorialText(content)).digest("hex"),
  checkedAt: now, checkedBy: "author", sourceVersions: [pinned],
  result: {
    evidenceVersion: 1,
    summary: { red: 0, yellow: 0, green: 1, total: 1 }, canPublish: true, findings: [],
  },
  reviewedSourceVersions: [],
};

function passport(overrides: Partial<Parameters<typeof evaluateEditorialReadiness>[0]> = {}) {
  return evaluateEditorialReadiness({
    document, revision, record, publication,
    sources: [{ cardId: "lab", currentVersionId: "first", availableVersionIds: ["first"] }],
    ...overrides,
  });
}

test("readiness uses the exact text, approval and Disk revision", () => {
  assert.equal(passport().ready, true);
  assert.equal(passport({ record: { ...record, textHash: "different-text" } }).check.status, "stale");
  assert.equal(passport({ document: { ...document, approvedRevisionId: "r0" } }).ready, false);
  assert.equal(
    passport({ publication: { ...publication, diskSync: { ...publication.diskSync!, sourceRevisionId: "r0" } } }).ready,
    false,
  );
});

test("an ordinary check does not clear a changed source", () => {
  const sources = [{ cardId: "lab", currentVersionId: "second", availableVersionIds: ["first", "second"] }];
  const before = passport({ sources, record: { ...record, sourceVersions: [updated] } });
  assert.deepEqual(before.changedSources, [{ cardId: "lab", usedVersionId: "first", currentVersionId: "second" }]);
  assert.equal(before.ready, false);
  const manual = {
    ...record,
    reviewedSourceVersions: [{ ...updated, reviewedAt: now, reviewedBy: "author", comment: "Сверено с источником" }],
  };
  const needsCheck = passport({ sources, record: manual });
  assert.deepEqual(needsCheck.changedSources, []);
  assert.equal(needsCheck.check.status, "stale");
  assert.equal(passport({ sources, record: { ...manual, sourceVersions: [updated] } }).ready, true);
});

test("legacy sources stay unknown and overdue sources are listed separately", () => {
  const legacy = { ...content, sourceVersions: undefined };
  const result = passport({ document: { ...document, content: legacy }, revision: { ...revision, content: legacy }, record: null });
  assert.deepEqual(result.unknownSources, ["lab"]);
  assert.deepEqual(result.changedSources, [{ cardId: "lab", usedVersionId: null, currentVersionId: "first" }]);
  assert.equal(result.ready, false);
  const overdue = passport({ sources: [{ cardId: "lab", currentVersionId: "first", availableVersionIds: ["first"], overdue: true }] });
  assert.deepEqual(overdue.overdueSources, ["lab"]);
  assert.equal(overdue.ready, true);
});

test("a receipt from another revision never confirms the current revision", () => {
  assert.equal(passport({ record: { ...record, revisionId: "other" } }).check.status, "missing");
  assert.equal(passport({ record: { ...record, result: { ...record.result!, canPublish: false } } }).ready, false);
});

test("a receipt created before clause-level evidence checks requires a new check", () => {
  assert.equal(passport({
    record: { ...record, result: { ...record.result!, evidenceVersion: undefined } },
  }).check.status, "stale");
});

test("article backups identify the exact pinned sources and distinguish legacy sources", () => {
  const fixed = { ...publication, sourceVersions: [pinned] };
  assert.match(buildArticleMarkdown(fixed), /card=lab&version=first/);
  const csv = buildArticlesSummaryCsv(fixed, [fixed]);
  assert.match(csv, /lab@first/);
  const legacy = { ...publication, sourceVersions: undefined };
  assert.doesNotMatch(buildArticleMarkdown(legacy), /version=approved/);
  assert.match(buildArticlesSummaryCsv(legacy, [legacy]), /версия не зафиксирована/iu);
});

test("fixture validates pins, denies access to another author's revision and serializes reviews", {
  skip: process.env.CANON_EDITORIAL_DB_TEST !== "yes",
}, async (context) => {
  await requireFixtureDatabase();
  const owner = demoAccounts.find((user) => user.id === "demo-pr-midis")!;
  const stranger = demoAccounts.find((user) => user.id === "demo-pr-csu")!;
  const seed = knowledgeSeedCards.find((card) => card.type === "laboratory")!;
  const id = "qa-editorial-source-" + randomUUID();
  const card = { ...seed, id, status: "approved", updatedAt: now } as KnowledgeCard;
  const put = (item: KnowledgeCard) => new PutCommand({ TableName: TableName.KNOWLEDGE_CARDS, Item: item });
  await docClient.send(put(card));

  const pin = { cardId: id, versionId: getCardVersionId(card) };
  const saved = editorialContentSchema.parse({
    title: card.title, lead: card.referenceDescription, sourceCardIds: [id], sourceVersions: [pin],
  });
  await assert.rejects(createEditorial(owner, {
    channel: "Оригинал",
    content: { ...saved, sourceVersions: [{ ...pin, versionId: "version-of-a-different-card" }] },
  }), { status: 422 });
  const draft = await createEditorial(owner, { channel: "Оригинал", content: saved });
  const match = { version: draft.version, revisionId: draft.revisionId };
  await assert.rejects(getEditorialReadiness(stranger, draft.id), { status: 404 });
  await assert.rejects(assistEditorial(stranger, {
    action: "rewrite", documentId: draft.id, ...match, start: 0, end: 10,
  }, new Request("http://localhost:8080")), { status: 404 });
  assert.deepEqual(draft.content.sourceVersions, [pin]);
  assert.equal((await getEditorialSourceVersions(draft.content))[0].version?.snapshot.title, card.title);

  const changed = { ...card, title: card.title + " — обновление", updatedAt: "2026-11-22T10:01:00.000Z" };
  await docClient.send(put(changed));
  const reviewInput = {
    action: "review-sources" as const, ...match, comment: "Сверено с карточкой",
    sourceVersions: [{ cardId: id, versionId: getCardVersionId(changed) }],
  };
  const firstCheck = await updateEditorialReadiness(owner, draft.id, { action: "check", ...match });
  assert.equal(firstCheck.changedSources.length, 1);
  assert.equal(firstCheck.changedSources[0].usedVersionId, pin.versionId);
  assert.ok(firstCheck.check.checkedAt);
  const originalSend = docClient.send.bind(docClient);
  let injected = false;
  const latest = { ...changed, title: changed.title + " повторно", updatedAt: "2026-11-22T10:02:00.000Z" };
  const race = context.mock.method(docClient, "send", async (command: Parameters<typeof docClient.send>[0]) => {
    if (!injected && command instanceof TransactWriteCommand &&
        command.input.TransactItems?.some((operation) => operation.Put?.Item?.kind === "material-check")) {
      injected = true;
      await originalSend(put(latest));
    }
    return originalSend(command);
  });
  await assert.rejects(updateEditorialReadiness(owner, draft.id, reviewInput), { status: 409 });
  race.mock.restore();
  assert.equal(injected, true);
  assert.equal((await getEditorialReadiness(owner, draft.id)).changedSources[0].currentVersionId, getCardVersionId(latest));
  const currentReview = { ...reviewInput, sourceVersions: [{ cardId: id, versionId: getCardVersionId(latest) }] };
  const reviewed = await updateEditorialReadiness(owner, draft.id, currentReview);
  assert.equal(reviewed.changedSources.length, 0);
  assert.equal(reviewed.check.status, "missing");
  const repeated = await updateEditorialReadiness(owner, draft.id, currentReview);
  assert.deepEqual(repeated.reviewedSourceVersions, reviewed.reviewedSourceVersions);
  assert.deepEqual((await getCurrentEditorialSnapshot(draft.id, owner)).revision.content.sourceVersions, [pin]);
  assert.equal((await docClient.send(new GetCommand({
    TableName: TableName.WORKFLOW_RECORDS,
    Key: { id: `material-check:${draft.id}:${draft.revisionId}` },
  }))).Item?.revisionId, draft.revisionId);

  const edited = await mutateEditorial(draft.id, owner, { action: "save", version: draft.version,
    content: { ...draft.content, lead: draft.content.lead + " Новый текст для проверки." } });
  assert.notEqual(edited.document.revisionId, draft.revisionId);
  await assert.rejects(updateEditorialReadiness(owner, draft.id, { action: "check", ...match }), { status: 409 });
  assert.equal((await getEditorialReadiness(owner, draft.id)).check.status, "missing");
});
