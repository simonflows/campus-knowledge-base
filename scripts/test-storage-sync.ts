import assert from "node:assert/strict";
import {
  isApprovedArticle,
  articleSeed,
  type ReadyArticle,
} from "../lib/articles";
import { resolveStorageMode } from "../lib/db";
import { parseLocalStore, LocalStoreRecoveryError } from "../lib/local-store";
import { knowledgeSeedCards, type UniversityCard } from "../lib/knowledge";
import {
  buildArticlesSummaryCsv,
  buildKnowledgeCardsSummaryCsv,
  buildKnowledgeCardMarkdown,
  syncKnowledgeCardToDisk,
  syncArticleToDisk,
} from "../lib/yandex-disk";

async function main() {
  assert.equal(
    resolveStorageMode({
      available: false,
      nodeEnv: "production",
      localDemo: "true",
    }),
    "read-only"
  );
  assert.equal(
    resolveStorageMode({ available: false, nodeEnv: "development" }),
    "read-only"
  );
  assert.equal(
    resolveStorageMode({
      available: false,
      nodeEnv: "development",
      localDemo: "true",
    }),
    "local-json"
  );
  assert.equal(
    resolveStorageMode({ available: true, nodeEnv: "production" }),
    "dynamodb"
  );
  console.log(
    "✓ Shared storage fails closed; local demo requires explicit choice"
  );
  const legacy = {
    seedVersion: 1,
    cards: [{ id: "saved-user-card", title: "Keep this data" }],
    articles: [],
  };
  assert.equal(
    parseLocalStore(JSON.stringify(legacy)).cards[0].id,
    "saved-user-card"
  );
  assert.throws(() => parseLocalStore("{broken"), LocalStoreRecoveryError);
  assert.throws(
    () => parseLocalStore(JSON.stringify({ ...legacy, seedVersion: 999 })),
    LocalStoreRecoveryError
  );
  console.log(
    "✓ Corrupt/unknown local format is rejected without replacing user data"
  );

  const card = structuredClone(
    knowledgeSeedCards.find(
      (item): item is UniversityCard => item.type === "university"
    )!
  );
  card.structuredMetrics = [
    {
      id: "fixture",
      label: "Fixture places",
      value: 120,
      unit: "мест",
      year: 2026,
      kind: "actual",
      evidenceUrl: "https://example.org/fixture-document",
      verifiedAt: "2026-11-20",
      owner: "Fixture owner",
    },
  ];
  const pending = {
    ...card,
    id: "pending-fixture",
    title: "PRIVATE-DRAFT-TITLE",
    status: "pending" as const,
  };
  assert.ok(
    !buildKnowledgeCardsSummaryCsv(card, [card, pending]).includes(
      "PRIVATE-DRAFT-TITLE"
    )
  );
  const oldPublished = {
    ...card,
    id: "old-published",
    title: "PUBLISHED-SNAPSHOT",
  };
  assert.ok(
    buildKnowledgeCardsSummaryCsv(card, [
      { ...pending, approvedSnapshot: oldPublished },
    ]).includes("PUBLISHED-SNAPSHOT")
  );
  assert.ok(
    buildKnowledgeCardMarkdown(card).includes(
      "https://example.org/fixture-document"
    )
  );
  assert.ok(buildKnowledgeCardMarkdown(card).includes("проверено: 2026-11-20"));
  assert.ok(
    buildKnowledgeCardsSummaryCsv(card, [
      { ...card, title: "=SUM(A1:A2)" },
    ]).includes("'=SUM(A1:A2)")
  );
  const article: ReadyArticle = {
    ...structuredClone(articleSeed[0]),
    approval: {
      revisionId: "fixture-revision",
      approvedAt: "2026-11-20T00:00:00Z",
      approvedBy: "fixture-reviewer",
    },
  };
  const unapproved = {
    ...article,
    id: "unapproved",
    title: "PRIVATE-ARTICLE-DRAFT",
    approval: undefined,
  };
  assert.equal(isApprovedArticle(unapproved), false);
  assert.ok(
    !buildArticlesSummaryCsv(article, [article, unapproved]).includes(
      "PRIVATE-ARTICLE-DRAFT"
    )
  );
  console.log(
    "✓ Export registries isolate drafts, preserve official snapshots and evidence fields"
  );

  const originalFetch = globalThis.fetch;
  // Only dummy test credentials are used; every request is intercepted locally.
  process.env.YANDEX_DISK_OAUTH_TOKEN = "fixture-test-token";
  let failSummary = false;
  let timeoutUpload = false;
  let deadline: AbortController | undefined;
  const requestSignals = new Set<AbortSignal | null | undefined>();
  const uploadedPaths: string[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    );
    requestSignals.add(init?.signal);
    init?.signal?.throwIfAborted();
    if (url.hostname === "cloud-api.yandex.net") {
      if (url.pathname.endsWith("/resources/upload"))
        return Response.json({
          href: `https://uploader.disk.yandex.net/fixture?path=${encodeURIComponent(url.searchParams.get("path") ?? "")}`,
        });
      return new Response(null, { status: 201 });
    }
    assert.equal(url.hostname, "uploader.disk.yandex.net");
    assert.equal(init?.method, "PUT");
    const target = url.searchParams.get("path")!;
    uploadedPaths.push(target);
    if (
      deadline &&
      target.endsWith(".md") &&
      !target.endsWith("_КАК_ЧИТАТЬ_РЕЗЕРВ.md")
    ) {
      deadline.abort(new DOMException("Fixture deadline", "TimeoutError"));
    }
    if (timeoutUpload)
      throw new DOMException("Simulated timeout", "TimeoutError");
    if (failSummary && target.endsWith(".csv"))
      return new Response(null, { status: 503 });
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  try {
    await assert.rejects(syncKnowledgeCardToDisk(pending, [pending]));
    await assert.rejects(syncArticleToDisk(unapproved, [unapproved]));
    assert.equal(uploadedPaths.length, 0);
    failSummary = true;
    requestSignals.clear();
    const partial = await syncKnowledgeCardToDisk(card, [card, pending]);
    assert.equal(
      requestSignals.size,
      1,
      "All Disk requests must share one attempt deadline"
    );
    assert.equal(partial.status, "failed");
    assert.equal(partial.fileUploaded, true);
    assert.equal(partial.summaryUploaded, false);
    failSummary = false;
    const retry = await syncKnowledgeCardToDisk(card, [card, pending]);
    assert.equal(retry.status, "synced");
    assert.equal(retry.filePath, partial.filePath);
    assert.equal(retry.summaryPath, partial.summaryPath);
    deadline = new AbortController();
    const nextVersion = {
      ...card,
      updatedAt: "2026-11-21T12:00:00Z",
      diskSync: retry,
    };
    const limited = await syncKnowledgeCardToDisk(
      nextVersion,
      [nextVersion],
      [],
      deadline.signal
    );
    assert.equal(limited.status, "failed");
    assert.equal(limited.fileUploaded, true);
    assert.equal(limited.summaryUploaded, false);
    assert.equal(limited.lastSuccessfulExport?.filePath, retry.filePath);
    assert.equal(limited.lastSuccessfulExport?.summaryPath, retry.summaryPath);
    assert.equal(limited.lastSyncedAt, retry.lastSyncedAt);
    deadline = undefined;
    const newer = await syncKnowledgeCardToDisk(
      {
        ...card,
        updatedAt: "2026-11-21T00:00:00Z",
        title: "Changed official card",
      },
      [
        {
          ...card,
          updatedAt: "2026-11-21T00:00:00Z",
          title: "Changed official card",
        },
      ]
    );
    assert.notEqual(newer.filePath, retry.filePath);
    assert.notEqual(newer.summaryPath, retry.summaryPath);
    timeoutUpload = true;
    const timedOut = await syncArticleToDisk(article, [article]);
    assert.equal(timedOut.status, "failed");
    assert.equal(timedOut.fileUploaded, false);
    timeoutUpload = false;
    const articleRetry = await syncArticleToDisk(article, [article]);
    assert.equal(articleRetry.status, "synced");
    assert.equal(articleRetry.filePath, timedOut.filePath);
    console.log(
      "✓ Fake transport: draft guards, partial CSV failure, timeout, safe retry and immutable version paths"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
