import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import {
  DeleteCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { articleSeed, type ReadyArticle } from "../lib/articles";
import { docClient } from "../lib/db";
import {
  readArticleDiskRegistry,
  readKnowledgeCardDiskRegistry,
  syncArticleRecord,
  syncKnowledgeCardRecord,
} from "../lib/disk-sync-service";
import {
  createCardType,
  createKnowledgeCard,
  deleteCardType,
  deleteKnowledgeCard,
  updateKnowledgeCard,
} from "../lib/models";
import { folderIds } from "../lib/knowledge";
import { getApprovedCardVersions } from "../lib/knowledge-versions";
import { TableName } from "../lib/schema";
import {
  diskRegistryId,
  getArticleDiskFolderSegments,
  getCardDiskFolderSegments,
} from "../lib/yandex-disk";
import { requireFixtureDatabase } from "./qa-fixture";

async function cardPair(context: TestContext) {
  await requireFixtureDatabase();
  const type = await createCardType({
    id: randomUUID(),
    name: "QA: реестр выгрузки",
    description: "",
    fields: [
      {
        id: "label",
        name: "Показатель",
        type: "shortText",
        required: true,
        options: [],
      },
    ],
  });
  const written: string[] = [];
  context.after(async () => {
    for (const id of written) {
      await deleteKnowledgeCard(id);
      for (const version of await getApprovedCardVersions(id)) {
        await docClient.send(
          new DeleteCommand({
            TableName: TableName.KNOWLEDGE_CARD_VERSIONS,
            Key: { id: version.id },
          })
        );
      }
    }
    await deleteCardType(type.id);
  });
  const data = (title: string) => ({
    type: "custom" as const,
    customTypeId: type.id,
    folderId: folderIds.customType(type.id),
    title,
    owners: ["QA"],
    referenceDescription: "",
    stopFormula: "",
    customFields: { label: "Синтетический" },
  });
  const create = async (title: string) => {
    const card = await createKnowledgeCard(data(title), { status: "approved" });
    written.push(card.id);
    return card;
  };
  const first = await create("QA: первая карточка");
  const second = await create("QA: старая цифра 11");
  return {
    data,
    first,
    second,
    cleanScope: () =>
      cleanRegistry(
        context,
        diskRegistryId("cards", getCardDiskFolderSegments(first))
      ),
  };
}

function cleanRegistry(context: TestContext, id: string) {
  context.after(async () => {
    await docClient.send(
      new DeleteCommand({ TableName: TableName.WORKFLOW_RECORDS, Key: { id } })
    );
  });
}

function diskFixture(
  context: TestContext,
  beforePut: (path: string, body: string) => Promise<number> = async () => 201
) {
  const files = new Map<string, string>();
  process.env.YANDEX_DISK_OAUTH_TOKEN = "synthetic-disk-race";
  process.env.YANDEX_DISK_ROOT_MODE = "app";
  context.after(() => {
    delete process.env.YANDEX_DISK_OAUTH_TOKEN;
    delete process.env.YANDEX_DISK_ROOT_MODE;
  });
  context.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL, init: RequestInit) => {
      const url = new URL(input);
      if (url.origin === "https://cloud-api.yandex.net") {
        const path = url.searchParams.get("path");
        assert.ok(path && path.startsWith("app:/"));
        if (url.pathname.endsWith("/upload")) {
          return Response.json({
            href:
              "https://uploader.disk.yandex.net/qa?path=" +
              encodeURIComponent(path.slice("app:/".length)),
          });
        }
        assert.equal(init.method, "PUT");
        return new Response(null, { status: 201 });
      }
      assert.equal(url.origin, "https://uploader.disk.yandex.net");
      assert.equal(init.method, "PUT");
      const path = url.searchParams.get("path")!;
      const body = String(init.body);
      const status = await beforePut(path, body);
      if (status < 300) files.set(path, body);
      return new Response(null, { status });
    }
  );
  return files;
}

test("a CSV delayed inside Disk upload cannot confirm an older folder snapshot", async (context) => {
  const { first, second, data, cleanScope } = await cardPair(context);
  const uploading = Promise.withResolvers<void>();
  const finishOld = Promise.withResolvers<void>();
  let delayed = false;
  let historicalCsv: string | undefined;
  const files = diskFixture(context, async (path) => {
    if (path.endsWith(".csv") && !delayed) {
      delayed = true;
      historicalCsv = path;
      uploading.resolve();
      await finishOld.promise;
    }
    return 201;
  });
  cleanScope();
  const older = syncKnowledgeCardRecord(first);
  try {
    await Promise.race([
      uploading.promise,
      older.then(() => assert.fail("Old upload never reached CSV")),
    ]);
    const newer = await updateKnowledgeCard(
      second.id,
      data("QA: новая цифра 77"),
      undefined,
      second.updatedAt
    );
    assert.ok(newer);
    const completed = await syncKnowledgeCardRecord(newer);
    assert.equal(completed.diskSync?.status, "synced");
    assert.match(
      files.get(completed.diskSync.summaryPath!) ?? "",
      /новая цифра 77/
    );
    assert.equal(
      (await readKnowledgeCardDiskRegistry(first))?.summaryPath,
      completed.diskSync.summaryPath
    );
  } finally {
    finishOld.resolve();
  }
  const result = await older;
  assert.equal(
    result.diskSync?.status,
    "synced",
    "A bounded retry should recover the current snapshot"
  );
  assert.notEqual(result.diskSync.summaryPath, historicalCsv);
  assert.match(files.get(historicalCsv!) ?? "", /старая цифра 11/);
  assert.match(files.get(result.diskSync.summaryPath!) ?? "", /новая цифра 77/);
  const published = await readKnowledgeCardDiskRegistry(first);
  assert.equal(published?.summaryPath, result.diskSync.summaryPath);
  assert.equal(published?.current, true);
});

test("another writer after the post-upload Scan can only publish through the registry CAS", async (context) => {
  const { first, second, data, cleanScope } = await cardPair(context);
  const files = diskFixture(context);
  cleanScope();
  const beforeCommit = Promise.withResolvers<void>();
  const finishOld = Promise.withResolvers<void>();
  const send = docClient.send.bind(docClient);
  let held = false;
  const wire = context.mock.method(
    docClient,
    "send",
    async (
      command: TransactWriteCommand,
      options?: { abortSignal?: AbortSignal }
    ) => {
      if (
        !held &&
        command instanceof TransactWriteCommand &&
        command.input.TransactItems?.some(
          (item) => item.Put?.TableName === TableName.WORKFLOW_RECORDS
        )
      ) {
        held = true;
        beforeCommit.resolve();
        await finishOld.promise;
      }
      return send(command, options);
    }
  );
  try {
    const older = syncKnowledgeCardRecord(first);
    try {
      await Promise.race([
        beforeCommit.promise,
        older.then(() => assert.fail("Old attempt never reached its commit")),
      ]);
      const newer = await updateKnowledgeCard(
        second.id,
        data("QA: изменено перед подтверждением"),
        undefined,
        second.updatedAt
      );
      assert.ok(newer);
      await syncKnowledgeCardRecord(newer);
    } finally {
      finishOld.resolve();
    }
    await older;
    const verified = await readKnowledgeCardDiskRegistry(first);
    assert.equal(verified?.current, true);
    assert.match(
      files.get(verified?.summaryPath ?? "") ?? "",
      /изменено перед подтверждением/
    );
  } finally {
    wire.mock.restore();
  }
});

test("a partial failure preserves the confirmed prior folder and material copy", async (context) => {
  const { first, second, data, cleanScope } = await cardPair(context);
  let failCsv = false;
  const files = diskFixture(context, async (path) =>
    failCsv && path.endsWith(".csv") ? 503 : 201
  );
  cleanScope();
  const full = await syncKnowledgeCardRecord(second);
  assert.equal(full.diskSync?.status, "synced");
  const last = full.diskSync.summaryPath!;
  assert.equal((await readKnowledgeCardDiskRegistry(first))?.current, true);

  const revision = await updateKnowledgeCard(
    second.id,
    data("QA: новый отчёт"),
    undefined,
    full.updatedAt
  );
  assert.ok(revision);
  const obsolete = await readKnowledgeCardDiskRegistry(first);
  assert.equal(
    obsolete?.current,
    false,
    "An edit without any newer registry takes the confirmed path out of date"
  );
  assert.equal(obsolete?.summaryPath, last);

  failCsv = true;
  const failed = await syncKnowledgeCardRecord(revision);
  assert.equal(failed.diskSync?.status, "failed");
  assert.equal(failed.diskSync?.fileUploaded, true);
  assert.equal(failed.diskSync?.lastSuccessfulExport?.summaryPath, last);
  assert.equal((await readKnowledgeCardDiskRegistry(first))?.summaryPath, last);
  assert.equal((await readKnowledgeCardDiskRegistry(first))?.current, false);
  assert.match(files.get(last) ?? "", /старая цифра 11/);
  assert.equal(files.has(failed.diskSync.summaryPath!), false);

  failCsv = false;
  const retried = await syncKnowledgeCardRecord(failed);
  const verified = await readKnowledgeCardDiskRegistry(first);
  assert.equal(verified?.current, true);
  assert.equal(verified?.summaryPath, retried.diskSync?.summaryPath);
  assert.match(files.get(verified.summaryPath) ?? "", /новый отчёт/);
});

test("reading the verified registry detects a source edit between final Scan and commit", async (context) => {
  const { first, second, data, cleanScope } = await cardPair(context);
  diskFixture(context);
  cleanScope();
  const send = docClient.send.bind(docClient);
  let edited = false;
  const wire = context.mock.method(
    docClient,
    "send",
    async (
      command: TransactWriteCommand,
      options?: { abortSignal?: AbortSignal }
    ) => {
      if (
        !edited &&
        command instanceof TransactWriteCommand &&
        command.input.TransactItems?.some(
          (item) => item.Put?.TableName === TableName.WORKFLOW_RECORDS
        )
      ) {
        edited = true;
        await updateKnowledgeCard(
          second.id,
          data("QA: запись после Scan"),
          undefined,
          second.updatedAt
        );
      }
      return send(command, options);
    }
  );
  try {
    const exported = await syncKnowledgeCardRecord(first);
    assert.equal(edited, true);
    assert.equal(exported.diskSync?.status, "synced");
    const seen = await readKnowledgeCardDiskRegistry(first);
    assert.equal(
      seen?.summaryPath,
      exported.diskSync.summaryPath,
      "The last full backup can still be read"
    );
    assert.equal(
      seen?.current,
      false,
      "Entity success does not make this folder's snapshot current"
    );
    const repaired = await syncKnowledgeCardRecord(exported);
    assert.notEqual(repaired.diskSync?.summaryPath, seen?.summaryPath);
    assert.equal((await readKnowledgeCardDiskRegistry(first))?.current, true);
  } finally {
    wire.mock.restore();
  }
});

test("persistent folder changes stop the automatic retry and keep the last complete pointer", async (context) => {
  const { first, second, data, cleanScope } = await cardPair(context);
  let changing = false;
  let other = second;
  let csvAttempts = 0;
  diskFixture(context, async (path) => {
    if (changing && path.endsWith(".csv")) {
      csvAttempts++;
      const revised = await updateKnowledgeCard(
        other.id,
        data("QA: изменение " + csvAttempts),
        undefined,
        other.updatedAt
      );
      assert.ok(revised);
      other = revised;
    }
    return 201;
  });
  cleanScope();
  await syncKnowledgeCardRecord(second);
  const full = await readKnowledgeCardDiskRegistry(first);
  changing = true;
  const pending = await syncKnowledgeCardRecord(first);
  assert.equal(csvAttempts, 2);
  assert.equal(pending.diskSync?.status, "pending");
  assert.match(pending.diskSync.message ?? "", /Повторите выгрузку/);
  const retained = await readKnowledgeCardDiskRegistry(first);
  assert.equal(retained?.summaryPath, full?.summaryPath);
  assert.equal(retained?.current, false);
});

test("a delayed article CSV also recovers the latest approved folder snapshot", async (context) => {
  await requireFixtureDatabase();
  const scope = "qa-disk-" + randomUUID();
  const put = (article: ReadyArticle) =>
    docClient.send(
      new PutCommand({ TableName: TableName.ARTICLES, Item: article })
    );
  const first: ReadyArticle = {
    ...articleSeed[0],
    id: scope + "-morning",
    universityId: scope,
    title: "QA: первая статья",
    approval: {
      approvedAt: articleSeed[0].createdAt,
      approvedBy: "QA",
      revisionId: "morning",
    },
  };
  const second: ReadyArticle = {
    ...first,
    id: scope + "-second",
    title: "QA: старый материал",
    approval: { ...first.approval!, revisionId: "edition-a" },
  };
  context.after(async () => {
    for (const id of [first.id, second.id])
      await docClient.send(
        new DeleteCommand({ TableName: TableName.ARTICLES, Key: { id } })
      );
  });
  await put(first);
  await put(second);
  const uploading = Promise.withResolvers<void>();
  const finishOld = Promise.withResolvers<void>();
  let oldPath: string | undefined;
  const files = diskFixture(context, async (path) => {
    if (!oldPath && path.endsWith(".csv")) {
      oldPath = path;
      uploading.resolve();
      await finishOld.promise;
    }
    return 201;
  });
  cleanRegistry(
    context,
    diskRegistryId("articles", getArticleDiskFolderSegments(first))
  );
  const old = syncArticleRecord(first);
  try {
    await Promise.race([
      uploading.promise,
      old.then(() => assert.fail("Old article never reached CSV")),
    ]);
    const current: ReadyArticle = {
      ...second,
      title: "QA: новый материал",
      updatedAt: new Date().toISOString(),
      approval: { ...second.approval!, revisionId: "edition-b" },
    };
    await put(current);
    await syncArticleRecord(current);
  } finally {
    finishOld.resolve();
  }
  await old;
  const registry = await readArticleDiskRegistry(first);
  assert.equal(registry?.current, true);
  assert.notEqual(registry?.summaryPath, oldPath);
  assert.match(files.get(registry!.summaryPath) ?? "", /новый материал/);
  assert.match(files.get(oldPath!) ?? "", /старый материал/);
});
