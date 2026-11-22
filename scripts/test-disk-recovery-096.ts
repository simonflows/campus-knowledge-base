import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, resetDbAvailableCache } from "../lib/db";
import { planDiskRecovery, runDiskRecoveryPass } from "../lib/disk-recovery";
import { publishDiskRegistryReceipt, syncKnowledgeCardRecord } from "../lib/disk-sync-service";
import {
  createPendingDiskSync, diskRecoveryDue, DISK_RECOVERY_ACTIVE_MS, DISK_RECOVERY_FAILURE_MS,
  type DiskRegistry,
} from "../lib/disk-sync";
import { knowledgeSeedCards, UNIVERSITY_SUBFOLDERS, type KnowledgeCard } from "../lib/knowledge";
import { universities } from "../lib/data";
import { TableName } from "../lib/schema";
import {
  cardRegistryFingerprint, DISK_RESTORE_GUIDE, diskRegistryId, diskRegistryReceipt, EMPTY_DISK_REGISTRY_FINGERPRINT,
  getCardDiskFolderSegments,
} from "../lib/yandex-disk";

Object.assign(process.env, {
  NODE_ENV: "production", CANON_DISK_RECOVERY: "true", DOCUMENT_API_ENDPOINT: "http://127.0.0.1:1",
  USE_DATABASE: "true", OUTPUT_MODE: "", CAMPUS_LOCAL_DEMO: "false", CAMPUS_FULL_LOCAL_DEMO: "false",
  NEXT_PUBLIC_DEMO_MODE: "false", CAMPUS_DEMO_LOGIN: "false",
  YANDEX_DISK_OAUTH_TOKEN: "synthetic-disk-recovery", YANDEX_DISK_ROOT_MODE: "app",
});

const approvedAt = "2026-11-20T00:00:00.000Z";
const published: KnowledgeCard = {
  ...knowledgeSeedCards.find(card => card.type === "campus")!,
  id: "fixture-approved", title: "Approved backup fixture", status: "approved", updatedAt: approvedAt,
  diskSync: createPendingDiskSync(),
};
const folder = getCardDiskFolderSegments(published);
const registryId = diskRegistryId("cards", folder);

function conflict(): never {
  throw Object.assign(new Error("fixture conditional write refused"), { name: "ConditionalCheckFailedException" });
}

function fixture(context: TestContext, source: KnowledgeCard[] = []) {
  const cards = new Map(source.map(card => [card.id, card]));
  const registries = new Map<string, DiskRegistry>();
  const files = new Map<string, string>();
  const folders = new Set<string>();
  let rejectUpload = (_path: string) => false;
  let onUpload = (_path: string): Promise<void> => Promise.resolve();
  let writes = 0;

  function update(input: UpdateCommand["input"]) {
    writes++;
    const values = input.ExpressionAttributeValues ?? {};
    const id = String(input.Key?.id);
    if (input.TableName === TableName.WORKFLOW_RECORDS) {
      const row = registries.get(id);
      if (!row || row.versionId !== values[":version"]) return conflict();
      if (input.UpdateExpression?.startsWith("SET receiptLastAttemptAt")) {
        if (row.receiptPath || row.receiptLastAttemptAt !== values[":previous"]) return conflict();
        row.receiptLastAttemptAt = values[":attempt"];
      } else if (input.UpdateExpression?.startsWith("SET receiptPath")) {
        if (row.receiptPath || row.receiptLastAttemptAt !== values[":attempt"]) return conflict();
        row.receiptPath = values[":result"];
        delete row.receiptError;
      } else if (input.UpdateExpression?.startsWith("SET receiptError")) {
        if (row.receiptPath || row.receiptLastAttemptAt !== values[":attempt"]) return conflict();
        row.receiptError = values[":result"];
        if (values[":invalid"] === true) row.summaryInvalid = true;
      } else {
        assert.equal(input.UpdateExpression, "SET rebuildLastAttemptAt = :attempt, rebuildError = :error");
        row.rebuildLastAttemptAt = values[":attempt"];
        row.rebuildError = values[":error"];
      }
      return { Attributes: structuredClone(row) };
    }
    const raw = cards.get(id);
    assert.equal(input.TableName, TableName.KNOWLEDGE_CARDS);
    assert.ok(raw);
    const nested = input.UpdateExpression?.includes("approvedSnapshot.diskSync");
    const target = nested ? raw.approvedSnapshot : raw;
    assert.ok(target);
    if (nested) {
      if (raw.updatedAt !== values[":head"] || raw.status === "approved" ||
          target.updatedAt !== values[":snapshot"]) return conflict();
    } else if (raw.updatedAt !== values[":version"] || raw.status !== "approved") return conflict();
    if (values[":attempt"] && values[":attempt"] !== target.diskSync?.attemptId) return conflict();
    target.diskSync = values[":diskSync"];
    return { Attributes: structuredClone(raw) };
  }

  function put(input: PutCommand["input"], apply = true) {
    assert.equal(input.TableName, TableName.WORKFLOW_RECORDS);
    const row = input.Item as DiskRegistry;
    const observed = registries.get(row.id);
    if (observed?.versionId !== input.ExpressionAttributeValues?.[":expected"]) return conflict();
    if (apply) {
      writes++;
      registries.set(row.id, structuredClone(row));
    }
  }

  resetDbAvailableCache();
  context.after(resetDbAvailableCache);
  context.mock.method(docClient, "send", async (command: unknown) => {
    if (command instanceof ListTablesCommand) return { TableNames: [] };
    if (command instanceof GetCommand) return { Item: structuredClone(command.input.TableName === TableName.WORKFLOW_RECORDS
      ? registries.get(command.input.Key?.id)
      : cards.get(command.input.Key?.id)) };
    if (command instanceof ScanCommand) {
      const items = command.input.TableName === TableName.WORKFLOW_RECORDS ? [...registries.values()]
        : command.input.TableName === TableName.KNOWLEDGE_CARDS ? [...cards.values()] : [];
      return { Items: structuredClone(items) };
    }
    if (command instanceof UpdateCommand) return update(command.input);
    if (command instanceof PutCommand) return put(command.input);
    assert.ok(command instanceof TransactWriteCommand);
    const registryWrite = command.input.TransactItems?.find(item => item.Put)?.Put;
    const statusWrite = command.input.TransactItems?.find(item => item.Update)?.Update;
    assert.ok(registryWrite && statusWrite);
    put(registryWrite, false);
    update(statusWrite);
    put(registryWrite);
    return {};
  });
  const transport = context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.searchParams.get("path");
    assert.ok(path);
    assert.ok(init?.signal, "Each transport call has a deadline");
    if (url.hostname === "cloud-api.yandex.net" && url.pathname.endsWith("/resources")) {
      folders.add(path);
      return new Response(null, { status: 201 });
    }
    if (url.hostname === "cloud-api.yandex.net" && url.pathname.endsWith("/upload")) {
      return Response.json({ href: `https://uploader.disk.yandex.net/fixture?path=${encodeURIComponent(path)}` });
    }
    if (url.hostname === "cloud-api.yandex.net" && url.pathname.endsWith("/download")) {
      return files.has(path)
        ? Response.json({ href: `https://downloader.disk.yandex.net/fixture?path=${encodeURIComponent(path)}` })
        : new Response(null, { status: 404 });
    }
    if (url.hostname === "downloader.disk.yandex.net") return new Response(files.get(path));
    assert.equal(url.hostname, "uploader.disk.yandex.net");
    await onUpload(path);
    if (rejectUpload(path)) return new Response(null, { status: 503 });
    files.set(path, String(init?.body));
    return new Response(null, { status: 201 });
  });
  return {
    cards, registries, files, folders, transport, writeCount: () => writes,
    reject: (rule: typeof rejectUpload) => { rejectUpload = rule; },
    delay: (rule: typeof onUpload) => { onUpload = rule; },
  };
}

test("the Disk guide identifies the confirmed summary with the application offline", () => {
  assert.match(DISK_RESTORE_GUIDE, /_Подтверждённые_сводки/);
  assert.match(DISK_RESTORE_GUIDE, /наибольшим номером|максимальный номер/u);
  assert.match(DISK_RESTORE_GUIDE, /Ожидает выгрузки/u);
});

test("a healthy synchronized document never enters automatic retry", () => {
  const now = Date.now();
  const latest = new Date(now).toISOString();
  const before = (milliseconds: number) => new Date(now - milliseconds).toISOString();
  const complete = {
    ...createPendingDiskSync(), status: "synced" as const, sourceUpdatedAt: latest,
    filePath: "current.md", summaryPath: "summary.csv",
  };
  assert.equal(diskRecoveryDue(complete, latest, undefined, now), false);
  assert.equal(diskRecoveryDue(complete, before(100), undefined, now), true);
  assert.equal(diskRecoveryDue({ ...complete, sourceRevisionId: "r1" }, latest, "r2", now), true);
  const pending = { ...createPendingDiskSync(), attemptId: "active", lastAttemptAt: before(DISK_RECOVERY_ACTIVE_MS - 1) };
  assert.equal(diskRecoveryDue(pending, latest, undefined, now), false);
  assert.equal(diskRecoveryDue(pending, latest, undefined, now + 1), true);
  const failed = { ...pending, status: "failed" as const, lastAttemptAt: before(DISK_RECOVERY_FAILURE_MS - 1) };
  assert.equal(diskRecoveryDue(failed, latest, undefined, now), false);
  assert.equal(diskRecoveryDue(failed, latest, undefined, now + 1), true);
});

test("recovery writes an approved snapshot, retries a missing receipt alone, then confirms an empty folder", async context => {
  const head: KnowledgeCard = {
    ...structuredClone(published), status: "pending", title: "PRIVATE SNAPSHOT MUST NEVER REACH DISK",
    updatedAt: "2026-11-21T00:00:00.000Z", approvedSnapshot: structuredClone(published),
  };
  const draft: KnowledgeCard = { ...head, id: "fixture-private-only", approvedSnapshot: undefined };
  const mock = fixture(context, [head, draft]);
  mock.reject(path => path.endsWith(".csv"));
  const now = Date.now();
  assert.equal(await runDiskRecoveryPass(now), 1);
  const first = mock.cards.get(head.id)!;
  assert.equal(first.approvedSnapshot?.diskSync?.status, "failed");
  assert.equal(first.title, head.title);
  assert.equal(first.diskSync?.status, "pending");
  assert.equal(mock.registries.size, 0);
  for (const university of universities) for (const subfolder of UNIVERSITY_SUBFOLDERS) {
    assert.ok(mock.folders.has(`app:/01_Вузы_резиденты/${university.shortName}/${subfolder.name}`));
  }
  mock.reject(path => path.includes("_Подтверждённые_сводки"));
  assert.equal(await runDiskRecoveryPass(now + DISK_RECOVERY_FAILURE_MS + 1_000), 1);
  const recovered = mock.registries.get(registryId)!;
  assert.equal(recovered.sequence, 1);
  assert.match(recovered.receiptError ?? "", /HTTP 503/);
  assert.equal(recovered.receiptPath, undefined);
  assert.equal(mock.cards.get(head.id)?.approvedSnapshot?.diskSync?.status, "synced");
  assert.ok([...mock.files.values()].every(content => !content.includes(head.title)));
  assert.equal(planDiskRecovery({ cards: [...mock.cards.values()], articles: [], types: [],
    registries: [...mock.registries.values()] }, Date.now()).length, 0, "The marker failure has a cooldown");
  const pathsBeforeReceipt = new Set(mock.files.keys());
  mock.reject(() => false);
  assert.equal(await runDiskRecoveryPass(now + DISK_RECOVERY_FAILURE_MS * 2 + 2_000), 1);
  const receipt = mock.registries.get(registryId)!.receiptPath!;
  assert.ok(mock.files.get(`app:/${receipt}`)?.includes("Открыть сводную CSV"));
  assert.deepEqual([...mock.files.keys()].filter(path => !pathsBeforeReceipt.has(path)), [`app:/${receipt}`]);
  const stableWrites = mock.writeCount();
  assert.equal(await runDiskRecoveryPass(now + DISK_RECOVERY_FAILURE_MS * 3 + 3_000), 0);
  assert.equal(mock.writeCount(), stableWrites);
  mock.cards.delete(head.id);
  assert.equal(await runDiskRecoveryPass(now + DISK_RECOVERY_FAILURE_MS * 4 + 4_000), 1);
  const empty = mock.registries.get(registryId)!;
  assert.equal(empty.sequence, 2);
  assert.equal(empty.fingerprint, EMPTY_DISK_REGISTRY_FINGERPRINT);
  assert.equal(empty.pendingRows, 0);
  assert.equal(mock.files.get(`app:/${empty.summaryPath}`)?.trim().split(/\r?\n/).length, 1);
  assert.ok(mock.files.has(`app:/${recovered.summaryPath}`), "The previous published CSV remains available");
});

test("late receipt upload cannot replace the higher confirmed sequence", async context => {
  const mock = fixture(context);
  const old: DiskRegistry = {
    id: registryId, kind: "disk-registry", sequence: 10, entityId: published.id,
    fingerprint: "fixture-old", versionId: "older", summaryPath: `${folder.join("/")}/older.csv`,
    confirmedAt: approvedAt,
  };
  const latest: DiskRegistry = {
    ...old, sequence: 11, versionId: "newer", summaryPath: `${folder.join("/")}/newer.csv`,
    fingerprint: "fixture-new",
  };
  mock.registries.set(registryId, old);
  const pause = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  mock.delay(async path => {
    if (path.includes("--older--")) {
      entered.resolve();
      await pause.promise;
    }
  });
  const older = publishDiskRegistryReceipt(old, AbortSignal.timeout(4_000));
  try {
    assert.equal(await Promise.race([entered.promise.then(() => true), older.then(() => false)]), true);
    mock.registries.set(registryId, latest);
    assert.equal(await publishDiskRegistryReceipt(latest, AbortSignal.timeout(4_000)), true);
  } finally {
    pause.resolve();
  }
  assert.equal(await older, false, "The older receipt cannot be acknowledged for the newer registry");
  const selected = [...mock.files.keys()].sort().at(-1);
  assert.ok(selected);
  assert.ok(selected.endsWith(diskRegistryReceipt(latest).fileName));
  assert.ok(mock.files.get(selected)?.includes("newer.csv"));
});

test("a recovery pass transfers at most two queued items", async context => {
  const mock = fixture(context);
  await runDiskRecoveryPass();
  for (const id of ["queued-1", "queued-2", "queued-3"]) {
    mock.cards.set(id, { ...structuredClone(published), id });
  }
  assert.equal(await runDiskRecoveryPass(), 2);
  assert.equal([...mock.cards.values()].filter(card => card.diskSync?.status === "synced").length, 2);
  assert.equal([...mock.cards.values()].filter(card => card.diskSync?.status === "pending").length, 1);
});

test("the demo flag prevents worker reads and external calls", async context => {
  const mock = fixture(context);
  process.env.CAMPUS_LOCAL_DEMO = "true";
  try {
    assert.equal(await runDiskRecoveryPass(), 0);
    assert.equal(mock.transport.mock.callCount(), 0);
    assert.equal(mock.writeCount(), 0);
  } finally {
    process.env.CAMPUS_LOCAL_DEMO = "false";
  }
});

test("the worker marks unsupportable legacy summaries and never acknowledges missing CSV", async context => {
  const key = "01234567890123456789";
  const summaryPath = `${folder.join("/")}/old--${key}.csv`;
  const card = { ...published, diskSync: {
    ...createPendingDiskSync(), status: "synced" as const, sourceUpdatedAt: approvedAt, lastSyncedAt: approvedAt,
    filePath: "legacy.md", summaryPath,
  } };
  const mock = fixture(context, [card]);
  mock.registries.set(registryId, {
    id: registryId, kind: "disk-registry", entityId: card.id,
    fingerprint: cardRegistryFingerprint(card, [card], [], card.id),
    versionId: "legacy", summaryPath, confirmedAt: approvedAt,
  });
  assert.equal(await runDiskRecoveryPass(), 1);
  assert.equal(mock.registries.get(registryId)?.receiptPath, undefined);
  assert.ok(mock.registries.get(registryId)?.receiptError);
  assert.equal([...mock.files.keys()].some(path => path.includes("_Подтверждённые_сводки")), false);
  assert.equal(await runDiskRecoveryPass(Date.now() + DISK_RECOVERY_FAILURE_MS + 1000), 1);
  const repaired = mock.registries.get(registryId)!;
  assert.notEqual(repaired.summaryPath, summaryPath);
  assert.ok(mock.files.has(`app:/${repaired.summaryPath}`));
  assert.ok(repaired.receiptPath);
});

test("a readable verified legacy CSV can be acknowledged without retransmission", async context => {
  const oldCsv = "\uFEFFID;Название\r\nfixture;Example\r\n";
  const hash = createHash("sha256").update(oldCsv).digest("hex").slice(0, 20);
  const summaryPath = `${folder.join("/")}/old--${hash}.csv`;
  const card = { ...published, diskSync: {
    ...createPendingDiskSync(), status: "synced" as const, sourceUpdatedAt: approvedAt, lastSyncedAt: approvedAt,
    filePath: "legacy.md", summaryPath,
  } };
  const mock = fixture(context, [card]);
  mock.files.set(`app:/${summaryPath}`, oldCsv);
  mock.registries.set(registryId, {
    id: registryId, kind: "disk-registry", entityId: card.id,
    fingerprint: cardRegistryFingerprint(card, [card], [], card.id),
    versionId: "legacy", summaryPath, confirmedAt: approvedAt,
  });
  assert.equal(await runDiskRecoveryPass(), 1);
  const recorded = mock.registries.get(registryId)!;
  assert.equal(recorded.versionId, "legacy");
  assert.ok(recorded.receiptPath);
  assert.match(recorded.receiptPath, /0000000000000000/);
  assert.equal(mock.files.get(`app:/${summaryPath}`), oldCsv);
  assert.ok(mock.transport.mock.calls.some(call => String(call.arguments[0]).includes("downloader.disk.yandex.net")));
});

test("pausing automatic recovery leaves receipts enabled for normal exports", async context => {
  const mock = fixture(context, [published]);
  process.env.CANON_DISK_RECOVERY = "false";
  try {
    assert.equal(await runDiskRecoveryPass(), 0);
    const exported = await syncKnowledgeCardRecord(published);
    assert.equal(exported.diskSync?.status, "synced");
    const registry = mock.registries.get(registryId)!;
    assert.ok(registry.receiptPath);
    assert.ok(mock.files.has(`app:/${registry.receiptPath}`));
  } finally {
    process.env.CANON_DISK_RECOVERY = "true";
  }
});

test("a failed adjacent row does not keep a removed row in the confirmed summary", async context => {
  const now = Date.now();
  const ready = { ...published, diskSync: { ...createPendingDiskSync(), status: "synced" as const,
    sourceUpdatedAt: approvedAt, lastSyncedAt: approvedAt, filePath: "existing.md", summaryPath: "existing.csv",
  } };
  const failed = { ...published, id: "second", diskSync: { ...createPendingDiskSync(), status: "failed" as const,
    lastAttemptAt: new Date(now).toISOString() } };
  const removed = { ...ready, id: "removed" };
  const mock = fixture(context, [ready, failed]);
  mock.registries.set(registryId, {
    id: registryId, kind: "disk-registry", entityId: ready.id,
    fingerprint: cardRegistryFingerprint(ready, [ready, failed, removed], [], ready.id),
    versionId: "before-delete", summaryPath: `${folder.join("/")}/existing.csv`, confirmedAt: approvedAt,
    receiptPath: "confirmed.md", sequence: 7,
  });
  assert.equal(await runDiskRecoveryPass(now), 1);
  const registry = mock.registries.get(registryId)!;
  assert.equal(registry.sequence, 8);
  assert.equal(registry.pendingRows, 1);
  assert.ok(registry.receiptPath);
  const actualCsv = mock.files.get(`app:/${registry.summaryPath}`)!;
  assert.ok(!actualCsv.includes("removed"));
  assert.ok(actualCsv.includes("second"));
  assert.ok(actualCsv.includes("Ожидает выгрузки"));
  assert.equal(await runDiskRecoveryPass(now), 0, "A complete summary refresh should not repeat");
});
