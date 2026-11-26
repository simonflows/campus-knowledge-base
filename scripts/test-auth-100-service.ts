import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountIdentity, AccountRateBucket, AccountSession, AccountStore } from "../lib/account-service";

function fixture() {
  const identities = new Map<string, AccountIdentity>();
  const sessions = new Map<string, AccountSession>();
  const counts = new Map<string, number>();
  function reserve(buckets: AccountRateBucket[]) {
    if (buckets.some(bucket => (counts.get(bucket.id) ?? 0) >= bucket.limit)) return false;
    for (const bucket of buckets) counts.set(bucket.id, (counts.get(bucket.id) ?? 0) + 1);
    return true;
  }
  const tokens: Array<{ email: string; purpose: "verify" | "reset"; token: string }> = [];
  let now = 1_800_000_000;
  const store: AccountStore = {
    async readIdentity(id) { return structuredClone(identities.get(id)); },
    async findIdentityId(userId) { return [...identities.values()].find(account => account.userId === userId)?.id; },
    async putIdentity(item, prior, mailBudget?: AccountRateBucket) {
      if ((identities.get(item.id)?.revision ?? null) !== prior) return false;
      if (mailBudget && !reserve([mailBudget])) return false;
      identities.set(item.id, structuredClone(item));
      return true;
    },
    async readSession(id) { return sessions.get(id); },
    async putSession(item) { sessions.set(item.id, item); },
    async deleteSession(id) { sessions.delete(id); },
    async consumeRate(buckets) { return reserve(buckets); },
  };
  return { store, identities, sessions, tokens, counts, now: () => now, advance: (seconds: number) => { now += seconds; } };
}

const pass = "Synthetic password with multiple words";
const newerPass = "A second synthetic account password";
const email = "test-account@example.test";
const input = { email, password: pass, name: "Тестовый автор" };

async function setup() {
  const { createAccountService } = await import("../lib/account-service");
  const data = fixture();
  const service = createAccountService(data.store, data.now, async (message) => { data.tokens.push(message); });
  return { ...data, service };
}

test("email proof creates exactly one author, rejects replays and never stores a raw password or token", async () => {
  const f = await setup();
  await Promise.all([
    f.service.startSignup(email),
    f.service.startSignup(email.toUpperCase()),
  ]);
  assert.equal(f.identities.size, 1);
  assert.equal(f.tokens.length, 1);
  await assert.rejects(f.service.login(email, pass), { status: 401 });
  const { token } = f.tokens[0];
  const outcomes = await Promise.allSettled([
    f.service.finishSignup(token, { name: input.name, password: pass }),
    f.service.finishSignup(token, { name: "Повторный автор", password: newerPass }),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === "rejected").length, 1);
  const stored = JSON.stringify([...f.identities.values()]);
  assert.equal(stored.includes(token), false);
  assert.equal(stored.includes(pass), false);
  assert.equal(stored.includes(newerPass), false);
  const password = outcomes[0].status === "fulfilled" ? pass : newerPass;
  const login = await f.service.login(email.toUpperCase(), password);
  assert.equal(login.user.role, "author");
  assert.equal(login.user.universityId, undefined);
});

test("reset enforces purpose and expiry, rotates password and ends active sessions", async () => {
  const f = await setup();
  await f.service.startSignup(email);
  await assert.rejects(f.service.finishReset(f.tokens[0].token, newerPass), { status: 400 });
  await f.service.finishSignup(f.tokens[0].token, input);
  const one = await f.service.login(email, pass);
  const two = await f.service.login(email, pass);
  assert.notEqual(one.token, two.token);
  await f.service.logout(two.token);
  assert.equal(await f.service.resolveSession(two.token), null);
  assert.equal((await f.service.resolveSession(one.token))?.id, one.user.id);
  await f.service.startReset(email);
  await assert.rejects(f.service.finishSignup(f.tokens[1].token, input), { status: 400 });
  f.advance(60 * 60);
  await assert.rejects(f.service.finishReset(f.tokens[1].token, newerPass), { status: 400 });
  await f.service.startReset(email);
  await f.service.finishReset(f.tokens[2].token, newerPass);
  await assert.rejects(f.service.finishReset(f.tokens[2].token, pass), { status: 400 });
  assert.equal(await f.service.resolveSession(one.token), null);
  await assert.rejects(f.service.login(email, pass), { status: 401 });
  const fresh = await f.service.login(email, newerPass);
  assert.equal(fresh.user.id, one.user.id);
  f.advance(8 * 60 * 60);
  assert.equal(await f.service.resolveSession(fresh.token), null);
});

test("role changes require a coordinator and scope and never inherit a pilot ID", async () => {
  const f = await setup();
  await f.service.startSignup(email);
  await f.service.finishSignup(f.tokens[0].token, input);
  const login = await f.service.login(email, pass);
  const coordinator = { ...login.user, id: "pilot-coordinator", role: "admin" } as const;
  const chosen = await f.service.findForGrant(coordinator, login.user.id);
  await assert.rejects(f.service.grantRoleById(login.user, chosen.id, chosen.revision, { role: "rio" }), { status: 403 });
  await assert.rejects(f.service.grantRoleById(coordinator, chosen.id, chosen.revision, { role: "university_pr" }), { status: 400 });
  await f.service.grantRoleById(coordinator, chosen.id, chosen.revision, { role: "university_pr", universityId: "midis" });
  assert.equal(await f.service.resolveSession(login.token), null);
  const staff = await f.service.login(email, pass);
  assert.equal(staff.user.role, "university_pr");
  assert.equal(staff.user.universityId, "midis");
  assert.equal(staff.user.id, login.user.id);
  assert.equal(staff.user.ownerAliases.length, 0);
  const confirmed = await f.service.findForGrant(coordinator, staff.user.id);
  await f.service.grantRoleById(coordinator, confirmed.id, confirmed.revision, { role: "author" });
  assert.equal(await f.service.resolveSession(staff.token), null);
  assert.equal((await f.service.login(email, pass)).user.role, "author");
});

test("email authentication fails closed on storage outage", async () => {
  const f = await setup();
  f.store.readIdentity = async () => { throw new Error("simulated outage"); };
  await assert.rejects(f.service.startSignup(email), { status: 503 });
  await assert.rejects(f.service.login(email, pass), { status: 503 });
  assert.equal(f.tokens.length, 0);
});

test("only issued proofs spend the shared daily email budget", async () => {
  const f = await setup();
  const quota = "mail-day:" + Math.floor(f.now() / 86400);
  for (let index = 0; index < 151; index++) {
    await f.service.startReset("absent-" + index + "@example.test");
  }
  assert.equal(f.counts.get(quota) ?? 0, 0);
  assert.equal(f.tokens.length, 0);

  await Promise.all([f.service.startSignup(email), f.service.startSignup(email.toUpperCase())]);
  await f.service.startSignup(email);
  assert.equal(f.tokens.length, 1);
  assert.equal(f.counts.get(quota), 1);

  await f.service.finishSignup(f.tokens[0].token, input);
  await f.service.startSignup(email);
  assert.equal(f.counts.get(quota), 1);
  await Promise.all([f.service.startReset(email), f.service.startReset(email)]);
  await f.service.startReset(email);
  assert.equal(f.tokens.length, 2);
  assert.equal(f.counts.get(quota), 2);

  f.counts.set(quota, 150);
  f.advance(61);
  await f.service.startReset(email);
  await f.service.startReset("still-absent@example.test");
  assert.equal(f.tokens.length, 2);
  assert.equal(f.counts.get(quota), 150);
  await f.service.finishReset(f.tokens[1].token, newerPass);
});

test("invalid proof attempts leave the mailbox owner's valid link usable", async () => {
  const f = await setup();
  await f.service.startSignup(email);
  const valid = f.tokens[0].token;
  const invalid = valid.slice(0, -1) + (valid.endsWith("a") ? "b" : "a");
  for (let attempt = 0; attempt < 12; attempt++) {
    await assert.rejects(f.service.finishSignup(invalid, input, "192.0.2.31"), { status: 400 });
  }
  await f.service.finishSignup(valid, input, "192.0.2.42");
  assert.equal((await f.service.login(email, pass)).user.role, "author");
});

test("Yandex identity is independent of a password account and keeps its identity when its contact email changes", async () => {
  const f = await setup();
  await f.service.startSignup(email);
  await f.service.finishSignup(f.tokens[0].token, input);
  const passwordUser = (await f.service.login(email, pass)).user;
  const first = await f.service.loginYandex({ subject: "yandex-fixture-1", name: "Автор через Яндекс", email });
  const again = await f.service.loginYandex({ subject: "yandex-fixture-1", name: "Автор через Яндекс", email: "changed@example.test" });
  const another = await f.service.loginYandex({ subject: "yandex-fixture-2", name: "Автор через Яндекс", email });
  assert.equal(f.identities.size, 3);
  assert.notEqual(first.user.id, passwordUser.id);
  assert.notEqual(first.user.id, another.user.id);
  assert.equal(first.user.id, again.user.id);
  assert.equal(again.user.role, "author");
  assert.equal(again.user.universityId, undefined);
  assert.equal((await f.service.resolveSession(first.token, ["yandex"]))?.id, first.user.id);
  assert.equal(await f.service.resolveSession(first.token, ["password"]), null);
  const coordinator = { ...passwordUser, id: "pilot-coordinator", role: "admin" } as const;
  const profile = await f.service.findForGrant(coordinator, again.user.id);
  assert.deepEqual(
    { id: profile.id, email: profile.email, provider: profile.provider },
    { id: first.user.id, email: "changed@example.test", provider: "yandex" },
  );
  await assert.rejects(f.service.findForGrant(first.user, again.user.id), { status: 403 });
  await f.service.loginYandex({ subject: "yandex-fixture-1", name: "Изменённое имя", email: "changed@example.test" });
  await assert.rejects(f.service.grantRoleById(coordinator, first.user.id, profile.revision, { role: "rio" }), { status: 409 });
  const fresh = await f.service.findForGrant(coordinator, again.user.id);
  await f.service.grantRoleById(coordinator, fresh.id, fresh.revision, { role: "university_pr", universityId: "midis" });
  assert.equal(await f.service.resolveSession(first.token), null);
  assert.equal((await f.service.loginYandex({ subject: "yandex-fixture-1", name: fresh.name })).user.role, "university_pr");
  assert.equal((await f.service.login(email, pass)).user.role, "author");
  const encoded = JSON.stringify([...f.identities.values()]);
  assert.equal(encoded.includes("yandex-fixture-1"), false);
  assert.equal(encoded.includes("yandex-fixture-2"), false);
});
