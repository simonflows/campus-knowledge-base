import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db";
import {
  folderIds,
  getPublicApprovedCard,
  knowledgeSeedCards,
} from "../lib/knowledge";
import {
  getApprovedCardVersion,
  getApprovedCardVersions,
  getCardVersionId,
} from "../lib/knowledge-versions";
import {
  getCanonicalKnowledgeCards,
  getKnowledgeCardById,
  updateKnowledgeCard,
} from "../lib/models";
import {
  importReviewedPackage,
  prepareReviewedPackage,
} from "../lib/reviewed-package-import";
import { TableName } from "../lib/schema";
import { knowledgeCardInputSchema } from "../lib/validation/knowledge";
import { diskRegistryId, getCardDiskFolderSegments } from "../lib/yandex-disk";
import { requireFixtureDatabase } from "./qa-fixture";

const project = knowledgeSeedCards.find(
  (card) => card.type === "project" && !card.isJoint
)!;
const candidate = (
  status: "approved" | "pending",
  card: Record<string, unknown> = {}
) => ({
  card: { ...project, id: "qa-reviewed-" + randomUUID(), ...card },
  proposedStatus: status,
  approvalBasis: "Независимая сверка официальной публикации",
  requiresParticipantApproval: false,
  sources: [
    {
      publisher: "Публичный источник QA",
      url: "https://example.org/fixture",
      publishedAt: null,
      checkedAt: "2026-11-22",
      claims: ["Синтетические данные"],
    },
  ],
  openQuestions: status === "pending" ? ["Уточнить область применения"] : [],
});

function packageFor(rows: ReturnType<typeof candidate>[]) {
  const bytes = Buffer.from(
    JSON.stringify({
      preparedAt: "2026-11-22",
      method: "fixture",
      cards: rows,
    })
  );
  return {
    bytes,
    proof: {
      packageSha256: createHash("sha256").update(bytes).digest("hex"),
      reviewedAt: "2026-11-22T10:00:00Z",
      reviewer: "Независимая сверка QA",
      approvedIds: rows
        .filter((row) => row.proposedStatus === "approved")
        .map((row) => row.card.id),
      pendingIds: rows
        .filter((row) => row.proposedStatus === "pending")
        .map((row) => row.card.id),
      reviewDocument: "docs/qa-review.md",
    },
  };
}

test("a verification for different bytes cannot authorize import", () => {
  const { bytes, proof } = packageFor([candidate("approved")]);
  assert.throws(
    () =>
      prepareReviewedPackage(Buffer.concat([bytes, Buffer.from("\n")]), proof),
    { code: "hash-mismatch" }
  );
});

test("a joint proposal is withheld even when a verification incorrectly lists it as approved", () => {
  const { bytes, proof } = packageFor([
    candidate("approved", {
      isJoint: true,
      initiatorUniversityId: "",
      participantUniversityIds: ["midis", "susu"],
    }),
  ]);
  assert.throws(() => prepareReviewedPackage(bytes, proof), {
    code: "approval-denied",
  });
});

test("a reviewed package cannot insert a strategy link outside card moderation", () => {
  const document = { cardId: "qa-document", versionId: `cv-${"a".repeat(64)}` };
  const { bytes, proof } = packageFor([
    candidate("approved", {
      strategyLinks: [
        {
          document,
          clauseId: "goal",
          explanation: "Synthetic link",
          evidence: { document, clauseId: "goal" },
        },
      ],
    }),
  ]);
  assert.throws(() => prepareReviewedPackage(bytes, proof), {
    code: "approval-denied",
  });
});

test("the verification covers every ID exactly once", () => {
  const { bytes, proof } = packageFor([
    candidate("approved"),
    candidate("pending"),
  ]);
  assert.throws(
    () =>
      prepareReviewedPackage(bytes, {
        ...proof,
        pendingIds: proof.approvedIds,
      }),
    { code: "invalid-coverage" }
  );
  assert.throws(
    () => prepareReviewedPackage(bytes, { ...proof, pendingIds: ["unknown"] }),
    { code: "invalid-coverage" }
  );
  assert.throws(
    () => prepareReviewedPackage(bytes, { ...proof, approvedIds: [] }),
    { code: "invalid-coverage" }
  );
});

test("pending laboratory participant requirements need explicit verified resident IDs", () => {
  const lab = knowledgeSeedCards.find((card) => card.type === "laboratory")!;
  const row = candidate("pending", {
    ...lab,
    id: "qa-reviewed-" + randomUUID(),
  });
  row.requiresParticipantApproval = true;
  let packet = packageFor([row]);
  assert.throws(() => prepareReviewedPackage(packet.bytes, packet.proof), {
    code: "missing-reviewers",
  });
  Object.assign(row.card, {
    requiredApprovalUniversityIds: ["suspgu", "susmu"],
    participantApprovals: ["suspgu"],
    approvedSnapshot: project,
  });
  packet = packageFor([row]);
  const [{ card, version }] = prepareReviewedPackage(
    packet.bytes,
    packet.proof
  ).items;
  assert.deepEqual(card.requiredApprovalUniversityIds, ["suspgu", "susmu"]);
  assert.equal(card.participantApprovals, undefined);
  assert.equal(card.approvedSnapshot, undefined);
  assert.equal(version, undefined);
});

function cleanup(context: TestContext, cardIds: string[]) {
  context.after(async () => {
    for (const id of cardIds) {
      assert.match(id, /^qa-reviewed-[0-9a-f-]{36}$/);
      await docClient.send(
        new DeleteCommand({ TableName: TableName.KNOWLEDGE_CARDS, Key: { id } })
      );
      for (const version of await getApprovedCardVersions(id)) {
        await docClient.send(
          new DeleteCommand({
            TableName: TableName.KNOWLEDGE_CARD_VERSIONS,
            Key: { id: version.id },
          })
        );
      }
    }
  });
}

const fixtureAvailable = process.env.CAMPUS_QA_DISPOSABLE === "yes";

test(
  "dry-run detects collisions and apply atomically publishes versions, keeps drafts private and replays",
  { skip: !fixtureAvailable },
  async (context) => {
    await requireFixtureDatabase();
    const approved = candidate("approved", {
      ownerIds: ["unsupported-assignment"],
    });
    const pending = candidate("pending", { readinessStage: "Не уточнено" });
    const collision = candidate("approved");
    cleanup(context, [approved.card.id, pending.card.id, collision.card.id]);
    const untouched = {
      ...project,
      id: collision.card.id,
      title: "Чужая существующая запись",
    };
    await docClient.send(
      new PutCommand({
        TableName: TableName.KNOWLEDGE_CARDS,
        Item: untouched,
        ConditionExpression: "attribute_not_exists(id)",
      })
    );
    const { bytes, proof } = packageFor([approved, pending, collision]);
    const outbound = context.mock.method(globalThis, "fetch", async () =>
      assert.fail("Apply without --sync uses no external transport")
    );
    const dry = await importReviewedPackage(bytes, proof);
    assert.equal(dry.mode, "dry-run");
    assert.deepEqual([dry.wouldInsert, dry.conflicts, dry.inserted], [2, 1, 0]);
    assert.equal(await getKnowledgeCardById(approved.card.id), null);
    assert.equal(await getKnowledgeCardById(pending.card.id), null);
    assert.deepEqual(await getApprovedCardVersions(approved.card.id), []);

    const applied = await importReviewedPackage(bytes, proof, { apply: true });
    assert.deepEqual(
      [applied.inserted, applied.conflicts, applied.synced],
      [2, 1, 0]
    );
    const publicCard = await getKnowledgeCardById(approved.card.id);
    assert.ok(publicCard);
    assert.deepEqual(publicCard.ownerIds, []);
    assert.equal(publicCard.sources?.[0].title, approved.sources[0].publisher);
    assert.equal(publicCard.sources?.[0].publishedAt, undefined);
    const firstVersion = await getApprovedCardVersion(
      getCardVersionId(publicCard)
    );
    assert.equal(firstVersion?.legacyBaseline, false);
    assert.equal(firstVersion?.actorId, "reviewed-package-import");
    assert.equal(firstVersion?.reason, approved.approvalBasis);
    const row = await docClient.send(
      new GetCommand({
        TableName: TableName.KNOWLEDGE_CARD_VERSIONS,
        Key: { id: firstVersion!.id },
        ConsistentRead: true,
      })
    );
    assert.equal(
      row.Item?.importProvenance?.packageSha256,
      proof.packageSha256
    );
    assert.equal(row.Item?.importProvenance?.reviewedAt, proof.reviewedAt);
    assert.notEqual(row.Item?.recordedAt, proof.reviewedAt);

    const draft = await getKnowledgeCardById(pending.card.id);
    assert.ok(draft);
    assert.equal(draft.status, "pending");
    assert.equal(getPublicApprovedCard(draft), null);
    assert.equal(
      (await getCanonicalKnowledgeCards()).some((card) => card.id === draft.id),
      false
    );
    assert.deepEqual(await getApprovedCardVersions(draft.id), []);

    const replay = await importReviewedPackage(bytes, proof, { apply: true });
    assert.deepEqual(
      [replay.inserted, replay.preserved, replay.conflicts],
      [0, 2, 1]
    );
    assert.deepEqual(await getApprovedCardVersions(publicCard.id), [
      firstVersion,
    ]);
    assert.deepEqual(await getKnowledgeCardById(collision.card.id), untouched);
    assert.equal(outbound.mock.callCount(), 0);
  }
);

test(
  "a competing snapshot after preflight aborts the entire publication transaction",
  { skip: !fixtureAvailable },
  async (context) => {
    await requireFixtureDatabase();
    const row = candidate("approved");
    cleanup(context, [row.card.id]);
    const { bytes, proof } = packageFor([row]);
    const [{ version }] = prepareReviewedPackage(bytes, proof).items;
    const conflicting = {
      ...version!,
      actorName: "Причина требует проверки вручную",
    };
    const send = docClient.send.bind(docClient);
    let injected = false;
    const wire = context.mock.method(
      docClient,
      "send",
      async (command: TransactWriteCommand) => {
        if (!injected && command instanceof TransactWriteCommand) {
          injected = true;
          await send(
            new PutCommand({
              TableName: TableName.KNOWLEDGE_CARD_VERSIONS,
              Item: conflicting,
              ConditionExpression: "attribute_not_exists(id)",
            })
          );
        }
        return send(command);
      }
    );
    try {
      const result = await importReviewedPackage(bytes, proof, { apply: true });
      assert.equal(injected, true);
      assert.equal(result.inserted, 0);
      assert.equal(result.rows[0].outcome, "snapshot-conflict");
    } finally {
      wire.mock.restore();
    }
    assert.equal(await getKnowledgeCardById(row.card.id), null);
    assert.deepEqual(await getApprovedCardVersion(conflicting.id), conflicting);
    assert.equal(
      (await importReviewedPackage(bytes, proof)).rows[0].outcome,
      "snapshot-conflict"
    );
  }
);

test(
  "a failed CSV can be retried, and later human card edits block an import replay upload",
  { skip: !fixtureAvailable },
  async (context) => {
    await requireFixtureDatabase();
    const approved = candidate("approved", {
      folderId: folderIds.customType("qa-reviewed-" + randomUUID()),
    });
    const pending = candidate("pending");
    cleanup(context, [approved.card.id, pending.card.id]);
    const { bytes, proof } = packageFor([approved, pending]);
    const [{ card }] = prepareReviewedPackage(bytes, proof).items;
    await assert.rejects(importReviewedPackage(bytes, proof, { sync: true }), {
      code: "sync-requires-apply",
    });
    process.env.YANDEX_DISK_OAUTH_TOKEN = "synthetic-reviewed-package";
    process.env.YANDEX_DISK_ROOT_MODE = "app";
    const registryId = diskRegistryId("cards", getCardDiskFolderSegments(card));
    context.after(async () => {
      delete process.env.YANDEX_DISK_OAUTH_TOKEN;
      delete process.env.YANDEX_DISK_ROOT_MODE;
      await docClient.send(
        new DeleteCommand({
          TableName: TableName.WORKFLOW_RECORDS,
          Key: { id: registryId },
        })
      );
    });

    let failCsv = true;
    const recordedFiles = new Map<string, string>();
    const remote = context.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL, init: RequestInit) => {
        const url = new URL(input);
        const path = url.searchParams.get("path") ?? "";
        if (url.hostname === "cloud-api.yandex.net") {
          assert.ok(path.startsWith("app:/"));
          if (url.pathname.endsWith("/upload")) {
            return Response.json({
              href:
                "https://uploader.disk.yandex.net/fixture?path=" +
                encodeURIComponent(path.slice(5)),
            });
          }
          return new Response(null, { status: 201 });
        }
        assert.equal(url.hostname, "uploader.disk.yandex.net");
        if (failCsv && path.endsWith(".csv"))
          return new Response(null, { status: 503 });
        recordedFiles.set(path, String(init.body));
        return new Response(null, { status: 201 });
      }
    );
    const partial = await importReviewedPackage(bytes, proof, {
      apply: true,
      sync: true,
    });
    assert.deepEqual(
      [partial.inserted, partial.synced, partial.syncUnresolved],
      [2, 0, 1]
    );
    assert.equal(partial.rows[1].sync, undefined);
    assert.equal(
      (await getKnowledgeCardById(card.id))?.diskSync?.fileUploaded,
      true
    );

    failCsv = false;
    const retry = await importReviewedPackage(bytes, proof, {
      apply: true,
      sync: true,
    });
    assert.deepEqual(
      [retry.inserted, retry.preserved, retry.synced, retry.syncUnresolved],
      [0, 2, 1, 0]
    );
    const saved = await getKnowledgeCardById(card.id);
    assert.ok(saved);
    assert.ok(
      recordedFiles.get(saved.diskSync!.filePath!)?.includes(saved.title)
    );
    assert.ok(
      recordedFiles.get(saved.diskSync!.summaryPath!)?.includes(card.id)
    );
    const beforeEdit = remote.mock.callCount();

    const edited = await updateKnowledgeCard(
      saved.id,
      knowledgeCardInputSchema.parse({
        ...saved,
        title: "QA: редактор изменил текст",
      }),
      undefined,
      saved.updatedAt
    );
    assert.ok(edited);
    const guarded = await importReviewedPackage(bytes, proof, {
      apply: true,
      sync: true,
    });
    assert.equal(guarded.rows[0].outcome, "collision");
    assert.equal(guarded.rows[0].sync, "skipped-changed");
    assert.equal(remote.mock.callCount(), beforeEdit);
    assert.equal((await getKnowledgeCardById(saved.id))?.title, edited.title);
  }
);
