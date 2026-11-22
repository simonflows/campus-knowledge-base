import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
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

function fixture(context: TestContext, { snapshot = false, changeOnWrite = false, sourceCount = 1 } = {}) {
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
  const observedHead: CampusCard = snapshot ? { ...current, status: "pending", approvedSnapshot: old } : old;
  const sourceHeads = new Map<string, CampusCard>([[old.id, observedHead]]);
  for (let index = 1; index < sourceCount; index++) {
    const id = `fixture-source-${index}`;
    sourceHeads.set(id, { ...old, id });
  }
  const oldPin = describeApprovedCardVersion(old, { legacyBaseline: false, recordedAt: old.updatedAt });
  const text = "Общая площадь объектов кампуса — 150 000 кв. м.";
  const reviewer = toSessionUser(getDemoAccount("demo-admin")!);
  const content = editorialContentSchema.parse({
    title: "Summary", lead: text, universityId: "csu", sourceCardIds: [...sourceHeads.keys()], sourceCardTitles: [old.title],
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
  let committed = false;
  let transaction: TransactWriteCommand | undefined;
  context.mock.method(globalThis, "fetch", async () => assert.fail("The fixture must not contact any provider"));
  context.mock.method(docClient, "send", async (command: unknown) => {
    if (command instanceof ListTablesCommand) return {};
    if (command instanceof GetCommand) {
      if (command.input.TableName === TableName.KNOWLEDGE_CARDS) {
        return { Item: structuredClone(sourceHeads.get(command.input.Key?.id)) };
      }
      const rows = new Map<string, unknown>([
        [TableName.KNOWLEDGE_CARD_VERSIONS, oldPin],
        [TableName.EDITORIAL_DOCUMENTS, document], [TableName.EDITORIAL_REVISIONS, revision],
      ]);
      return { Item: rows.get(command.input.TableName ?? "") };
    }
    if (command instanceof ScanCommand) {
      return { Items: command.input.TableName === TableName.KNOWLEDGE_CARDS ? structuredClone([...sourceHeads.values()]) : [] };
    }
    assert.ok(command instanceof TransactWriteCommand);
    transaction = command;
    if (changeOnWrite) sourceHeads.set(old.id, current);
    for (const { ConditionCheck: check } of command.input.TransactItems ?? []) {
      if (check?.TableName !== TableName.KNOWLEDGE_CARDS) continue;
      const row = sourceHeads.get(check.Key?.id);
      const { ":sourceHead": expectedHead, ":publishedSnapshot": expectedSnapshot } = check.ExpressionAttributeValues ?? {};
      if (row?.updatedAt !== expectedHead || (expectedSnapshot && row?.approvedSnapshot?.updatedAt !== expectedSnapshot)) {
        throw Object.assign(new Error("Changed source fixture"), { name: "ConditionalCheckFailedException" });
      }
    }
    committed = command.input.TransactItems?.some(write => write.Put?.TableName === TableName.ARTICLES) ?? false;
    return {};
  });
  assert.equal(checkFactText(editorialText(content), [old]).summary.red, 0);
  assert.ok(checkFactText(editorialText(content), [current]).summary.red > 0);
  const approve = () => mutateEditorial(document.id, reviewer, {
    action: "approve", version: document.version, revisionId: revision.id, comment: "",
  });
  return {
    approve, committed: () => committed, writes: () => transaction?.input.TransactItems,
    observedHead, publishedSource: old,
  };
}

test("a source change immediately before the approval transaction blocks publication", async context => {
  const scenario = fixture(context, { changeOnWrite: true });
  await assert.rejects(scenario.approve(), { status: 409 });
  assert.equal(scenario.committed(), false);
  assert.equal(scenario.writes()?.find(item => item.ConditionCheck)?.ConditionCheck?.Key?.id, scenario.publishedSource.id);
});

test("a pending head preserves its public evidence and both timestamps are guarded", async context => {
  const scenario = fixture(context, { snapshot: true });
  assert.equal((await scenario.approve()).document.status, "approved");
  const guard = scenario.writes()?.find(item => item.ConditionCheck)?.ConditionCheck;
  assert.match(guard?.ConditionExpression ?? "", /approvedSnapshot\.updatedAt/);
  assert.equal(guard?.ExpressionAttributeValues?.[":sourceHead"], scenario.observedHead.updatedAt);
  assert.equal(guard?.ExpressionAttributeValues?.[":publishedSnapshot"], scenario.publishedSource.updatedAt);
});

test("22 selected sources fit with all three writes in the Document API transaction", async context => {
  const scenario = fixture(context, { sourceCount: 22 });
  assert.equal((await scenario.approve()).document.status, "approved");
  assert.equal(scenario.writes()?.length, 25);
});

test("23 selected sources reject approval before attempting a write", async context => {
  const scenario = fixture(context, { sourceCount: 23 });
  await assert.rejects(scenario.approve(), { status: 422 });
  assert.equal(scenario.writes(), undefined);
});
