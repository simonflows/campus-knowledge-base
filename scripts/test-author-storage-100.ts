import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ListTablesCommand, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { GetCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { articleBasisReference, flattenArticleChunks, type ReadyArticle } from "../lib/articles";
import { getDemoAccount, toSessionUser, type SessionUser } from "../lib/auth";
import { docClient, resetDbAvailableCache } from "../lib/db";
import { createEditorial, deleteEditorial, getEditorial, mutateEditorial } from "../lib/editorial-models";
import { createEditorialSchema } from "../lib/editorial";
import { TableName } from "../lib/schema";

const siteKey = "storage:author:site";
const userKey = (user: SessionUser) => "storage:author:user:" + user.id;
const author: SessionUser = {
  id: "author-qa", role: "author", name: "Тестовый автор", organization: "", position: "",
  ownershipLabel: "Тестовый автор", ownerAliases: [], organizationAliases: [],
};
const staff = toSessionUser(getDemoAccount("demo-pr-midis")!);
const draft = createEditorialSchema.parse({ content: { title: "Учебный материал" } });
type Row = Record<string, unknown>;
type Transaction = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>;

function fixture(context: TestContext, withReasons = true) {
  process.env.USE_DATABASE = "true";
  process.env.DOCUMENT_API_ENDPOINT = "https://isolated-fixture.invalid";
  resetDbAvailableCache();
  const tables = new Map<string, Map<string, Row>>();
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  const budget = table(TableName.ACCOUNT_RATE_LIMITS);
  const documents = table(TableName.EDITORIAL_DOCUMENTS);
  const revisions = table(TableName.EDITORIAL_REVISIONS);
  const articles = table(TableName.ARTICLES);
  const transactions: Transaction[] = [];
  const faults: Error[] = [];
  let beforeTransaction: (() => void) | undefined;
  const original = docClient.send;
  context.after(() => { docClient.send = original; resetDbAvailableCache(); });
  docClient.send = (async (command: unknown) => {
    if (command instanceof ListTablesCommand) return {};
    if (command instanceof GetCommand) {
      assert.equal(command.input.ConsistentRead, true);
      return { Item: structuredClone(table(command.input.TableName!).get(command.input.Key!.id)) };
    }
    if (command instanceof ScanCommand)
      return { Items: structuredClone([...table(command.input.TableName!).values()]) };
    assert.ok(command instanceof TransactWriteCommand);
    const items = command.input.TransactItems!;
    assert.ok(items.length <= 25);
    transactions.push(structuredClone(items));
    const fault = faults.shift();
    if (fault) throw fault;
    beforeTransaction?.();
    const next: Array<() => void> = [];
    const reasons = items.map(({ Put, Update, ConditionCheck }) => {
      if (Put) {
        const rows = table(Put.TableName!);
        const id = Put.Item!.id;
        const row = rows.get(id);
        const version = Put.ExpressionAttributeValues?.[":version"];
        const ownerId = Put.ExpressionAttributeValues?.[":ownerId"];
        if (Put.ConditionExpression?.includes("attribute_not_exists(id)") && row ||
          version !== undefined && row?.version !== version ||
          ownerId !== undefined && (row?.ownerId !== ownerId || row?.deletedAt))
          return { Code: "ConditionalCheckFailed" };
        next.push(() => rows.set(id, structuredClone(Put.Item!)));
      } else if (Update) {
        assert.equal(Update.TableName, TableName.ACCOUNT_RATE_LIMITS);
        assert.doesNotMatch(Update.UpdateExpression!, /expiresAt/);
        assert.match(Update.ConditionExpression!, /#bytes <= :bytesRemaining/);
        if (Update.ExpressionAttributeValues![":drafts"] !== undefined)
          assert.match(Update.ConditionExpression!, /#drafts <= :draftsRemaining/);
        const id = Update.Key!.id as string;
        const current = budget.get(id);
        const bytes = Number(current?.bytes ?? 0);
        const drafts = Number(current?.drafts ?? 0);
        const add = Update.ExpressionAttributeValues!;
        if (bytes > add[":bytesRemaining"] ||
          add[":draftsRemaining"] !== undefined && drafts > add[":draftsRemaining"])
          return { Code: "ConditionalCheckFailed" };
        next.push(() => budget.set(id, {
          id, bytes: bytes + add[":bytes"],
          ...(add[":drafts"] !== undefined ? { drafts: drafts + add[":drafts"] } : {}),
        }));
      } else {
        assert.ok(ConditionCheck);
        const row = table(ConditionCheck.TableName!).get(ConditionCheck.Key!.id) as ReadyArticle | undefined;
        const values = ConditionCheck.ExpressionAttributeValues;
        if (ConditionCheck.ConditionExpression === "attribute_not_exists(id)" ? row :
          row?.approval?.revisionId !== values?.[":basisRevision"] || row?.updatedAt !== values?.[":basisUpdated"])
          return { Code: "ConditionalCheckFailed" };
      }
      return { Code: "None" };
    });
    if (reasons.some(({ Code }) => Code === "ConditionalCheckFailed"))
      throw new TransactionCanceledException({
        $metadata: {}, message: "Synthetic transaction cancellation", CancellationReasons: withReasons ? reasons : undefined,
      });
    next.forEach(commit => commit());
    return {};
  }) as typeof docClient.send;
  return { budget, documents, revisions, articles, transactions, faults,
    onBeforeTransaction(callback?: () => void) { beforeTransaction = callback; },
  };
}

test("concurrent draft creates respect the cumulative author limit and keep staff unaffected", async context => {
  const f = fixture(context);
  for (let index = 0; index < 15; index++) await createEditorial(author, draft);
  const outcomes = await Promise.allSettled([createEditorial(author, draft), createEditorial(author, draft)]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.find(result => result.status === "rejected")?.reason.status, 429);
  assert.equal(f.documents.size, 16);
  assert.equal(f.revisions.size, 32);
  assert.equal(f.budget.get(userKey(author))?.drafts, 16);
  const before = structuredClone(f.budget);
  await createEditorial(staff, draft);
  assert.deepEqual(f.budget, before);
  assert.equal(f.documents.size, 17);
});

test("identical autosave does not append history and failed version CAS does not charge", async context => {
  const f = fixture(context);
  const original = await createEditorial(author, draft);
  const initialBudget = structuredClone(f.budget);
  const same = await mutateEditorial(original.id, author, {
    action: "save", version: original.version, content: { ...original.content, sourceCardTitles: ["UI-only title"] },
  });
  assert.equal(same.document.version, original.version);
  assert.equal(same.document.revisionId, original.revisionId);
  assert.deepEqual(f.budget, initialBudget);
  assert.equal(f.transactions.length, 1);

  const outcomes = await Promise.allSettled(["Новый текст А", "Новый текст Б"].map(lead =>
    mutateEditorial(original.id, author, { action: "save", version: original.version, content: { ...original.content, lead } })));
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.find(result => result.status === "rejected")?.reason.status, 409);
  const head = f.documents.get(original.id)!;
  assert.equal(head.version, 2);
  assert.equal(f.revisions.size, 4);
  const winner = f.transactions.slice(1).find(items => items[0].Put?.Item?.revisionId === head.revisionId)!;
  const charge = winner.find(item => item.Update?.Key?.id === userKey(author))!.Update!.ExpressionAttributeValues![":bytes"] as number;
  const putBytes = winner.reduce((bytes, item) =>
    bytes + (item.Put ? Buffer.byteLength(JSON.stringify(item.Put.Item), "utf8") : 0), 0);
  assert.ok(charge >= putBytes);
  assert.equal(f.budget.get(userKey(author))?.bytes, Number(initialBudget.get(userKey(author))?.bytes) + charge);
  assert.equal(f.budget.get(siteKey)?.bytes, Number(initialBudget.get(siteKey)?.bytes) + charge);
});

test("exhausted site budget rejects writes atomically and leaves tombstone deletion available", async context => {
  const f = fixture(context);
  const original = await createEditorial(author, draft);
  const site = { id: siteKey, bytes: 24 * 1024 * 1024 };
  f.budget.set(siteKey, site);
  await assert.rejects(createEditorial({ ...author, id: "author-other" }, draft), { status: 429 });
  await assert.rejects(mutateEditorial(original.id, author, {
    action: "save", version: original.version, content: { ...original.content, lead: "Доработка" },
  }), { status: 429 });
  assert.equal(f.documents.size, 1);
  assert.equal(f.revisions.size, 2);
  assert.deepEqual(f.budget.get(siteKey), site);
  const beforeDelete = structuredClone(f.budget);
  await deleteEditorial(original.id, author, original.version);
  assert.deepEqual(f.budget, beforeDelete);
  assert.equal(f.revisions.size, 3);
  assert.ok(f.revisions.has(original.revisionId));
  assert.ok(f.documents.get(original.id)?.deletedAt);
  await assert.rejects(getEditorial(original.id, author), { status: 404 });
});


test("one author's byte limit does not charge the site or block another author", async context => {
  const f = fixture(context);
  const original = await createEditorial(author, draft);
  f.budget.set(userKey(author), { id: userKey(author), bytes: 4 * 1024 * 1024, drafts: 1 });
  const before = structuredClone(f.budget);
  await assert.rejects(mutateEditorial(original.id, author, {
    action: "save", version: original.version, content: { ...original.content, lead: "Новая редакция" },
  }), { status: 429 });
  assert.deepEqual(f.budget, before);
  const another = await createEditorial({ ...author, id: "author-other" }, draft);
  assert.equal(another.ownerId, "author-other");
  assert.equal(f.revisions.size, 4);
});

test("YDB cancellations without reasons still distinguish draft and site quotas from stale revisions", async context => {
  const f = fixture(context, false);
  const original = await createEditorial(author, draft);
  const outcomes = await Promise.allSettled(["Редакция А", "Редакция Б"].map(lead =>
    mutateEditorial(original.id, author, { action: "save", version: original.version, content: { ...original.content, lead } })));
  const winner = outcomes.find(result => result.status === "fulfilled");
  assert.ok(winner);
  assert.equal(outcomes.find(result => result.status === "rejected")?.reason.status, 409);
  const current = winner.value.document;
  f.budget.set(userKey(author), { ...f.budget.get(userKey(author))!, drafts: 16 });
  await assert.rejects(createEditorial(author, draft), { status: 429, message: /лимит хранения черновиков автора/ });
  f.budget.set(siteKey, { id: siteKey, bytes: 24 * 1024 * 1024 });
  const before = structuredClone(f.budget);
  await assert.rejects(createEditorial({ ...author, id: "author-other" }, draft), { status: 429, message: /общий лимит/ });
  await assert.rejects(mutateEditorial(original.id, author, {
    action: "save", version: current.version, content: { ...current.content, lead: "Новый текст" },
  }), { status: 429, message: /общий лимит/ });
  assert.deepEqual(f.budget, before);
  assert.equal(f.documents.size, 1);
  assert.equal(f.revisions.size, 4);
  const head = f.documents.get(original.id)!;
  assert.equal(head.version, current.version);
  await deleteEditorial(original.id, author, current.version);
  assert.deepEqual(f.budget, before);
  assert.equal(f.revisions.size, 5);
});

test("repeated author cancellation with every guard open propagates the storage failure", async context => {
  const f = fixture(context, false);
  const canceled = () => new TransactionCanceledException({ $metadata: {}, message: "Synthetic YDB cancellation" });
  const original = await createEditorial(author, draft);
  const before = structuredClone(f.budget);
  const last = canceled();
  f.faults.push(canceled(), last);
  await assert.rejects(mutateEditorial(original.id, author, {
    action: "save", version: original.version, content: { ...original.content, lead: "Новый текст" },
  }), error => error === last);
  assert.equal(f.transactions.length, 3);
  assert.deepEqual(f.transactions[1], f.transactions[2]);
  assert.equal(f.documents.get(original.id)?.version, original.version);
  assert.equal(f.revisions.size, 2);
  assert.deepEqual(f.budget, before);
});

test("a changed article basis keeps conflict precedence over a simultaneous storage limit", async context => {
  const f = fixture(context, false);
  const time = "2026-01-01T00:00:00.000Z";
  const publication: ReadyArticle = {
    id: "article-fixture", title: "Опорная статья", lead: "", universityId: "", projectTitle: "", topic: "", query: "",
    sections: [{ id: "section", heading: "Раздел", level: 2, chunks: [{ id: "part", content: "Утверждённый факт" }] }],
    sourceCardIds: [], sourceCardTitles: [], createdAt: time, updatedAt: time,
    approval: { revisionId: "revision-fixture", approvedBy: "fixture-admin", approvedAt: time },
  };
  f.articles.set(publication.id, publication);
  const basis = articleBasisReference(flattenArticleChunks(publication)[0]);
  const input = createEditorialSchema.parse({ content: { title: "Черновик", articleBasis: [basis] } });
  const full = { id: siteKey, bytes: 24 * 1024 * 1024 };
  f.budget.set(siteKey, full);
  f.onBeforeTransaction(() => {
    f.articles.set(publication.id, { ...publication, updatedAt: "2026-01-02T00:00:00.000Z" });
  });
  await assert.rejects(createEditorial(author, input), { status: 409, message: /Опорная статья изменилась/ });
  f.onBeforeTransaction();
  await assert.rejects(createEditorial(author, input), { status: 429, message: /общий лимит/ });
  assert.equal(f.documents.size, 0);
  assert.equal(f.revisions.size, 0);
  assert.deepEqual(f.budget, new Map([[siteKey, full]]));
  assert.equal(f.transactions.length, 2);
});
