import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  type ScanCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import type { ReadyArticle } from "../lib/articles";
import type { SessionUser } from "../lib/auth";
import { docClient, resetDbAvailableCache } from "../lib/db";
import {
  EditorialError,
  editorialContentSchema,
  type EditorialDocument,
  type EditorialEvent,
  type EditorialRevision,
} from "../lib/editorial";
import * as models from "../lib/editorial-models";
import type { UniversityCard } from "../lib/knowledge";
import { TableName } from "../lib/schema";

const owner: SessionUser = {
  id: "editor-fixture",
  name: "Fixture Editor",
  role: "university_pr",
  organization: "Fixture",
  position: "Editor",
  universityId: "midis",
  ownershipLabel: "",
  ownerAliases: [],
  organizationAliases: [],
};
const reviewer: SessionUser = {
  ...owner,
  id: "reviewer-fixture",
  role: "university_owner",
};
const current = "2026-11-21T08:00:00.000Z";
const before = "2026-11-21T07:00:00.000Z";
const initialText = editorialContentSchema.parse({
  title: "Архивный текст",
  universityId: "midis",
});
const latestText = editorialContentSchema.parse({
  title: "Новая редакция",
  universityId: "midis",
});
const initialEvent: EditorialEvent = {
  id: "created-event",
  action: "created",
  revisionId: "older-revision",
  actorId: owner.id,
  actorName: owner.name,
  at: before,
  comment: "",
};
const submittedEvent: EditorialEvent = {
  ...initialEvent,
  id: "submitted-event",
  action: "submitted",
  revisionId: "current-revision",
  at: current,
};
const head: EditorialDocument = {
  id: "fixture-draft",
  ownerId: owner.id,
  ownerName: owner.name,
  originalId: "fixture-draft",
  channel: "Оригинал",
  version: 3,
  revisionId: "current-revision",
  submittedRevisionId: "current-revision",
  approvedRevisionId: null,
  status: "submitted",
  submittedOnce: true,
  reviewerId: reviewer.id,
  content: latestText,
  events: [submittedEvent],
  createdAt: before,
  updatedAt: current,
};
const olderRevision: EditorialRevision = {
  id: "older-revision",
  documentId: head.id,
  number: 1,
  content: initialText,
  actorId: owner.id,
  actorName: owner.name,
  createdAt: before,
};
const currentRevision: EditorialRevision = {
  ...olderRevision,
  id: "current-revision",
  number: 2,
  content: latestText,
  createdAt: current,
};
const futureRevision = { ...currentRevision, id: "future-revision", number: 4 };
const foreignRevision = {
  ...olderRevision,
  id: "foreign-revision",
  documentId: "other-draft",
};
const eventRecord = (event: EditorialEvent, documentId = head.id) => ({
  id: event.id,
  documentId,
  kind: "event",
  event,
});

function fixture(
  context: TestContext,
  heads: EditorialDocument[] = [head],
  pages: NonNullable<ScanCommandOutput["Items"]>[] = [
    [
      eventRecord(initialEvent),
      eventRecord(submittedEvent),
      olderRevision,
      currentRevision,
      futureRevision,
      foreignRevision,
      eventRecord({ ...initialEvent, id: "foreign-event" }, "other-draft"),
    ],
  ],
  publication?: { article: ReadyArticle; source: UniversityCard; concurrentAttempt?: string }
) {
  process.env.USE_DATABASE = "true";
  process.env.DOCUMENT_API_ENDPOINT = "https://editorial.fixture.invalid";
  process.env.OUTPUT_MODE = "fixture";
  process.env.CAMPUS_LOCAL_DEMO = "false";
  process.env.CAMPUS_DEMO_LOGIN = "true";
  resetDbAvailableCache();
  const originalSend = docClient.send;
  context.after(() => {
    docClient.send = originalSend;
    resetDbAvailableCache();
  });
  const reads: GetCommand["input"][] = [];
  const scans: ScanCommand["input"][] = [];
  const writes: TransactWriteCommand["input"][] = [];
  let headIndex = 0;
  docClient.send = (async (command: unknown) => {
    if (command instanceof ListTablesCommand) return {};
    if (command instanceof GetCommand) {
      reads.push(command.input);
      if (command.input.TableName === TableName.ARTICLES) {
        assert.equal(command.input.ConsistentRead, true, "Read the current export before reapproval");
        assert.equal(command.input.Key?.id, publication?.article.id);
        return { Item: publication?.article };
      }
      assert.equal(command.input.ConsistentRead, true);
      if (command.input.TableName === TableName.EDITORIAL_DOCUMENTS) {
        assert.equal(command.input.Key?.id, head.id);
        return { Item: heads[Math.min(headIndex++, heads.length - 1)] };
      }
      assert.equal(command.input.TableName, TableName.EDITORIAL_REVISIONS);
      return {
        Item: pages.flat().find(({ id }) => id === command.input.Key?.id),
      };
    }
    if (command instanceof ScanCommand) {
      if (command.input.TableName === TableName.KNOWLEDGE_CARDS && publication)
        return { Items: [publication.source] };
      scans.push(command.input);
      assert.equal(command.input.ConsistentRead, true);
      assert.equal(command.input.TableName, TableName.EDITORIAL_REVISIONS);
      const index = Number(command.input.ExclusiveStartKey?.page ?? 0);
      return {
        Items: pages[index],
        LastEvaluatedKey:
          index + 1 < pages.length ? { page: index + 1 } : undefined,
      };
    }
    if (command instanceof TransactWriteCommand) {
      const put = command.input.TransactItems?.at(-1)?.Put;
      if (publication?.concurrentAttempt && put?.TableName === TableName.ARTICLES) {
        const condition = put.ConditionExpression ?? "";
        if (condition.includes("attribute_not_exists(diskSync.attemptId)") ||
            (condition.includes("diskSync.attemptId = :observedAttempt") &&
              put.ExpressionAttributeValues?.[":observedAttempt"] !== publication.concurrentAttempt)) {
          throw Object.assign(new Error("Fixture export changed after read"), { name: "TransactionCanceledException" });
        }
      }
      writes.push(command.input);
      return {};
    }
    assert.fail(
      "Only controlled read and write commands are allowed by the fixture"
    );
  }) as typeof docClient.send;

  return { reads, scans, writes };
}

const errorStatus = (status: number) => (error: unknown) =>
  error instanceof EditorialError && error.status === status;

test("restoring an immutable revision performs one event scan and one revision Get", async (context) => {
  const { reads, scans, writes } = fixture(context);
  const result = await models.mutateEditorial(head.id, owner, {
    action: "restore",
    version: head.version,
    revisionId: olderRevision.id,
  });
  assert.deepEqual(result.document.content, initialText);
  assert.deepEqual(result.document.events.slice(0, -1), [
    initialEvent,
    submittedEvent,
  ]);
  assert.equal(
    scans.length,
    1,
    "reading a known revision must not scan its history a second time"
  );
  assert.deepEqual(
    reads.filter(
      ({ TableName: table }) => table === TableName.EDITORIAL_REVISIONS
    ),
    [
      {
        TableName: TableName.EDITORIAL_REVISIONS,
        Key: { id: olderRevision.id },
        ConsistentRead: true,
      },
    ]
  );
  assert.equal(
    writes[0].TransactItems?.[0].Put?.ConditionExpression,
    "#version = :version"
  );
  assert.equal(
    writes[0].TransactItems?.[0].Put?.ExpressionAttributeValues?.[":version"],
    head.version
  );
});

test("mutations reject missing, future, foreign, event, and private revision records", async (context) => {
  const { writes } = fixture(context);
  for (const revisionId of [
    "missing-revision",
    futureRevision.id,
    foreignRevision.id,
    initialEvent.id,
  ]) {
    await assert.rejects(
      models.mutateEditorial(head.id, owner, {
        action: "restore",
        version: head.version,
        revisionId,
      }),
      errorStatus(404)
    );
  }
  await assert.rejects(
    models.mutateEditorial(head.id, reviewer, {
      action: "comment",
      version: head.version,
      revisionId: olderRevision.id,
      comment: "Проверено",
    }),
    errorStatus(404)
  );
  assert.equal(writes.length, 0);
});

test("event and revision reads send document-specific filters and keep local access checks", async (context) => {
  const { scans } = fixture(context);
  assert.deepEqual((await models.getEditorial(head.id, owner)).events, [
    initialEvent,
    submittedEvent,
  ]);
  assert.deepEqual(await models.getEditorialRevisions(head, owner), [
    currentRevision,
    olderRevision,
  ]);
  assert.deepEqual(await models.getEditorialRevisions(head, reviewer), [
    currentRevision,
  ]);
  assert.equal(scans.length, 3);
  for (const { FilterExpression, ExpressionAttributeValues } of scans) {
    assert.match(FilterExpression ?? "", /#documentId = :documentId/);
    assert.equal(ExpressionAttributeValues?.[":documentId"], head.id);
  }
  assert.match(scans[0].FilterExpression ?? "", /#kind = :event/);
  assert.match(
    scans[1].FilterExpression ?? "",
    /attribute_not_exists\(#kind\)/
  );
  assert.match(scans[2].FilterExpression ?? "", /#id = :submittedRevisionId/);
});

test("reading document details needs one paginated history pass per stable head", async (context) => {
  const outdated = {
    ...head,
    version: 1,
    revisionId: olderRevision.id,
    content: initialText,
  };
  const { reads, scans } = fixture(
    context,
    [outdated, head, head],
    [
      [],
      [
        olderRevision,
        currentRevision,
        futureRevision,
        foreignRevision,
        eventRecord(initialEvent),
      ],
    ]
  );
  const result = await models.getEditorialWithRevisions(head.id, reviewer);
  assert.deepEqual(result.document, {
    ...head,
    events: [initialEvent, submittedEvent],
  });
  assert.deepEqual(result.revisions, [currentRevision]);
  assert.equal(reads.length, 3);
  assert.deepEqual(
    scans.map(({ ExclusiveStartKey }) => ExclusiveStartKey),
    [undefined, { page: 1 }, undefined, { page: 1 }]
  );
  assert.deepEqual(
    scans.map((scan) => scan.ExpressionAttributeValues?.[":version"]),
    [1, 1, 3, 3]
  );
});

test("reapproval carries forward the previous successful disk export", async (context) => {
  const admin: SessionUser = { ...reviewer, id: "demo-admin", role: "admin" };
  const source: UniversityCard = {
    id: "approved-source",
    type: "university",
    title: "Образовательные программы",
    folderId: "01_universities/midis",
    owners: [],
    universityId: "midis",
    structuredMetrics: [],
    referenceDescription: "Доступны образовательные программы.",
    stopFormula: "",
    createdAt: before,
    updatedAt: current,
  };
  const content = editorialContentSchema.parse({
    universityId: "midis",
    title: source.title,
    lead: source.referenceDescription,
    sections: [
      {
        id: "section",
        heading: "Программы",
        level: 2,
        chunks: [{ id: "chunk", content: source.referenceDescription }],
      },
    ],
    sourceCardIds: [source.id],
  });
  const published: ReadyArticle = {
    ...content,
    id: head.id,
    createdAt: before,
    updatedAt: before,
    approval: {
      revisionId: olderRevision.id,
      approvedBy: admin.id,
      approvedAt: before,
    },
    diskSync: {
      status: "synced",
      lastAttemptAt: before,
      lastSyncedAt: before,
      message: null,
      folderPath: "qa",
      filePath: "qa/version.md",
      summaryPath: "qa/summary.md",
      sourceRevisionId: olderRevision.id,
    },
  };
  const reapproval = {
    ...head,
    content,
    reviewerId: admin.id,
    approvedRevisionId: olderRevision.id,
  };
  const publication = { article: published, source, concurrentAttempt: "" };
  const { writes } = fixture(
    context,
    [reapproval],
    [[{ ...currentRevision, content }]],
    publication
  );
  const result = await models.mutateEditorial(head.id, admin, {
    action: "approve",
    revisionId: currentRevision.id,
    version: head.version,
    comment: "",
  });
  assert.deepEqual(result.publication?.diskSync?.lastSuccessfulExport, {
    syncedAt: before,
    filePath: "qa/version.md",
    summaryPath: "qa/summary.md",
    sourceRevisionId: olderRevision.id,
  });
  assert.equal(result.publication?.diskSync?.status, "pending");
  const condition = writes[0].TransactItems?.at(-1)?.Put?.ConditionExpression ?? "";
  assert.match(condition, /diskSync\.#syncStatus/);
  assert.match(condition, /attribute_not_exists\(diskSync\.attemptId\)/);
  assert.match(condition, /approval\.revisionId/);
  assert.deepEqual(
    writes[0].TransactItems?.at(-1)?.Put?.Item,
    result.publication
  );
  publication.concurrentAttempt = "new-upload-attempt";
  await assert.rejects(models.mutateEditorial(head.id, admin, {
    action: "approve", revisionId: currentRevision.id, version: head.version, comment: "",
  }), { status: 409 });
  assert.equal(writes.length, 1, "A new export between the read and transaction prevents reapproval");
});
