import assert from "node:assert/strict";
import { test } from "node:test";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { GetCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { getDemoAccount, toSessionUser } from "../lib/auth";
import { docClient, resetDbAvailableCache } from "../lib/db";
import { editorialContentSchema, editorialText, type EditorialDocument, type EditorialRevision } from "../lib/editorial";
import { mutateEditorial } from "../lib/editorial-models";
import { checkFactText } from "../lib/fact-check";
import { knowledgeSeedCards, type CampusCard } from "../lib/knowledge";
import { describeApprovedCardVersion } from "../lib/knowledge-versions";
import { TableName } from "../lib/schema";

test("a newly published article requires the current approval sources even when its old pinned fact would pass", async context => {
  Object.assign(process.env, {
    DOCUMENT_API_ENDPOINT: "http://127.0.0.1:1", USE_DATABASE: "true", OUTPUT_MODE: "",
    CAMPUS_LOCAL_DEMO: "false", CAMPUS_DEMO_LOGIN: "true", CAMPUS_PILOT_ACCOUNTS: "",
  });
  resetDbAvailableCache();
  context.after(resetDbAvailableCache);
  const old = structuredClone(knowledgeSeedCards.find((card): card is CampusCard => card.type === "campus")!);
  old.id = "fixture-campus";
  old.campusMetrics[0].value = "150 000 кв. м";
  const current = structuredClone(old);
  current.campusMetrics[0].value = "160 000 кв. м";
  current.updatedAt = "2026-11-22T02:00:00.000Z";
  const oldPin = describeApprovedCardVersion(old, { legacyBaseline: false, recordedAt: old.updatedAt });
  const text = "Общая площадь объектов кампуса — 150 000 кв. м.";
  const reviewer = toSessionUser(getDemoAccount("demo-admin")!);
  const content = editorialContentSchema.parse({
    title: "Summary", lead: text, universityId: "csu", sourceCardIds: [old.id], sourceCardTitles: [old.title],
    sourceVersions: [{ cardId: old.id, versionId: oldPin.id }],
    sections: [{ id: "section", heading: "Details", level: 2, chunks: [{ id: "chunk", content: text }] }],
  });
  const document: EditorialDocument = {
    id: "fixture-draft", ownerId: "fixture-author", ownerName: "Fixture author",
    originalId: "fixture-draft", channel: "Оригинал", version: 2,
    revisionId: "revision-1", submittedRevisionId: "revision-1", approvedRevisionId: null,
    status: "submitted", reviewerId: reviewer.id, content, events: [],
    createdAt: old.createdAt, updatedAt: old.updatedAt,
  };
  const revision: EditorialRevision = {
    id: document.revisionId, documentId: document.id, number: 1, content,
    actorId: document.ownerId, actorName: document.ownerName, createdAt: old.createdAt,
  };
  let wrotePublication = false;
  context.mock.method(globalThis, "fetch", async () => assert.fail("The fixture must not contact any provider"));
  context.mock.method(docClient, "send", async (command: unknown) => {
    if (command instanceof ListTablesCommand) return {};
    if (command instanceof GetCommand) {
      const rows = new Map<string, unknown>([
        [TableName.KNOWLEDGE_CARD_VERSIONS, oldPin], [TableName.KNOWLEDGE_CARDS, current],
        [TableName.EDITORIAL_DOCUMENTS, document], [TableName.EDITORIAL_REVISIONS, revision],
      ]);
      return { Item: rows.get(command.input.TableName ?? "") };
    }
    if (command instanceof ScanCommand) {
      return { Items: command.input.TableName === TableName.KNOWLEDGE_CARDS ? [current] : [] };
    }
    assert.ok(command instanceof TransactWriteCommand);
    wrotePublication = command.input.TransactItems?.some(write => write.Put?.TableName === TableName.ARTICLES) ?? false;
    return {};
  });
  assert.equal(checkFactText(editorialText(content), [old]).summary.red, 0);
  assert.ok(checkFactText(editorialText(content), [current]).summary.red > 0);
  await assert.rejects(mutateEditorial(document.id, reviewer, {
    action: "approve", version: document.version, revisionId: revision.id, comment: "",
  }), { status: 409 });
  assert.equal(wrotePublication, false);
});

for (const usePins of [false, true]) {
  test(`a known canonical contradiction blocks publication even if the source selection omits it (${usePins ? "pinned" : "legacy"})`, async context => {
    Object.assign(process.env, {
      DOCUMENT_API_ENDPOINT: "http://127.0.0.1:1", USE_DATABASE: "true", OUTPUT_MODE: "",
      CAMPUS_LOCAL_DEMO: "false", CAMPUS_DEMO_LOGIN: "true", CAMPUS_PILOT_ACCOUNTS: "",
    });
    resetDbAvailableCache();
    context.after(resetDbAvailableCache);
    const campus = structuredClone(knowledgeSeedCards.find((card): card is CampusCard => card.type === "campus")!);
    campus.id = "fixture-current-campus";
    campus.campusMetrics[0].value = "160 000 кв. м";
    const selected = knowledgeSeedCards.find(card => card.type === "university" && card.universityId === "csu")!;
    const pin = describeApprovedCardVersion(selected, { legacyBaseline: false, recordedAt: selected.updatedAt });
    const text = "Общая площадь объектов кампуса — 150 000 кв. м.";
    const reviewer = toSessionUser(getDemoAccount("demo-admin")!);
    const content = editorialContentSchema.parse({
      title: "Summary", lead: text, universityId: "csu", sourceCardIds: [selected.id], sourceCardTitles: [selected.title],
      ...(usePins && { sourceVersions: [{ cardId: selected.id, versionId: pin.id }] }),
      sections: [{ id: "section", heading: "Details", level: 2, chunks: [{ id: "body", content: text }] }],
    });
    const document: EditorialDocument = {
      id: "fixture-draft", ownerId: "fixture-author", ownerName: "Fixture author",
      originalId: "fixture-draft", channel: "Оригинал", version: 2,
      revisionId: "revision-1", submittedRevisionId: "revision-1", approvedRevisionId: null,
      status: "submitted", reviewerId: reviewer.id, content, events: [],
      createdAt: selected.createdAt, updatedAt: selected.updatedAt,
    };
    const revision: EditorialRevision = {
      id: document.revisionId, documentId: document.id, number: 1, content,
      actorId: document.ownerId, actorName: document.ownerName, createdAt: selected.createdAt,
    };
    let wrotePublication = false;
    context.mock.method(globalThis, "fetch", async () => assert.fail("The fixture must not contact any provider"));
    context.mock.method(docClient, "send", async (command: unknown) => {
      if (command instanceof ListTablesCommand) return {};
      if (command instanceof GetCommand) {
        const rows = new Map<string, unknown>([
          [TableName.KNOWLEDGE_CARD_VERSIONS, pin], [TableName.KNOWLEDGE_CARDS, selected],
          [TableName.EDITORIAL_DOCUMENTS, document], [TableName.EDITORIAL_REVISIONS, revision],
        ]);
        return { Item: rows.get(command.input.TableName ?? "") };
      }
      if (command instanceof ScanCommand) {
        return { Items: command.input.TableName === TableName.KNOWLEDGE_CARDS ? [selected, campus] : [] };
      }
      assert.ok(command instanceof TransactWriteCommand);
      wrotePublication = command.input.TransactItems?.some(write => write.Put?.TableName === TableName.ARTICLES) ?? false;
      return {};
    });
    const article = editorialText(content);
    assert.equal(checkFactText(article, [selected]).summary.red, 0);
    assert.ok(checkFactText(article, [selected, campus]).findings.some(finding =>
      finding.level === "red" && finding.sourceCardId === campus.id));
    await assert.rejects(mutateEditorial(document.id, reviewer, {
      action: "approve", version: document.version, revisionId: revision.id, comment: "",
    }), { status: 422 });
    assert.equal(wrotePublication, false);
  });
}
