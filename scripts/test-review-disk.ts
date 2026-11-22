import assert from "node:assert/strict";
import { test } from "node:test";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { GetCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AlibabaAiError, callAlibabaAi } from "../lib/alibaba-ai";
import { articleSeed, type ReadyArticle } from "../lib/articles";
import { docClient, resetDbAvailableCache } from "../lib/db";
import { createPendingDiskSync, type DiskSyncInfo } from "../lib/disk-sync";
import { syncArticleRecord, syncKnowledgeCardRecord } from "../lib/disk-sync-service";
import { knowledgeSeedCards, type KnowledgeCard } from "../lib/knowledge";
import { TableName } from "../lib/schema";
import { buildArticlesSummaryCsv, buildKnowledgeCardsSummaryCsv } from "../lib/yandex-disk";

const initialVersion = "2026-11-20T00:00:00.000Z";
const newerVersion = "2026-11-21T00:00:00.000Z";
const card: KnowledgeCard = {
  ...structuredClone(knowledgeSeedCards[0]),
  id: "fixture-review-card",
  title: "Synthetic card",
  status: "approved",
  updatedAt: initialVersion,
};
const article: ReadyArticle = {
  ...structuredClone(articleSeed[0]),
  id: "fixture-review-article",
  title: "Synthetic article",
  updatedAt: initialVersion,
  approval: {
    revisionId: "fixture-reviewed-a",
    approvedAt: initialVersion,
    approvedBy: "fixture-reviewer",
  },
};

function uploadedThenFailed(filePath: string, revisionId?: string): DiskSyncInfo {
  const prior: DiskSyncInfo = {
    status: "synced",
    lastAttemptAt: initialVersion,
    lastSyncedAt: initialVersion,
    message: null,
    folderPath: "fixture",
    filePath,
    summaryPath: `${filePath}.csv`,
    sourceUpdatedAt: initialVersion,
    ...(revisionId && { sourceRevisionId: revisionId }),
    fileUploaded: true,
    summaryUploaded: true,
  };
  return {
    ...createPendingDiskSync(prior),
    status: "failed",
    sourceUpdatedAt: initialVersion,
    ...(revisionId && { sourceRevisionId: revisionId }),
  };
}

test("a failed card retry keeps the confirmed path in other CSV exports", () => {
  const cardWithBackup = {
    ...card,
    diskSync: uploadedThenFailed("fixture/card-already-uploaded.md"),
  };
  const cardsCsv = buildKnowledgeCardsSummaryCsv(
    { ...card, id: "fixture-other-card" },
    [cardWithBackup]
  );
  assert.match(cardsCsv, /"fixture\/card-already-uploaded\.md";"[^"]+";"Выгружена"/);
});

test("a failed article retry keeps the confirmed path only for its approved version", () => {
  const articleWithBackup = {
    ...article,
    diskSync: uploadedThenFailed("fixture/article-already-uploaded.md", article.approval!.revisionId),
  };
  const articlesCsv = buildArticlesSummaryCsv(
    { ...article, id: "fixture-other-article" },
    [articleWithBackup]
  );
  assert.match(articlesCsv, /"fixture\/article-already-uploaded\.md";"[^"]+";"Выгружена"/);
  const updatedArticle = {
    ...articleWithBackup,
    updatedAt: newerVersion,
    approval: { ...article.approval!, revisionId: "fixture-reviewed-b" },
  };
  assert.match(
    buildArticlesSummaryCsv({ ...article, id: "fixture-other-article" }, [updatedArticle]),
    /"Ожидает выгрузки"/
  );
});

test("an attempt cannot export when its scan sees a different approved version", async () => {
  Object.assign(process.env, {
    DOCUMENT_API_ENDPOINT: "https://dynamo.fixture.invalid",
    USE_DATABASE: "true",
    OUTPUT_MODE: "",
    CAMPUS_LOCAL_DEMO: "false",
    YANDEX_DISK_OAUTH_TOKEN: "fixture-test-token",
  });
  const originalSend = docClient.send;
  const originalFetch = globalThis.fetch;
  resetDbAvailableCache();
  let pendingWrites = 0;
  let diskRequests = 0;
  const change = () => Object.assign(new Error("Fixture source changed"), {
    name: "ConditionalCheckFailedException",
  });
  docClient.send = (async (command: unknown) => {
    if (command instanceof ListTablesCommand) return { TableNames: [] };
    if (command instanceof GetCommand) return { Item: { updatedAt: newerVersion } };
    if (command instanceof ScanCommand) {
      if (command.input.TableName === TableName.KNOWLEDGE_CARDS)
        return { Items: [{ ...card, updatedAt: newerVersion }] };
      if (command.input.TableName === TableName.ARTICLES)
        return { Items: [{
          ...article,
          updatedAt: newerVersion,
          approval: { ...article.approval!, revisionId: "fixture-reviewed-b" },
        }] };
      return { Items: [] };
    }
    if (command instanceof UpdateCommand) {
      if (!command.input.ExpressionAttributeValues?.[":attempt"]) {
        pendingWrites++;
        return {};
      }
      throw change();
    }
    throw new Error("Unexpected fake DynamoDB command");
  }) as typeof docClient.send;
  globalThis.fetch = async () => {
    diskRequests++;
    return new Response(null, { status: 503 });
  };
  try {
    await assert.rejects(syncKnowledgeCardRecord(card), { name: "ConditionalCheckFailedException" });
    await assert.rejects(syncArticleRecord(article), { name: "ConditionalCheckFailedException" });
    assert.equal(pendingWrites, 2);
    assert.equal(diskRequests, 0, "Observed source changes must stop before the first Disk request");
  } finally {
    globalThis.fetch = originalFetch;
    docClient.send = originalSend;
    resetDbAvailableCache();
  }
});

test("Alibaba rejects truncated and malformed completions with provider errors", async (t) => {
  Object.assign(process.env, {
    ALIBABA_DASHSCOPE_API_KEY: "fixture-test-key",
    ALIBABA_DASHSCOPE_BASE_URL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  });
  const originalFetch = globalThis.fetch;
  try {
    await t.test("rejects a truncated result", async () => {
      globalThis.fetch = async () => Response.json({
        choices: [{ finish_reason: "length", message: { content: "Partial response" } }],
      });
      await assert.rejects(callAlibabaAi("article"), AlibabaAiError);
    });
    await t.test("rejects non-string content", async () => {
      globalThis.fetch = async () => Response.json({
        choices: [{ finish_reason: "stop", message: { content: 42 } }],
      });
      await assert.rejects(callAlibabaAi("article"), AlibabaAiError);
    });
    globalThis.fetch = async () => Response.json({
      choices: [{ finish_reason: "stop", message: { content: " Completed " } }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    });
    assert.deepEqual(await callAlibabaAi("article"), {
      text: "Completed",
      usage: { inputTokens: 12, outputTokens: 4 },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
