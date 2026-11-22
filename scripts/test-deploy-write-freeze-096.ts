import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { NextRequest, NextResponse } from "next/server";

// Without a proxy, Next forwards API calls: this is the pre-feature behavior.
const loadGuard = async () =>
  existsSync(new URL("../proxy.ts", import.meta.url))
    ? (await import("../proxy")).proxy
    : () => NextResponse.next();

test("deployment freeze blocks API mutations without reading or disclosing their body", async () => {
  const guard = await loadGuard();
  const prior = process.env.CANON_DEPLOY_FREEZE_WRITES;
  process.env.CANON_DEPLOY_FREEZE_WRITES = "true";
  try {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = guard(
        new NextRequest("https://canon.invalid/api/knowledge/cards", {
          method,
          headers: {
            "Content-Type": "application/json",
            CANON_DEPLOY_FREEZE_WRITES: "false",
          },
          body: JSON.stringify({
            text: "private QA draft must not be reflected",
          }),
        })
      );
      assert.equal(response.status, 503, method);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("Retry-After"), "15");
      assert.equal(response.headers.get("X-Canon-Deploy-Freeze"), "writes");
      assert.doesNotMatch(await response.text(), /private QA/);
    }
  } finally {
    if (prior === undefined) delete process.env.CANON_DEPLOY_FREEZE_WRITES;
    else process.env.CANON_DEPLOY_FREEZE_WRITES = prior;
  }
});

test("readiness and reads remain available, and normal mode leaves all API behavior intact", async () => {
  const guard = await loadGuard();
  const prior = process.env.CANON_DEPLOY_FREEZE_WRITES;
  try {
    process.env.CANON_DEPLOY_FREEZE_WRITES = "true";
    for (const method of ["GET", "HEAD", "OPTIONS"])
      assert.equal(
        guard(
          new NextRequest("https://canon.invalid/api/ready", { method })
        ).headers.get("x-middleware-next"),
        "1"
      );
    delete process.env.CANON_DEPLOY_FREEZE_WRITES;
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"])
      assert.equal(
        guard(
          new NextRequest("https://canon.invalid/api/knowledge/cards", {
            method,
          })
        ).headers.get("x-middleware-next"),
        "1"
      );
  } finally {
    if (prior === undefined) delete process.env.CANON_DEPLOY_FREEZE_WRITES;
    else process.env.CANON_DEPLOY_FREEZE_WRITES = prior;
  }
});
