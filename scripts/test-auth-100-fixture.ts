import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { getDemoAccount, toSessionUser } from "../lib/auth";
import { createAccountService, type AccountMessage } from "../lib/account-service";
import { dynamoAccountStore, listAccountStaff } from "../lib/account-storage";
import { requireFixtureDatabase } from "./qa-fixture";

test("the isolated Document API persists accounts, sessions, staff scopes and rate limits", {
  skip: process.env.CAMPUS_QA_DISPOSABLE !== "yes",
}, async () => {
  await requireFixtureDatabase();
  const email = "qa-" + randomUUID() + "@example.test";
  const now = Math.floor(Date.now() / 1000);
  const messages: AccountMessage[] = [];
  const account = createAccountService(dynamoAccountStore, () => now, async message => { messages.push(message); });
  const password = "Disposable Document API fixture account password";
  const newPassword = "Disposable Document API replacement password";

  const limit = [{ id: "qa-limit-" + randomUUID(), limit: 1, expiresAt: now + 60 }];
  assert.equal(await dynamoAccountStore.consumeRate(limit), true);
  assert.equal(await dynamoAccountStore.consumeRate(limit), false);
  await account.startSignup(email);
  await account.startSignup(email.toUpperCase());
  assert.equal(messages.length, 1);
  await account.finishSignup(messages[0].token, { name: "QA автор", password });
  const opened = await account.login(email, password);
  assert.equal((await account.resolveSession(opened.token))?.role, "author");
  assert.ok(!(await listAccountStaff()).some(user => user.id === opened.user.id));

  await account.startReset(email);
  await account.finishReset(messages[1].token, newPassword);
  await assert.rejects(account.finishReset(messages[1].token, newPassword), { status: 400 });
  assert.equal(await account.resolveSession(opened.token), null);
  const resumed = await account.login(email, newPassword);
  assert.equal(resumed.user.id, opened.user.id);

  const coordinator = toSessionUser(getDemoAccount("demo-admin")!);
  const chosen = await account.findForGrant(coordinator, resumed.user.id);
  await account.grantRoleById(coordinator, chosen.id, chosen.revision, { role: "university_pr", universityId: "midis" });
  assert.equal(await account.resolveSession(resumed.token), null);
  const scoped = await account.login(email, newPassword);
  assert.equal(scoped.user.universityId, "midis");
  assert.ok((await listAccountStaff()).some(user => user.id === scoped.user.id && user.role === "university_pr"));
  await account.logout(scoped.token);
  assert.equal(await account.resolveSession(scoped.token), null);

  const state = randomBytes(32).toString("base64url");
  assert.equal(await account.consumeYandexFlow(state, now + 60), true);
  assert.equal(await account.consumeYandexFlow(state, now + 60), false);
  const yandex = await account.loginYandex({ subject: "fixture-" + randomUUID(), name: "QA Яндекс", email });
  assert.notEqual(yandex.user.id, scoped.user.id);
  assert.equal((await account.resolveSession(yandex.token, ["yandex"]))?.role, "author");
  const selected = await account.findForGrant(coordinator, yandex.user.id);
  await account.grantRoleById(coordinator, selected.id, selected.revision, { role: "university_pr", universityId: "midis" });
  assert.ok((await listAccountStaff(["yandex"])).some(user => user.id === selected.id));
  assert.ok(!(await listAccountStaff(["password"])).some(user => user.id === selected.id));
  assert.equal(await account.resolveSession(yandex.token), null);
});
