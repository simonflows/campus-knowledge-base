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
    admin = await login("demo-admin"),
    guest = await login("demo-guest");
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
  const generate = (cookie: string) =>
    call("/api/editor/generate", cookie, "POST", {
      query: "Подготовь материал о центре промышленного дизайна МИДиС",
      provider: "canonical",
    });
  assert.equal((await generate("")).status, 401);
  assert.equal((await generate(guest)).status, 403);
  assert.equal((await call("/api/editor/generate", guest, "POST", {})).status, 403);
  const generated = await generate(owner);
  assert.equal(generated.status, 200);
  const canonical = await generated.json();
  assert.equal(canonical.noData, false);
  assert.equal(canonical.providerMeta.provider, "canonical");
  assert.ok(canonical.article.title);
  assert.ok(canonical.sources.some((source: { id: string }) => source.id === "lab-midis-kuka"));
  for (const [endpoint, input] of [
    ["/api/fact-check", { text: "В лаборатории прошёл тестовый показ проекта." }],
    ["/api/analytics", { query: "Покажи лаборатории МИДиС" }],
  ] as const) {
    if (endpoint === "/api/analytics") {
      assert.equal((await call(endpoint, "", "POST", input)).status, 401);
      assert.equal((await call(endpoint, guest, "POST", input)).status, 403);
    }
    const standard = await call(endpoint, endpoint === "/api/analytics" ? owner : "", "POST", input);
    assert.equal(standard.status, 200);
    const local = await standard.json();
    assert.equal("flashAssist" in local, false);
    const assist = { ...input, flashAssist: true };
    assert.equal((await call(endpoint, "", "POST", assist)).status, 401);
    assert.equal((await call(endpoint, guest, "POST", assist)).status, 403);
    const allowed = await call(endpoint, owner, "POST", assist);
    assert.equal(allowed.status, 200);
    const { flashAssist, ...rest } = await allowed.json();
    assert.equal(flashAssist.status, "unavailable");
    assert.deepEqual(rest, local);
  }
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
  const draftPath = `/api/editor/drafts/${doc.id}`;
  assert.equal((await call(draftPath, "", "DELETE", { version: doc.version })).status, 401);
  assert.equal((await call(draftPath, other, "DELETE", { version: doc.version })).status, 404);
  assert.equal((await call(draftPath, admin, "DELETE", { version: doc.version })).status, 404);
  assert.equal((await call(draftPath, owner, "DELETE", {})).status, 400);
  assert.equal((await call(draftPath, owner, "DELETE", { version: doc.version + 1 })).status, 409);
  const crossOriginDelete = await fetch(base + draftPath, {
    method: "DELETE", headers: { Cookie: owner, "Content-Type": "application/json", Origin: "https://other.invalid" },
    body: JSON.stringify({ version: doc.version }),
  });
  assert.equal(crossOriginDelete.status, 403);
  assert.equal((await call(draftPath, owner, "DELETE", { version: doc.version })).status, 200);
  assert.equal((await call(draftPath, owner)).status, 404);
  assert.equal((await call(draftPath + "/docx", owner)).status, 404);
  assert.equal((await call(draftPath, owner, "DELETE", { version: doc.version })).status, 404);
  console.log("PASS: real HTTP own-draft deletion, anonymous/foreign/admin/cross-origin denied, stale409 and deleted404");
  console.log(
    "PASS: real routes authentication, ownership, private draft hiding, stale save409, DOCX XML title/body/source hyperlink, foreign DOCX denied, legacy archive detail/import scopes, old publication create/edit bypass blocked"
  );
}
if (process.argv[1]?.endsWith("test-editorial-routes.ts")) void runEditorialRoutes().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
