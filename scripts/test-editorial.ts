import { requireFixtureDatabase } from "./qa-fixture";
import assert from "node:assert/strict";
import { installPilotFixture } from "./pilot-fixture";
import { canReadEditorial, editorialContentSchema, EditorialError } from "../lib/editorial";
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
async function main() {
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
