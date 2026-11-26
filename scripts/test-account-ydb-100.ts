import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { AccountIdentity } from "../lib/account-service";
import { dynamoAccountStore } from "../lib/account-storage";
import { docClient } from "../lib/db";
import { TableName } from "../lib/schema";

const bucket = { id: "fixture:rate", limit: 1, expiresAt: 2_000_000_000 };
const other = { ...bucket, id: "fixture:other" };
const identity: AccountIdentity = {
  id: "a".repeat(64), userId: "author-fixture", email: "author@example.test", revision: 0, sessionEpoch: 0,
};
const canceled = () => new TransactionCanceledException({ $metadata: {}, message: "Synthetic YDB cancellation" });

function fixture(context: TestContext) {
  const counts = new Map<string, number>();
  const accounts = new Map<string, AccountIdentity>();
  const reads: GetCommand["input"][] = [];
  const transactions: TransactWriteCommand["input"][] = [];
  const faults: Error[] = [];
  const original = docClient.send;
  context.after(() => { docClient.send = original; });
  docClient.send = (async (command: unknown) => {
    if (command instanceof GetCommand) {
      const { TableName: table, Key, ConsistentRead } = command.input;
      assert.equal(ConsistentRead, true);
      const id = String(Key?.id);
      reads.push(command.input);
      if (table === TableName.ACCOUNT_IDENTITIES) return { Item: accounts.get(id) };
      assert.equal(table, TableName.ACCOUNT_RATE_LIMITS);
      return { Item: counts.has(id) ? { id, attempts: counts.get(id) } : undefined };
    }
    assert.ok(command instanceof TransactWriteCommand);
    transactions.push(command.input);
    const fault = faults.shift();
    if (fault) throw fault;
    const items = command.input.TransactItems!;
    const writes = items.map(({ Put, Update }) => {
      if (Put) {
        assert.equal(Put.TableName, TableName.ACCOUNT_IDENTITIES);
        const row = Put.Item as AccountIdentity;
        const prior = accounts.get(row.id);
        if (Put.ConditionExpression === "attribute_not_exists(id)" ? prior : prior?.revision !== Put.ExpressionAttributeValues?.[":revision"])
          throw canceled();
        return () => { accounts.set(row.id, row); };
      }
      assert.equal(Update?.TableName, TableName.ACCOUNT_RATE_LIMITS);
      assert.match(Update!.ConditionExpression!, /#attempts < :limit/);
      const id = String(Update!.Key?.id);
      const attempts = counts.get(id) ?? 0;
      if (attempts >= Update!.ExpressionAttributeValues![":limit"]) throw canceled();
      return () => { counts.set(id, attempts + 1); };
    });
    writes.forEach(write => write());
    return {};
  }) as typeof docClient.send;
  return { counts, accounts, reads, transactions, faults };
}

test("a reasonless YDB cancellation denies the losing rate reservation without consuming other buckets", async context => {
  const f = fixture(context);
  const outcomes = await Promise.all([dynamoAccountStore.consumeRate([bucket]), dynamoAccountStore.consumeRate([bucket, other])]);
  assert.deepEqual(outcomes, [true, false]);
  assert.deepEqual(f.counts, new Map([[bucket.id, 1]]));
  assert.equal(f.transactions.length, 2);
  assert.ok(f.reads.some(read => read.TableName === TableName.ACCOUNT_RATE_LIMITS && read.Key?.id === bucket.id));
});

test("a reasonless identity CAS or mail-limit failure preserves both rows", async context => {
  const f = fixture(context);
  assert.equal(await dynamoAccountStore.putIdentity(identity, null, bucket), true);
  assert.equal(await dynamoAccountStore.putIdentity({ ...identity, revision: 1 }, null, other), false);
  assert.equal(await dynamoAccountStore.putIdentity({ ...identity, revision: 1 }, 1, other), false);
  assert.equal(await dynamoAccountStore.putIdentity({ ...identity, revision: 1 }, 0, bucket), false);
  assert.deepEqual(f.accounts.get(identity.id), identity);
  assert.deepEqual(f.counts, new Map([[bucket.id, 1]]));
  assert.equal(f.transactions.length, 4);
});

test("only a successful atomic retry can grant a reservation after an unexplained cancellation", async context => {
  const f = fixture(context);
  f.faults.push(canceled());
  assert.equal(await dynamoAccountStore.putIdentity(identity, null, bucket), true);
  assert.equal(f.transactions.length, 2);
  assert.deepEqual(f.transactions[0], f.transactions[1]);
  assert.equal(f.counts.get(bucket.id), 1);
  const last = canceled();
  f.faults.push(canceled(), last);
  await assert.rejects(dynamoAccountStore.consumeRate([other]), error => error === last);
  assert.equal(f.transactions.length, 4);
  assert.equal(f.counts.has(other.id), false);
});

test("storage faults do not turn into rate denials or trigger a transaction retry", async context => {
  const f = fixture(context);
  const unreachable = new Error("Synthetic storage fault");
  const invalid = new TransactionCanceledException({ $metadata: {}, message: "Synthetic validation error", CancellationReasons: [
    { Code: "ConditionalCheckFailed" }, { Code: "ValidationError" },
  ] });
  f.faults.push(unreachable, invalid);
  await assert.rejects(dynamoAccountStore.consumeRate([bucket]), error => error === unreachable);
  await assert.rejects(dynamoAccountStore.consumeRate([bucket, other]), error => error === invalid);
  assert.equal(f.transactions.length, 2);
  assert.equal(f.reads.length, 0);
  assert.equal(f.counts.size, 0);
});
