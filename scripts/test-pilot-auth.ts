import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "../app/api/auth/session/route";
import { testIntegrationStatus } from "./test-integration-status";
import { getClientIp, verifySameOrigin, checkLoginRateLimit, clearLoginFailures, recordFailedLogin, SESSION_COOKIE, SESSION_LIFETIME_SECONDS, signSessionToken, verifySessionToken } from "../lib/auth-server";
import { demoAccounts, canEditCard } from "../lib/auth";
import { knowledgeSeedCards } from "../lib/knowledge";
import { canReadLegacyArticle } from "../lib/editorial-models";
import { publicArticle, articleSeed } from "../lib/articles";
import { pilotLoginReady } from "../lib/pilot-auth";
import { POST as createType } from "../app/api/knowledge/card-types/route";
import { PATCH as updateType, DELETE as deleteType } from "../app/api/knowledge/card-types/[id]/route";
import { POST as createEditRequest, PATCH as resolveEditRequest } from "../app/api/knowledge/cards/[id]/edit-requests/route";
import { installPilotFixture } from "./pilot-fixture";

async function main() {
  await testIntegrationStatus();
  Object.assign(process.env, { NODE_ENV: "production", CAMPUS_DEMO_LOGIN: "false", CAMPUS_PILOT_ACCOUNTS: "", SESSION_SECRET: "" });
  const request = (body: unknown) => new NextRequest("http://localhost:8080/api/auth/session", { method: "POST", headers: { Origin: "http://localhost:8080", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await POST(request({accountId:"demo-admin"}))).status, 503);
  process.env.CAMPUS_PUBLIC_ORIGIN = "https://campus.example";
  process.env.CAMPUS_TRUST_PROXY = "false";
  const internalUrl = "http://internal.example:8080/api";
  const foreign = new NextRequest(internalUrl, { method: "POST", headers: {
    Origin: "https://other.example", "X-Forwarded-Host": "other.example", "X-Forwarded-For": "192.0.2.10",
  } });
  assert.equal(getClientIp(foreign), null);
  process.env.CAMPUS_TRUST_PROXY = "true";
  assert.equal(getClientIp(foreign), "192.0.2.10");
  const context = { params: Promise.resolve({ id: "fixture-id" }) };
  assert.equal((await createType(foreign)).status, 403);
  for (const handler of [updateType, deleteType, createEditRequest, resolveEditRequest]) {
    assert.equal((await handler(foreign, context)).status, 403);
  }
  const source = (origin: string) => new Request(internalUrl, { headers: { Origin: origin } });
  assert.equal(verifySameOrigin(source("https://campus.example")), true);
  assert.equal(verifySameOrigin(source("http://campus.example")), false);
  assert.equal(verifySameOrigin(new Request(internalUrl, { headers: { "Sec-Fetch-Site": "cross-site" } })), false);
  delete process.env.CAMPUS_PUBLIC_ORIGIN;
  delete process.env.CAMPUS_TRUST_PROXY;
  assert.equal(verifySameOrigin(foreign), false);
  const publication = publicArticle({ ...articleSeed[0], query: "Private brief", originalDraftId: "fixture-private" });
  assert.equal(publication.query, "");
  assert.equal(publication.originalDraftId, undefined);
  assert.equal(publication.diskSync, undefined);
  const fixture = installPilotFixture();
  assert.equal(pilotLoginReady(), true);
  for (const profile of demoAccounts) {
    const person = fixture.account(profile.id);
    assert.equal(person.role, profile.role);
    assert.equal(person.universityId, profile.universityId);
    assert.notEqual(person.id, profile.id);
  }
  const owner = fixture.account("demo-pr-midis");
  const key = fixture.keys.get("demo-pr-midis");
  assert.equal((await POST(request({ accountId: "qa-admin", accessKey: key }))).status, 401);
  assert.equal((await POST(request({ accountId: "demo-admin" }))).status, 401);
  const loggedIn = await POST(request({ accountId: "qa-pr-midis", accessKey: key, role: "admin" }));
  assert.equal(loggedIn.status, 200);
  assert.equal((await loggedIn.json()).user.role, "university_pr");
  const cookie = loggedIn.cookies.get(SESSION_COOKIE)!;
  assert.ok(cookie.secure && cookie.httpOnly && cookie.path === "/" && !cookie.domain);
  assert.equal(cookie.maxAge, SESSION_LIFETIME_SECONDS);
  const now = Date.now();
  const session = signSessionToken(owner.id, now);
  assert.equal(verifySessionToken(session, now), owner.id);
  assert.equal(verifySessionToken(session, now + SESSION_LIFETIME_SECONDS * 1000), null);
  assert.equal(canReadLegacyArticle(owner, articleSeed[0]), true);
  assert.equal(canReadLegacyArticle(fixture.account("demo-pr-csu"), articleSeed[0]), false);
  assert.equal(canReadLegacyArticle(null, articleSeed[0]), false);
  for (const card of knowledgeSeedCards.filter(card => card.type === "university")) {
    assert.ok(canEditCard(fixture.account("demo-owner-" + card.universityId), card));
  }
  const adminLogin = () => POST(request({ accountId: "qa-admin", accessKey: key }));
  for (let attempt = 1; attempt < 5; attempt++) assert.equal((await adminLogin()).status, 401);
  assert.equal((await POST(request({ accountId: "qa-pr-midis", accessKey: key }))).status, 200);
  const blocked = await adminLogin();
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("Retry-After")) > 0);
  // Additional distinct buckets must never reset an active lockout.
  for (let i = 0; i < 4100; i++) recordFailedLogin("fixture:" + i);
  assert.equal(checkLoginRateLimit("account:pilot-qa-admin").allowed, false);
  for (let i = 0; i < 4100; i++) clearLoginFailures("fixture:" + i);
  clearLoginFailures("overflow");
  const changed = fixture.rows.map(row => row.login === "qa-pr-midis" ? { ...row, keyHash: randomBytes(32).toString("hex") } : row);
  process.env.CAMPUS_PILOT_ACCOUNTS = JSON.stringify(changed);
  assert.equal(verifySessionToken(session), null);
  process.env.CAMPUS_PILOT_ACCOUNTS = "[]";
  assert.equal(verifySessionToken(session), null);
  process.env.CAMPUS_DEMO_LOGIN = "true";
  const demo = await POST(request({ accountId: "demo-pr-midis" }));
  assert.equal(demo.status, 200);
  const demoSession = demo.cookies.get(SESSION_COOKIE)!.value;
  assert.equal(verifySessionToken(demoSession), "demo-pr-midis");
  process.env.CAMPUS_DEMO_LOGIN = "false";
  assert.equal(verifySessionToken(demoSession), null);
  console.log("PASS production defaults, individual credentials, 7 universities, legacy ACL, 8h expiry, revocation, secure host cookie, explicit demo and origin checks on five mutations, scoped rate limits, public metadata and disabled production integration edits");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
