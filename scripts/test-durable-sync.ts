import assert from "node:assert/strict";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, resetDbAvailableCache } from "../lib/db";
import { knowledgeSeedCards, type KnowledgeCard } from "../lib/knowledge";
import { articleSeed, type ReadyArticle } from "../lib/articles";
import { TableName } from "../lib/schema";
import { knowledgeCardInputSchema } from "../lib/validation/knowledge";
import { createPendingDiskSync, type DiskRegistry } from "../lib/disk-sync";
import { getAllKnowledgeCards, setArticleDiskSync, updateKnowledgeCard, setKnowledgeCardModeration } from "../lib/models";
import {
  retryKnowledgeCardSync,
  syncKnowledgeCardRecord,
  syncArticleRecord,
} from "../lib/disk-sync-service";

async function main() {
  process.env.DOCUMENT_API_ENDPOINT = "http://127.0.0.1:8000";
  process.env.USE_DATABASE = "true";
  process.env.YANDEX_DISK_OAUTH_TOKEN = "fake-transport-only";
  const initial = {
    ...structuredClone(
      knowledgeSeedCards.find((card) => card.type === "university")!
    ),
    id: "fixture-durable-card",
  };
  let currentCard: KnowledgeCard = initial;
  let currentArticle: ReadyArticle = {
    ...structuredClone(articleSeed[0]),
    id: "fixture-durable-article",
    approval: {
      revisionId: "fixture-revision-a",
      approvedAt: "2026-11-20T00:00:00Z",
      approvedBy: "fixture-reviewer",
    },
  };
  let failCsv = true;
  let changeDuringUpload = false;
  let commentDuringUpload = false;
  const concurrentRequest = {
    id: "request-fixture", authorId: "fixture", authorName: "Fixture", authorRole: "staff",
    authorOrganization: "Fixture", message: "Уточнить источник", createdAt: initial.updatedAt, status: "open" as const,
  };
  let expectedRecoveryFile: string | null = null;
  let sawSecondPage = false;
  let failScan = false;
  let finishConcurrentExport = false;
  let expectBoundedDatabaseWork = false;
  const registries = new Map<string, DiskRegistry>();
  const originalSend = docClient.send;
  const originalFetch = globalThis.fetch;
  const rejectStale = () => {
    throw Object.assign(new Error("Simulated conditional conflict"), {
      name: "ConditionalCheckFailedException",
    });
  };
  docClient.send = (async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
    if (command instanceof ListTablesCommand) return { TableNames: [] };
    if (command instanceof GetCommand) {
      if (command.input.TableName === TableName.WORKFLOW_RECORDS) {
        assert.equal(command.input.ConsistentRead, true);
        assert.ok(options?.abortSignal);
        return { Item: registries.get(command.input.Key?.id) };
      }
      if (command.input.ProjectionExpression?.includes("diskSync.sourceUpdatedAt")) {
        assert.equal(command.input.ConsistentRead, true);
        assert.ok(options?.abortSignal);
      }
      return {
        Item:
          command.input.TableName === TableName.ARTICLES
            ? currentArticle
            : currentCard,
      };
    }
    if (command instanceof ScanCommand) {
      if (expectBoundedDatabaseWork) assert.ok(options?.abortSignal, "Each export scan has an abort signal");
      if (failScan) throw new Error("Fixture database read error");
      if (command.input.TableName === TableName.KNOWLEDGE_CARDS) {
        if (command.input.ExclusiveStartKey) {
          sawSecondPage = true;
          return { Items: [], LastEvaluatedKey: undefined };
        }
        return {
          Items: [currentCard],
          LastEvaluatedKey: { id: currentCard.id },
        };
      }
      if (command.input.TableName === TableName.ARTICLES)
        return { Items: [currentArticle] };
      return { Items: [] };
    }
    if (command instanceof PutCommand) {
      if (finishConcurrentExport) {
        currentCard = { ...currentCard, diskSync: { ...currentCard.diskSync!, status: "synced", filePath: "new-export.md" } };
        finishConcurrentExport = false;
      }
      const values = command.input.ExpressionAttributeValues!;
      if (command.input.ConditionExpression?.includes("diskSync.#syncStatus") && values[":syncStatus"] !== currentCard.diskSync?.status) rejectStale();
      currentCard = command.input.Item as KnowledgeCard;
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      const [source, registry] = command.input.TransactItems ?? [];
      assert.ok(source?.Update && registry?.Put);
      assert.equal(registry.Put.TableName, TableName.WORKFLOW_RECORDS);
      const record = registry.Put.Item as DiskRegistry;
      const prior = registries.get(record.id);
      if (prior?.versionId !== registry.Put.ExpressionAttributeValues?.[":expected"]) rejectStale();
      await docClient.send(new UpdateCommand(source.Update), options);
      registries.set(record.id, record);
      return {};
    }
    assert.ok(command instanceof UpdateCommand);
    const input = command.input;
    const values = input.ExpressionAttributeValues!;
    if (expectBoundedDatabaseWork) assert.ok(options?.abortSignal, "Each export state write has its own abort signal");
    assert.ok(input.ConditionExpression?.includes("updatedAt = :version"));
    const isArticle = input.TableName === TableName.ARTICLES;
    const current = isArticle ? currentArticle : currentCard;
    if (values[":source"] && (current.diskSync?.sourceUpdatedAt !== values[":source"] || current.diskSync?.status !== values[":pending"])) rejectStale();
    if (input.ConditionExpression?.includes("attribute_not_exists(diskSync)") && current.diskSync) rejectStale();
    if (input.ConditionExpression?.includes("diskSync.#syncStatus = :syncStatus") && values[":syncStatus"] !== current.diskSync?.status) rejectStale();
    if (input.ConditionExpression?.includes("diskSync.attemptId = :observedAttempt") && values[":observedAttempt"] !== current.diskSync?.attemptId) rejectStale();
    if (input.ConditionExpression?.includes("attribute_not_exists(diskSync.attemptId)") && current.diskSync?.attemptId) rejectStale();
    if (
      values[":version"] !== current.updatedAt ||
      (values[":attempt"] && values[":attempt"] !== current.diskSync?.attemptId)
    )
      rejectStale();
    if (isArticle) {
      assert.ok(
        input.ConditionExpression?.includes("approval.revisionId = :revision")
      );
      if (values[":revision"] !== currentArticle.approval?.revisionId)
        rejectStale();
      currentArticle = { ...currentArticle, diskSync: values[":diskSync"] };
    } else {
      assert.ok(input.ConditionExpression?.includes("#status = :approved"));
      if (currentCard.status && currentCard.status !== "approved")
        rejectStale();
      currentCard = { ...currentCard, diskSync: values[":diskSync"] };
      if (input.ReturnValues === "ALL_NEW") return { Attributes: currentCard };
    }
    return {};
  }) as typeof docClient.send;
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
    assert.equal(currentCard.diskSync?.status, "pending");
    assert.ok(currentCard.diskSync?.attemptId);
    if (expectedRecoveryFile) assert.equal(currentCard.diskSync?.lastSuccessfulExport?.filePath, expectedRecoveryFile);
    if (url.hostname === "cloud-api.yandex.net") {
      if (url.pathname.endsWith("/resources/upload"))
        return Response.json({
          href: `https://uploader.disk.yandex.net/fixture?path=${encodeURIComponent(url.searchParams.get("path")!)}`,
        });
      return new Response(null, { status: 201 });
    }
    assert.equal(init?.method, "PUT");
    const target = url.searchParams.get("path")!;
    if (commentDuringUpload && target.endsWith(".csv")) {
      commentDuringUpload = false;
      await setKnowledgeCardModeration(currentCard.id, { editRequests: [concurrentRequest] }, currentCard.updatedAt);
    }
    if (
      changeDuringUpload &&
      target.endsWith(".md") &&
      !target.endsWith("_КАК_ЧИТАТЬ_РЕЗЕРВ.md")
    ) {
      changeDuringUpload = false;
      currentCard = {
        ...currentCard,
        updatedAt: "2026-11-21T00:00:00Z",
        diskSync: { ...createPendingDiskSync(), attemptId: "newer-edit" },
      };
    }
    return new Response(null, {
      status: failCsv && target.endsWith(".csv") ? 503 : 201,
    });
  }) as typeof fetch;
  resetDbAvailableCache();
  try {
    await getAllKnowledgeCards();
    assert.equal(sawSecondPage, true);
    const obsoleteVersion = "2020-01-01T00:00:00Z";
    await assert.rejects(updateKnowledgeCard(initial.id, knowledgeCardInputSchema.parse(initial), undefined, obsoleteVersion), {
      name: "ConditionalCheckFailedException",
    });
    await assert.rejects(setKnowledgeCardModeration(initial.id, { editRequests: [] }, obsoleteVersion), {
      name: "ConditionalCheckFailedException",
    });
    expectBoundedDatabaseWork = true;
    await syncKnowledgeCardRecord(initial);
    assert.equal(currentCard.diskSync?.status, "failed");
    assert.equal(currentCard.diskSync?.fileUploaded, true);
    failCsv = false;
    await retryKnowledgeCardSync(initial.id);
    assert.equal(currentCard.diskSync?.status, "synced");
    await assert.rejects(syncKnowledgeCardRecord(initial), { name: "ConditionalCheckFailedException" });
    assert.equal(currentCard.diskSync?.status, "synced", "A stale start cannot erase a later successful export");
    expectedRecoveryFile = currentCard.diskSync!.filePath;
    failCsv = true;
    await retryKnowledgeCardSync(initial.id);
    assert.equal(currentCard.diskSync?.status, "failed");
    assert.equal(currentCard.diskSync?.lastSuccessfulExport?.filePath, expectedRecoveryFile);
    // A previous complete export is still on Disk when retrying the same immutable paths.
    assert.equal(currentCard.diskSync?.summaryUploaded, true);
    expectedRecoveryFile = null;
    failCsv = false;
    changeDuringUpload = true;
    await assert.rejects(syncKnowledgeCardRecord(currentCard), {
      name: "ConditionalCheckFailedException",
    });
    assert.equal(currentCard.diskSync?.status, "pending");
    assert.equal(currentCard.diskSync?.attemptId, "newer-edit");
    await retryKnowledgeCardSync(initial.id);
    assert.equal(currentCard.diskSync?.status, "synced");
    assert.equal(currentCard.diskSync?.sourceUpdatedAt, "2026-11-21T00:00:00Z");
    const beforeComment = currentCard.updatedAt;
    commentDuringUpload = true;
    const completed = await retryKnowledgeCardSync(initial.id);
    assert.notEqual(currentCard.updatedAt, beforeComment);
    assert.equal(currentCard.diskSync?.status, "synced");
    assert.equal(currentCard.diskSync?.sourceUpdatedAt, currentCard.updatedAt, "A comment during transfer preserves completion");
    assert.deepEqual(currentCard.editRequests, [concurrentRequest], "Transfer completion preserves the new comment");
    assert.equal(completed?.updatedAt, currentCard.updatedAt, "API returns the version actually updated");
    assert.equal(completed?.diskSync?.sourceUpdatedAt, currentCard.updatedAt);
    assert.deepEqual(completed?.editRequests, [concurrentRequest]);
    await setKnowledgeCardModeration(initial.id, { editRequests: [] }, currentCard.updatedAt);
    assert.equal(currentCard.diskSync?.sourceUpdatedAt, currentCard.updatedAt, "Comments retain the already-exported version");
    for (const action of [
      () => setKnowledgeCardModeration(initial.id, { editRequests: [] }, currentCard.updatedAt),
      () => updateKnowledgeCard(initial.id, knowledgeCardInputSchema.parse(currentCard), undefined, currentCard.updatedAt),
    ]) {
      currentCard = { ...currentCard, diskSync: { ...currentCard.diskSync!, status: "pending" } };
      finishConcurrentExport = true;
      await assert.rejects(action(), { name: "ConditionalCheckFailedException" });
      assert.equal(currentCard.diskSync?.filePath, "new-export.md");
    }
    failScan = true;
    await retryKnowledgeCardSync(initial.id);
    assert.equal(currentCard.diskSync?.status, "failed", "A failed preparation is persisted");
    failScan = false;
    expectBoundedDatabaseWork = false;
    await assert.rejects(
      setArticleDiskSync(
        currentArticle.id,
        createPendingDiskSync(),
        currentArticle.updatedAt,
        "wrong-approval-revision"
      ),
      { name: "ConditionalCheckFailedException" }
    );
    // Fetch assertion concerns the card; article requests must leave it unchanged.
    const cardState = currentCard;
    currentCard = {
      ...currentCard,
      diskSync: { ...createPendingDiskSync(), attemptId: "fixture-test" },
    };
    await syncArticleRecord(currentArticle);
    assert.equal(currentArticle.diskSync?.status, "synced");
    assert.equal(
      currentArticle.diskSync?.sourceRevisionId,
      "fixture-revision-a"
    );
    currentCard = cardState;
    console.log(
      "✓ Fake Dynamo: pagination, durable pending/partial states, safe retries, stale completion rejection, approved article revision guard"
    );
  } finally {
    docClient.send = originalSend;
    globalThis.fetch = originalFetch;
    resetDbAvailableCache();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
