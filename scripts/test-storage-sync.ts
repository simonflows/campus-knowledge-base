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
  delete process.env.YANDEX_DISK_ROOT_MODE;
  let failSummary = false;
  let timeoutUpload = false;
  let deadline: AbortController | undefined;
  const requestSignals = new Set<AbortSignal | null | undefined>();
  const createdFolders: string[] = [];
  const requestedUploads: string[] = [];
  const uploadedPaths: string[] = [];
  const existingFolders = new Set<string>();
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
      assert.equal(new Headers(init?.headers).get("authorization"), "OAuth fixture-test-token");
      const path = url.searchParams.get("path");
      assert.ok(path);
      if (url.pathname.endsWith("/resources/upload")) {
        assert.equal(init?.method, "GET");
        assert.equal(url.searchParams.get("overwrite"), "true");
        requestedUploads.push(path);
        return Response.json({
          href: `https://uploader.disk.yandex.net/fixture?path=${encodeURIComponent(path)}`,
        });
      }
      assert.ok(url.pathname.endsWith("/resources"));
      assert.equal(init?.method, "PUT");
      createdFolders.push(path);
      const existed = existingFolders.has(path);
      existingFolders.add(path);
      return new Response(null, { status: existed ? 409 : 201 });
    }
    assert.equal(url.hostname, "uploader.disk.yandex.net");
    assert.equal(init?.method, "PUT");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
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

    const jointProject = knowledgeSeedCards.find(
      (item) => item.type === "project" && item.isJoint
    );
    assert.ok(jointProject?.type === "project");
    for (const root of ["disk:/", "app:/"]) {
      if (root === "app:/") process.env.YANDEX_DISK_ROOT_MODE = "app";
      createdFolders.length = 0;
      requestedUploads.length = 0;
      uploadedPaths.length = 0;

      const projectExport = await syncKnowledgeCardToDisk(jointProject, [
        jointProject,
      ]);
      const articleExport = await syncArticleToDisk(article, [article]);
      const repeatedExport = await syncKnowledgeCardToDisk(jointProject, [
        jointProject,
      ]);
      assert.equal(projectExport.status, "synced");
      assert.equal(articleExport.status, "synced");
      assert.equal(repeatedExport.status, "synced");
      assert.equal(
        projectExport.pointerPaths?.length,
        jointProject.participantUniversityIds.length
      );
      assert.equal(repeatedExport.filePath, projectExport.filePath);
      assert.equal(repeatedExport.summaryPath, projectExport.summaryPath);
      assert.deepEqual(repeatedExport.pointerPaths, projectExport.pointerPaths);

      const guidePath = "_КАК_ЧИТАТЬ_РЕЗЕРВ.md";
      const projectFiles = [
        guidePath,
        projectExport.filePath,
        ...(projectExport.pointerPaths ?? []),
        projectExport.summaryPath,
      ];
      const relativePaths = [
        ...projectFiles,
        guidePath,
        articleExport.filePath,
        articleExport.summaryPath,
        ...projectFiles,
      ];
      const expectedFolders = relativePaths.flatMap((path) => {
        assert.ok(path);
        const segments = path.split("/").slice(0, -1);
        return segments.map(
          (_, index) => root + segments.slice(0, index + 1).join("/")
        );
      });
      const expectedUploads = relativePaths.map((path) => root + path);
      assert.deepEqual(createdFolders, expectedFolders);
      assert.deepEqual(requestedUploads, expectedUploads);
      assert.deepEqual(uploadedPaths, expectedUploads);
    }
    console.log(
      "✓ Both Disk roots support directory creation, guide, Markdown, CSV and joint pointers on repeat export"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
