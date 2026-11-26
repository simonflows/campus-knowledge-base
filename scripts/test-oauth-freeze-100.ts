import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";
import { GET as callback } from "../app/api/auth/yandex/callback/route";
import { POST as start } from "../app/api/auth/yandex/start/route";
import { docClient } from "../lib/db";
import { createYandexFlow, YANDEX_OAUTH_COOKIE } from "../lib/yandex-oauth";

function freeze(context: { after: (callback: () => void) => void }) {
  const previous = process.env.CANON_DEPLOY_FREEZE_WRITES;
  process.env.CANON_DEPLOY_FREEZE_WRITES = "true";
  context.after(() => {
    if (previous === undefined) delete process.env.CANON_DEPLOY_FREEZE_WRITES;
    else process.env.CANON_DEPLOY_FREEZE_WRITES = previous;
  });
}

test("release freeze treats the OAuth callback as a writer for GET and HEAD while readiness stays readable", context => {
  freeze(context);
  for (const method of ["GET", "HEAD", "POST"]) {
    const response = proxy(new NextRequest("https://canon.example.test/api/auth/yandex/callback", { method }));
    assert.equal(response.status, 503, method);
    assert.equal(response.headers.get("X-Canon-Deploy-Freeze"), "writes");
  }
  assert.equal(proxy(new NextRequest("https://canon.example.test/api/ready")).headers.get("x-middleware-next"), "1");
});

test("frozen OAuth route handlers do not consume flow, contact a provider or change cookies", async context => {
  freeze(context);
  context.mock.method(docClient, "send", () => assert.fail("Frozen login must not reach storage"));
  context.mock.method(globalThis, "fetch", () => assert.fail("Frozen login must not reach a provider"));
  const config = {
    clientId: "fixture-client", clientSecret: "fixture-client-secret",
    signingSecret: "synthetic-flow-signing-secret-for-freeze-check", basePath: "",
    origin: "https://canon.example.test", redirectUri: "https://canon.example.test/api/auth/yandex/callback",
  };
  const flow = createYandexFlow(config, "/knowledge");
  const url = new URL(config.redirectUri);
  url.searchParams.set("state", flow.authorizationUrl.searchParams.get("state")!);
  url.searchParams.set("code", "synthetic");
  for (const response of [
    await callback(new NextRequest(url, { headers: { Cookie: `${YANDEX_OAUTH_COOKIE}=${flow.cookie}` } })),
    await start(new NextRequest("https://canon.example.test/api/auth/yandex/start", { method: "POST" })),
  ]) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(response.headers.get("Set-Cookie"), null);
  }
});
