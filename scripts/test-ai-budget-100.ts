import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountRateBucket } from "../lib/account-service";
import { createAiBudget } from "../lib/ai-budget";

const enabled = { CAMPUS_EMAIL_ACCOUNTS_ENABLED: "true", CAMPUS_WEB_SEARCH_ENABLED: "true" };

test("Yandex-only public accounts reserve canonical AI quota with email registration disabled", async () => {
  const store = atomicStore();
  const consume = createAiBudget(store, () => Date.UTC(2026, 10, 26), {
    CAMPUS_YANDEX_OAUTH_ENABLED: "true", CAMPUS_EMAIL_ACCOUNTS_ENABLED: "false",
  });
  const results = await Promise.all(Array.from({ length: 51 }, () => consume("fixture-yandex", "canon")));
  assert.equal(results.filter(result => result.allowed).length, 50);
  assert.deepEqual(results[50], { allowed: false, reason: "quota" });
  assert.equal(store.transactions.length, 51);
});

function atomicStore() {
  const transactions: AccountRateBucket[][] = [];
  const counts = new Map<string, number>();
  return { transactions, counts, async consumeRate(buckets: AccountRateBucket[]) {
    transactions.push(buckets);
    if (buckets.some(({ id, limit }) => (counts.get(id) ?? 0) >= limit)) return false;
    for (const { id } of buckets) counts.set(id, (counts.get(id) ?? 0) + 1);
    return true;
  } };
}

test("web reserves user, site-day and site-month counters atomically before the paid attempt", async () => {
  const store = atomicStore();
  const consume = createAiBudget(store, () => Date.UTC(2026, 10, 26), enabled);
  const results = await Promise.all(Array.from({ length: 12 }, () => consume("synthetic-user-email", "web")));
  assert.equal(results.filter(result => result.allowed).length, 5);
  assert.equal(results.filter(result => !result.allowed && result.reason === "quota").length, 7);
  assert.deepEqual(store.transactions[0].map(bucket => bucket.limit).sort((a, b) => a - b), [5, 50, 200]);
  assert.ok(store.transactions.every(transaction => transaction.length === 3));
  assert.ok([...store.counts.keys()].every(id => !id.includes("synthetic-user-email")));
  assert.ok([...store.counts.values()].every(count => count === 5));
});

test("web site-day and site-month limits use UTC windows and retained counters", async () => {
  const store = atomicStore();
  let now = Date.UTC(2026, 10, 26, 23, 59, 59);
  const consume = createAiBudget(store, () => now, enabled);
  for (let day = 26; day < 30; day++) {
    now = Date.UTC(2026, 10, day, 23, 59, 59);
    const results = await Promise.all(Array.from({ length: 51 }, (_, id) => consume(`fixture-${id}`, "web")));
    assert.equal(results.filter(result => result.allowed).length, 50);
  }
  now = Date.UTC(2026, 10, 30);
  assert.deepEqual(await consume("fixture-0", "web"), { allowed: false, reason: "quota" });
  now = Date.UTC(2026, 11, 1);
  assert.deepEqual(await consume("fixture-0", "web"), { allowed: true });
  assert.ok(store.transactions[0].every(bucket => Number.isInteger(bucket.expiresAt) && bucket.expiresAt > Date.UTC(2026, 10, 27) / 1000));
});

test("canonical budgets are independent and preserve the legacy flag-off configuration", async () => {
  const store = atomicStore();
  const now = () => Date.UTC(2026, 10, 26);
  const legacy = createAiBudget(store, now, {});
  assert.deepEqual(await legacy("fixture", "canon"), { allowed: true });
  assert.deepEqual(await legacy("fixture", "web"), { allowed: false, reason: "unavailable" });
  assert.equal(store.transactions.length, 0);

  const consume = createAiBudget(store, now, enabled);
  const results = await Promise.all(Array.from({ length: 51 }, () => consume("fixture", "canon")));
  assert.equal(results.filter(result => result.allowed).length, 50);
  assert.deepEqual(store.transactions[0].map(bucket => bucket.limit).sort((a, b) => a - b), [50, 1000]);
  assert.deepEqual(await consume("fixture", "web"), { allowed: true });
});

test("budget rejects unavailable storage, empty account IDs and a disabled storage mode", async () => {
  const now = () => Date.UTC(2026, 10, 26);
  const denied = { allowed: false, reason: "unavailable" };
  const unavailable = createAiBudget({ async consumeRate() { throw new Error("offline fixture"); } }, now, enabled);
  assert.deepEqual(await unavailable("fixture", "web"), denied);
  assert.deepEqual(await unavailable("fixture", "canon"), denied);
  const store = atomicStore();
  assert.deepEqual(await createAiBudget(store, now, enabled)("", "web"), denied);
  assert.deepEqual(await createAiBudget(store, now, { ...enabled, OUTPUT_MODE: "export" })("fixture", "web"), denied);
  assert.equal(store.transactions.length, 0);
});
