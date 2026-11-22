import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mock } from "node:test";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { qaPublicSourceCards, qaPublicSourceScenarios } from "./qa-public-source-fixtures";
import { requireFixtureDatabase } from "./qa-fixture";
import { installPilotFixture } from "./pilot-fixture";
import { docClient } from "../lib/db";
import { TableName } from "../lib/schema";
import { buildAnalyticsReport } from "../lib/analytics";
import { checkFactText } from "../lib/fact-check";
import { getCanonicalKnowledgeCards, getKnowledgeCardById } from "../lib/models";
import type { NextRequest } from "next/server";

async function main() {
  await requireFixtureDatabase();
  Object.assign(globalThis, { AsyncLocalStorage });
  const { NextRequest } = await import("next/server");
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external");
  const { SESSION_COOKIE, signSessionToken } = await import("../lib/auth-server");
  const { POST: moderate } = await import("../app/api/knowledge/cards/[id]/moderation/route");
  const { POST: createDraft } = await import("../app/api/editor/drafts/route");
  const { PATCH: editDraft } = await import("../app/api/editor/drafts/[id]/route");
  const fixture = installPilotFixture();
  const coordinator = fixture.account("demo-admin").id;
  const author = fixture.account("demo-pr-midis").id;
  const origin = "http://127.0.0.2:8080";
  process.env.CAMPUS_PUBLIC_ORIGIN = origin;
  process.env.YANDEX_DISK_OAUTH_TOKEN = "synthetic-public-cycle";
  process.env.YANDEX_DISK_ROOT_MODE = "app";

  const uploads = new Map<string, string>();
  const diskFetch = mock.method(globalThis, "fetch", async (input: string | URL, init: RequestInit) => {
    const url = new URL(input);
    if (url.origin === "https://cloud-api.yandex.net") {
      assert.equal(new Headers(init.headers).get("authorization"), "OAuth synthetic-public-cycle");
      const path = url.searchParams.get("path");
      assert.ok(path && path.startsWith("app:/"));
      if (url.pathname.endsWith("/resources/upload")) {
        return Response.json({ href: "https://uploader.disk.yandex.net/fixture?path=" + encodeURIComponent(path) });
      }
      assert.ok(url.pathname.endsWith("/resources"));
      assert.equal(init.method, "PUT");
      return new Response(null, { status: 201 });
    }
    assert.equal(url.origin, "https://uploader.disk.yandex.net");
    assert.equal(init.method, "PUT");
    assert.equal(new Headers(init.headers).has("authorization"), false);
    const path = url.searchParams.get("path");
    assert.ok(path);
    uploads.set(path, String(init.body));
    return new Response(null, { status: 201 });
  });

  function call<T>(
    path: string,
    method: "POST" | "PATCH",
    userId: string,
    body: unknown,
    handler: (request: NextRequest) => Promise<T>,
    observedVersion?: string,
  ) {
    const request = new NextRequest(origin + path, {
      method,
      headers: { Origin: origin, "Content-Type": "application/json", ...(observedVersion ? { "If-Match": observedVersion } : {}) },
      body: JSON.stringify(body),
    });
    const token = signSessionToken(userId);
    const cookies = { get: (name: string) => name === SESSION_COOKIE ? { name, value: token } : undefined };
    return workAsyncStorage.run({ route: path } as never, () =>
      workUnitAsyncStorage.run({ type: "request", phase: "render", cookies } as never,
        () => handler(request)),
    );
  }

  try {
    const sourceCard = qaPublicSourceCards["midis-kuka-2024-10-18"];
    const card = { ...sourceCard, id: `${sourceCard.id}-${randomUUID()}` };
    const context = { params: Promise.resolve({ id: card.id }) };
    await docClient.send(new PutCommand({
      TableName: TableName.KNOWLEDGE_CARDS,
      Item: card,
      ConditionExpression: "attribute_not_exists(id)",
    }));
    assert.ok(!(await getCanonicalKnowledgeCards()).some(({ id }) => id === card.id));

    const moderationPath = `/api/knowledge/cards/${card.id}/moderation`;
    assert.equal((await call(moderationPath, "POST", author, { action: "approve" },
      (request) => moderate(request, context))).status, 403);
    assert.equal(uploads.size, 0);
    assert.equal((await call(moderationPath, "POST", coordinator, { action: "approve" },
      (request) => moderate(request, context))).status, 428, "Approval must identify the reviewed card version");
    const approved = await call(moderationPath, "POST", coordinator, { action: "approve" },
      (request) => moderate(request, context), card.updatedAt);
    assert.equal(approved.status, 200);
    const storedCard = await getKnowledgeCardById(card.id);
    assert.equal(storedCard?.diskSync?.status, "synced");
    assert.ok(storedCard);
    const scenario = qaPublicSourceScenarios.kukaPlacement;
    assert.ok(checkFactText(scenario.correctText, [storedCard]).findings.some(
      (finding) => finding.level === "green" && finding.sourceCardId === card.id,
    ));
    assert.ok(checkFactText(scenario.incorrectText, [storedCard]).findings.some(
      (finding) => finding.level === "red" && finding.sourceCardId === card.id,
    ));
    const report = buildAnalyticsReport(scenario.analyticsQuery, await getCanonicalKnowledgeCards());
    assert.ok(report.cards.some((row) => row.id === card.id && row.sourceHref.includes(card.id)));

    const headline = "Робот KUKA в Центре промышленного дизайна МИДиС";
    const draft = await call("/api/editor/drafts", "POST", author, {
      content: {
        universityId: "midis",
        title: headline,
        lead: scenario.correctText,
        sections: [{
          id: "source",
          heading: "Что показал МИДиС",
          level: 2,
          chunks: [{ id: "source-text", content: scenario.correctText }],
        }],
        sourceCardIds: [card.id],
      },
    }, createDraft);
    assert.equal(draft.status, 201);
    const document = await draft.json();
    const draftPath = `/api/editor/drafts/${document.id}`;
    const articleContext = { params: Promise.resolve({ id: document.id }) };
    const submit = await call(draftPath, "PATCH", author, {
      action: "submit", version: document.version, revisionId: document.revisionId, comment: "",
    }, (request) => editDraft(request, articleContext));
    assert.equal(submit.status, 200);
    assert.equal([...uploads.values()].some((content) => content.includes(headline)), false);
    const submitted = (await submit.json()).document;
    const publication = await call(draftPath, "PATCH", coordinator, {
      action: "approve", version: submitted.version, revisionId: submitted.revisionId, comment: "",
    }, (request) => editDraft(request, articleContext));
    assert.equal(publication.status, 200);
    const article = (await publication.json()).publication;
    assert.equal(article.diskSync.status, "synced");
    assert.deepEqual(article.sourceCardIds, [card.id]);

    for (const [info, folder, expected] of [
      [storedCard.diskSync, "/Инфраструктура_и_лаборатории/", card.id],
      [article.diskSync, "/Готовые_статьи/", headline],
    ] as const) {
      const file = uploads.get("app:/" + info.filePath);
      const csv = uploads.get("app:/" + info.summaryPath);
      assert.ok(info.filePath.includes("/МИДиС" + folder));
      assert.ok(file?.includes(expected));
      assert.ok(csv?.includes(info.filePath));
    }
    console.log("PASS: published MIDIS source, draft and moderator permissions, red/green, analytics source, article approval, both automatic MD/CSV exports (mock Disk)");
  } finally {
    diskFetch.mock.restore();
    delete process.env.YANDEX_DISK_OAUTH_TOKEN;
    delete process.env.YANDEX_DISK_ROOT_MODE;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
