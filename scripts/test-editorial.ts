import { requireFixtureDatabase } from "./qa-fixture";
import assert from "node:assert/strict";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db";
import { TableName } from "../lib/schema";
import { installPilotFixture } from "./pilot-fixture";
import { canReadEditorial, editorialContentSchema, EditorialError } from "../lib/editorial";
import {
  readEditorialRecovery,
  RECOVERY_PREFIX,
  saveEditorialRecovery,
} from "../lib/editorial-recovery";
import {
  createEditorial,
  getEditorial,
  getEditorialRevisions,
  listEditorial,
  mutateEditorial,
} from "../lib/editorial-models";
import { getAllArticles, ensureKnowledgeSeed } from "../lib/models";
import { articleSeed } from "../lib/articles";
import { knowledgeSeedCards } from "../lib/knowledge";
function testLocalRecovery() {
  const record = {
    ownerId: "qa-owner",
    documentId: "qa-draft",
    version: 3,
    savedAt: Date.now(),
    content: editorialContentSchema.parse({ title: "Текст для восстановления" }),
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = Object.assign(
    Object.create({
      getItem(this: Record<string, string>, key: string) {
        return this[key] ?? null;
      },
      setItem(this: Record<string, string>, key: string, value: string) {
        this[key] = value;
      },
      removeItem(this: Record<string, string>, key: string) {
        delete this[key];
      },
    }),
    {
      [RECOVERY_PREFIX + "qa-owner:invalid"]: '{"ownerId":',
      [RECOVERY_PREFIX + "qa-owner:qa-draft"]: JSON.stringify(record),
    }
  );
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  try {
    assert.deepEqual(
      readEditorialRecovery(record.ownerId),
      [record],
      "A malformed entry must not hide the owner's intact recovery copy"
    );
    const manyParagraphs = {
      ...record.content,
      sections: Array.from({ length: 3 }, (_, section) => ({
        id: `section-${section}`,
        heading: "Раздел",
        level: 2 as const,
        chunks: Array.from({ length: 12 }, (_, chunk) => ({
          id: `chunk-${section}-${chunk}`,
          content: "я".repeat(4000),
        })),
      })),
    };
    const longParagraph = {
      ...record.content,
      sections: [{
        id: "section",
        heading: "Раздел",
        level: 2 as const,
        chunks: [{ id: "chunk", content: "я".repeat(4001) }],
      }],
    };
    const manySources = {
      ...record.content,
      sourceCardIds: Array.from({ length: 101 }, (_, index) => `card-${index}`),
      sourceCardTitles: Array.from({ length: 101 }, (_, index) => `Источник ${index}`),
    };
    const largeCopies = [
      ["many-paragraphs", manyParagraphs],
      ["long-paragraph", longParagraph],
      ["many-sources", manySources],
    ] as const;
    for (const [documentId, content] of largeCopies) {
      assert.equal(editorialContentSchema.safeParse(content).success, false);
      assert.ok(saveEditorialRecovery(record.ownerId, documentId, 1, content));
    }
    const copies = readEditorialRecovery(record.ownerId);
    assert.deepEqual(
      largeCopies.map(([id]) => copies.some(({ documentId }) => documentId === id)),
      largeCopies.map(() => true),
      "The browser must retain copies when server limits are exceeded"
    );
    for (const [documentId, content] of largeCopies)
      assert.deepEqual(copies.find((entry) => entry.documentId === documentId)?.content, content);
    const invalidCopy = {
      ...record.content,
      sections: [{ id: "", heading: "Новый раздел", level: 2 as const, chunks: [] }],
    };
    assert.equal(saveEditorialRecovery(record.ownerId, record.documentId, 4, invalidCopy), false);
    assert.equal(readEditorialRecovery(record.ownerId).find(copy => copy.documentId === record.documentId)?.version, 3);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

async function main() {
  testLocalRecovery();
  await requireFixtureDatabase();
  const fixture = installPilotFixture();
  const owner = fixture.account("demo-pr-midis");
  const other = fixture.account("demo-pr-susu");
  const admin = fixture.account("demo-admin");
  const content = editorialContentSchema.parse({
    ...articleSeed[0],
    title: `EDITORIAL TEST ${crypto.randomUUID()}`,
  });
  const doc = await createEditorial(owner, {
    content: editorialContentSchema.parse({
      query: "Незаконченный личный запрос",
    }),
    channel: "Оригинал",
  });
  assert.equal((await getEditorial(doc.id, owner)).content.title, "");
  await assert.rejects(
    getEditorial(doc.id, other),
    (e: unknown) => e instanceof EditorialError && e.status === 404
  );
  assert.ok(!(await listEditorial(admin)).some((d) => d.id === doc.id));
  const saved = await mutateEditorial(doc.id, owner, {
    action: "save",
    version: doc.version,
    content,
  });
  // Model a commit between loading the head and scanning its events.
  const originalSend = docClient.send;
  let staleRead = true;
  docClient.send = function (this: typeof docClient, ...args: unknown[]) {
    const command = args[0];
    if (
      staleRead &&
      command instanceof GetCommand &&
      command.input.TableName === TableName.EDITORIAL_DOCUMENTS &&
      command.input.Key?.id === doc.id
    ) {
      staleRead = false;
      return Promise.resolve({ Item: doc });
    }
    return Reflect.apply(originalSend, this, args);
  } as typeof docClient.send;
  try {
    const consistent = await getEditorial(doc.id, owner);
    assert.equal(consistent.version, saved.document.version, "The event history and head must reflect the same version");
    assert.deepEqual(consistent.events, saved.document.events);
  } finally {
    docClient.send = originalSend;
  }
  assert.deepEqual(
    (await getEditorialRevisions(doc, owner)).map(({ id }) => id),
    [doc.revisionId],
    "History for a previously read draft must exclude revisions committed afterwards"
  );
  await assert.rejects(
    mutateEditorial(doc.id, owner, {
      action: "save",
      version: doc.version,
      content,
    }),
    (e: unknown) => e instanceof EditorialError && e.status === 409
  );
  const revision = saved.document.revisionId;
  await ensureKnowledgeSeed();
  const submitted = await mutateEditorial(doc.id, owner, {
    action: "submit",
    version: saved.document.version,
    revisionId: revision,
    comment: "Проверьте материал",
  });
  assert.ok((await listEditorial(admin)).some((d) => d.id === doc.id));
  assert.deepEqual((await getEditorialRevisions(submitted.document, admin)).map(row => row.id), [revision]);
  await assert.rejects(
    mutateEditorial(doc.id, owner, {
      action: "approve",
      version: submitted.document.version,
      revisionId: revision,
      comment: "",
    }),
    (e: unknown) => e instanceof EditorialError && e.status === 403
  );
  const returned = await mutateEditorial(doc.id, admin, {
    action: "return",
    version: submitted.document.version,
    revisionId: revision,
    comment: "Уточните подачу",
  });
  const resubmitted = await mutateEditorial(doc.id, owner, {
    action: "submit",
    version: returned.document.version,
    revisionId: revision,
    comment: "Исправлено",
  });
  const approved = await mutateEditorial(doc.id, admin, {
    action: "approve",
    version: resubmitted.document.version,
    revisionId: revision,
    comment: "Согласовано",
  });
  assert.equal(approved.publication?.approval?.revisionId, revision);
  assert.ok((await getAllArticles()).some((a) => a.id === doc.id));
  const revised = await mutateEditorial(doc.id, owner, {
    action: "save",
    version: approved.document.version,
    content: { ...content, title: "Новая несогласованная версия" },
  });
  assert.equal(
    (await getAllArticles()).find((a) => a.id === doc.id)?.title,
    content.title
  );
  const restored = await mutateEditorial(doc.id, owner, {
    action: "restore",
    version: revised.document.version,
    revisionId: doc.revisionId,
  });
  assert.equal(restored.document.content.title, "");
  assert.equal((await getEditorialRevisions(restored.document, owner)).length, 4);
  const variant = await createEditorial(owner, {
    content,
    originalId: doc.id,
    channel: "Telegram",
  });
  assert.equal(variant.originalId, doc.id);
  const red = await createEditorial(owner, {
    content: editorialContentSchema.parse({
      ...content,
      lead: "В учебно-научном комплексе кампуса «Южный Урал» уже работает медицинская VR-лаборатория.",
    }),
    channel: "Оригинал",
  });
  const redSubmitted = await mutateEditorial(red.id, owner, {
    action: "submit",
    version: red.version,
    revisionId: red.revisionId,
    comment: "",
  });
  await assert.rejects(
    mutateEditorial(red.id, admin, {
      action: "approve",
      version: redSubmitted.document.version,
      revisionId: red.revisionId,
      comment: "",
    }),
    (e: unknown) => e instanceof EditorialError && e.status === 422
  );
  assert.ok(!(await getAllArticles()).some((a) => a.id === red.id));
  const leader = fixture.account("demo-owner-midis");
  const foreignLeader = fixture.account("demo-owner-susu");
  const ownSource = knowledgeSeedCards.find(
    (card) => card.id === "project-midis-service-design"
  )!;
  const local = await createEditorial(owner, {
    channel: "Оригинал",
    content: editorialContentSchema.parse({
      title: "Материал своего вуза",
      universityId: "midis",
      lead: ownSource.referenceDescription,
      sourceCardIds: [ownSource.id],
      sections: [
        {
          id: "own-section",
          heading: "Подтверждённые факты",
          level: 2,
          chunks: [
            { id: "own-chunk", content: ownSource.referenceDescription },
          ],
        },
      ],
    }),
  });
  await assert.rejects(
    getEditorial(local.id, leader),
    (e: unknown) => e instanceof EditorialError && e.status === 404
  );
  await assert.rejects(
    mutateEditorial(local.id, owner, {
      action: "submit",
      version: local.version,
      revisionId: local.revisionId,
      reviewerId: foreignLeader.id,
      comment: "",
    }),
    (e: unknown) => e instanceof EditorialError && e.status === 403
  );
  const directed = await mutateEditorial(local.id, owner, {
    action: "submit",
    version: local.version,
    revisionId: local.revisionId,
    reviewerId: leader.id,
    comment: "Руководителю своего вуза",
  });
  assert.equal((await getEditorial(local.id, leader)).reviewerId, leader.id);
  await assert.rejects(
    getEditorial(local.id, foreignLeader),
    (e: unknown) => e instanceof EditorialError && e.status === 404
  );
  await assert.rejects(
    getEditorial(local.id, admin),
    (e: unknown) => e instanceof EditorialError && e.status === 404
  );
  assert.equal(canReadEditorial({ ...owner, role: "guest" }, directed.document), false);
  assert.equal(canReadEditorial({ ...leader, role: "university_pr" }, directed.document), false);
  assert.equal(canReadEditorial({ ...leader, universityId: foreignLeader.universityId }, directed.document), false);
  const leaderComment = await mutateEditorial(local.id, leader, {
    action: "comment",
    version: directed.document.version,
    revisionId: local.revisionId,
    comment: "Проверяю редакцию",
  });
  const leaderReturn = await mutateEditorial(local.id, leader, {
    action: "return",
    version: leaderComment.document.version,
    revisionId: local.revisionId,
    comment: "Уточните заголовок",
  });
  const again = await mutateEditorial(local.id, owner, {
    action: "submit",
    version: leaderReturn.document.version,
    revisionId: local.revisionId,
    reviewerId: leader.id,
    comment: "Готово",
  });
  const leaderApproved = await mutateEditorial(local.id, leader, {
    action: "approve",
    version: again.document.version,
    revisionId: local.revisionId,
    comment: "Согласовано руководителем",
  });
  assert.equal(leaderApproved.publication?.approval?.approvedBy, leader.id);
  const privateEdit = await mutateEditorial(local.id, owner, {
    action: "save",
    version: leaderApproved.document.version,
    content: { ...local.content, title: "Ещё не отправленная правка" },
  });
  await assert.rejects(
    getEditorial(local.id, leader),
    (e: unknown) => e instanceof EditorialError && e.status === 404
  );
  assert.equal(privateEdit.document.status, "draft");
  const joint = await createEditorial(owner, { channel: "Оригинал", content });
  await assert.rejects(
    mutateEditorial(joint.id, owner, {
      action: "submit",
      version: joint.version,
      revisionId: joint.revisionId,
      reviewerId: leader.id,
      comment: "",
    }),
    (e: unknown) => e instanceof EditorialError && e.status === 403
  );
  const ownLeaderDraft = await createEditorial(leader, {
    channel: "Оригинал",
    content: local.content,
  });
  await assert.rejects(
    mutateEditorial(ownLeaderDraft.id, leader, {
      action: "submit",
      version: ownLeaderDraft.version,
      revisionId: ownLeaderDraft.revisionId,
      reviewerId: leader.id,
      comment: "",
    }),
    (e: unknown) => e instanceof EditorialError && e.status === 403
  );
  const concurrent = await createEditorial(owner, { content, channel: "Оригинал" });
  const contenders = await Promise.allSettled(
    ["Первая вкладка", "Вторая вкладка"].map((title) =>
      mutateEditorial(concurrent.id, owner, {
        action: "save",
        version: concurrent.version,
        content: { ...content, title },
      })
    )
  );
  const winner = contenders.find((result) => result.status === "fulfilled");
  const loser = contenders.find((result) => result.status === "rejected");
  assert.ok(winner?.status === "fulfilled" && loser?.status === "rejected");
  assert.ok(loser.reason instanceof EditorialError && loser.reason.status === 409);
  const latest = await getEditorial(concurrent.id, owner);
  assert.equal(latest.version, concurrent.version + 1);
  assert.equal(latest.content.title, winner.value.document.content.title);
  assert.equal((await getEditorialRevisions(latest, owner)).length, 2);
  assert.equal(latest.events.filter(({ action }) => action === "saved").length, 1);
  console.log("PASS local recovery skips malformed entries, history respects the read version, concurrent saves commit only one edit");
  console.log(
    "PASS: durable incomplete draft, ownership, private drafts, revision conflict, submission, role gate, return/comment, approval projection, unpublished edit isolation, restore, grouped channel variant, red approval block"
  );
  console.log(
    "PASS: directed own-university leader read/comment/return/approve; no initial/unsent draft access, foreign/unassigned reviewer denial, joint coordinator-only, self-review denied"
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
