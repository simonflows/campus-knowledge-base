import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { articleSeed } from "../lib/articles";
import { docClient } from "../lib/db";
import { TableName } from "../lib/schema";
import { unzipSync, strFromU8 } from "fflate";
import { requireFixtureServer } from "./qa-fixture";
import assert from "node:assert/strict";
export async function runEditorialRoutes(credentials: (profile: string) => { accountId: string; accessKey?: string } = accountId => ({ accountId })) {
  const base = await requireFixtureServer();
  async function login(accountId: string) {
    const r = await fetch(`${base}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify(credentials(accountId)),
    });
    assert.equal(r.status, 200);
    return r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  }
  const owner = await login("demo-pr-midis"),
    other = await login("demo-pr-susu"),
    admin = await login("demo-admin");
  const call = (path: string, cookie: string, method = "GET", body?: unknown) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        Origin: base,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const legacy = { ...articleSeed[0], id: "qa-legacy-" + randomUUID(), universityId: "midis" };
  await docClient.send(new PutCommand({
    TableName: TableName.ARTICLES, Item: legacy, ConditionExpression: "attribute_not_exists(id)",
  }));
  const archivePath = "/api/articles/" + legacy.id;
  assert.equal((await call(archivePath, "")).status, 404);
  assert.equal((await call(archivePath, other)).status, 404);
  assert.equal((await (await call(archivePath, owner)).json()).legacy, true);
  assert.equal((await call(archivePath, admin)).status, 200);
  const importArchive = (cookie: string) => call("/api/editor/drafts", cookie, "POST", { legacyArticleId: legacy.id, content: { universityId: "midis" } });
  assert.equal((await importArchive(other)).status, 404);
  assert.equal((await importArchive(owner)).status, 201);
  assert.ok(!(await (await call("/api/articles", "")).json()).some((row: {id: string}) => row.id === legacy.id));
  assert.equal((await call("/api/editor/drafts", "")).status, 401);
  const created = await call("/api/editor/drafts", owner, "POST", {
    content: { universityId: "midis", title: "Проверка Word", lead: "Проверка абзаца", sections: [{ id: "qa", heading: "Глава", level: 2, chunks: [{ id: "c", content: "Текст тестовой редакции" }] }], sourceCardIds: ["project-midis-service-design"] },
  });
  assert.equal(created.status, 201);
  const doc = await created.json();
  assert.equal((await call(`/api/editor/drafts/${doc.id}`, other)).status, 404);
  assert.equal((await call(`/api/editor/drafts/${doc.id}`, admin)).status, 404);
  assert.equal(
    (
      await call(`/api/editor/drafts/${doc.id}`, owner, "PATCH", {
        action: "save",
        version: 999,
        content: { title: "stale" },
      })
    ).status,
    409
  );
  const download = await call(`/api/editor/drafts/${doc.id}/docx`, owner);
  assert.equal(download.status, 200);
  const bytes = new Uint8Array(await download.arrayBuffer());
  const zip = unzipSync(bytes);
  const xml = strFromU8(zip["word/document.xml"]);
  assert.match(xml, /Проверка Word/);
  assert.match(xml, /Текст тестовой редакции/);
  assert.match(xml, /w:hyperlink/);
  assert.match(strFromU8(zip["word/_rels/document.xml.rels"]), /knowledge\?card=project-midis-service-design/);
  assert.equal(
    (await call(`/api/editor/drafts/${doc.id}/docx`, other)).status,
    404
  );
  assert.equal((await call("/api/articles", owner, "POST", {})).status, 409);
  assert.equal((await call("/api/articles/any", owner, "PUT", {})).status, 409);
  console.log(
    "PASS: real routes authentication, ownership, private draft hiding, stale save409, DOCX XML title/body/source hyperlink, foreign DOCX denied, legacy archive detail/import scopes, old publication create/edit bypass blocked"
  );
}
if (process.argv[1]?.endsWith("test-editorial-routes.ts")) void runEditorialRoutes().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
