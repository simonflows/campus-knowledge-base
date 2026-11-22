import assert from "node:assert/strict";
import { checkFactText, buildCanonicalRewrite } from "../lib/fact-check";
import {
  knowledgeSeedCards,
  getPublicApprovedCard,
  type CardEditRequest,
  type UniversityCard,
  type ProjectCard,
} from "../lib/knowledge";
import {
  knowledgeUpdateModeration,
  missingUniversityPassports,
} from "../lib/knowledge-lifecycle";
import {
  knowledgeCardInputSchema,
  structuredMetricSchema,
} from "../lib/validation/knowledge";
import { canConfirmJointParticipation, canRequestEdit, getDemoAccount, isCardOwner, toSessionUser, visibleKnowledgeCard, visibleKnowledgeCards } from "../lib/auth";

let passed = 0;
function test(name: string, run: () => void) {
  run();
  passed++;
  console.log(`✓ ${name}`);
}
const midis = structuredClone(
  knowledgeSeedCards.find(
    (card): card is UniversityCard =>
      card.type === "university" && card.universityId === "midis"
  )!
);
const csu = structuredClone(
  knowledgeSeedCards.find(
    (card): card is UniversityCard =>
      card.type === "university" && card.universityId === "csu"
  )!
);
// These are synthetic test fixtures, never seed data or official figures.
midis.structuredMetrics = [
  {
    id: "fixture-midis",
    label: "Квота мест",
    value: 120,
    unit: "мест",
    year: 2026,
    kind: "actual",
    evidenceUrl: "https://example.org/fixture-document",
    verifiedAt: "2026-11-20",
    owner: "Test owner",
  },
  {
    id: "fixture-plan",
    label: "Квота мест",
    value: 180,
    unit: "мест",
    year: 2027,
    kind: "plan",
    evidenceUrl: "https://example.org/fixture-plan",
    verifiedAt: "2026-11-20",
    owner: "Test owner",
  },
];
csu.structuredMetrics = [
  { ...midis.structuredMetrics[0], id: "fixture-csu", value: 240 },
];
const cards = knowledgeSeedCards
  .filter((card) => card.id !== midis.id && card.id !== csu.id)
  .concat(midis, csu);

test("МИДиС: слово кампус не превращает квоту в общую вместимость", () => {
  const result = checkFactText(
    "МИДиС в 2026 году получил 120 мест в кампусе.",
    cards
  );
  assert.equal(result.summary.red, 0);
  assert.equal(result.summary.yellow, 0);
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.level === "green" &&
        finding.sourceCardId === midis.id &&
        finding.sourceUrl === midis.structuredMetrics[0].evidenceUrl
    )
  );
});
test("Два вуза и общая вместимость в одном тексте не смешиваются", () => {
  const result = checkFactText(
    "МИДиС в 2026 году получил 120 мест в кампусе; ЧелГУ в 2026 году получил 240 мест. Общая вместимость гостиниц кампуса — 3 400 мест.",
    cards
  );
  assert.equal(result.summary.red, 0);
  assert.equal(result.summary.yellow, 0);
  assert.ok(
    result.findings.some((finding) => finding.sourceCardId === midis.id)
  );
  assert.ok(result.findings.some((finding) => finding.sourceCardId === csu.id));
});
test("Цифра из другого вуза не подтверждает факт", () => {
  const result = checkFactText(
    "МИДиС в 2026 году получил 240 мест в кампусе.",
    cards
  );
  assert.ok(
    result.findings.some(
      (finding) => finding.level === "red" && finding.sourceCardId === midis.id
    )
  );
  assert.equal(result.canPublish, false);
});
test("Год и план/факт проверяются отдельно", () => {
  assert.equal(
    checkFactText("МИДиС планирует 180 мест в кампусе в 2027 году.", cards)
      .summary.yellow,
    0
  );
  assert.ok(
    checkFactText("МИДиС получил 180 мест в кампусе в 2027 году.", cards)
      .summary.red > 0
  );
  assert.ok(
    checkFactText("МИДиС получил 120 мест в кампусе в 2025 году.", cards)
      .summary.yellow > 0
  );
  assert.ok(
    checkFactText("МИДиС получил 120 мест в кампусе.", cards).summary.yellow > 0
  );
});
test("Нет паспорта/подтверждения — жёлтый без ссылки на кампус", () => {
  const result = checkFactText(
    "МИДиС в 2026 году получил 120 мест в кампусе.",
    cards.filter((card) => card.id !== midis.id)
  );
  assert.ok(
    result.findings.some(
      (finding) => finding.level === "yellow" && finding.sourceCardId === null
    )
  );
  assert.ok(
    result.findings.every(
      (finding) => finding.sourceCardId !== "campus-passport"
    )
  );
  assert.equal(result.canPublish, false);
  assert.equal(
    buildCanonicalRewrite("МИДиС получил 120 мест в кампусе.", cards),
    null
  );
});
test("Черновики и отклонённые карточки не являются доказательством", () => {
  for (const status of ["pending", "rejected"] as const) {
    const result = checkFactText(
      "МИДиС в 2026 году получил 120 мест в кампусе.",
      cards.map((card) => (card.id === midis.id ? { ...card, status } : card))
    );
    assert.equal(result.summary.green, 0);
    assert.equal(result.findings[0].sourceCardId, null);
  }
});
test("Незнакомый текст не получает зелёный/разрешение публикации", () => {
  const result = checkFactText("Обсудили интересную инициативу.", cards);
  assert.equal(result.summary.green, 0);
  assert.equal(result.canPublish, false);
  assert.equal(result.coverage, "unverified");
});
test("Площадь и места кампуса читаются из действующей карточки с правильным предметом", () => {
  const campus = structuredClone(
    knowledgeSeedCards.find((card) => card.type === "campus")!
  );
  if (campus.type !== "campus") throw new Error("Missing campus fixture");
  campus.campusMetrics[0].value = "150 тыс. м²";
  assert.equal(
    checkFactText("Общая площадь объектов кампуса — 150 тыс. м².", [campus])
      .summary.red,
    0
  );
  assert.ok(
    checkFactText("Общая площадь объектов кампуса — 123 тыс. м².", [campus])
      .summary.red > 0
  );
  assert.ok(
    checkFactText(
      "Общая площадь объектов кампуса — 70 тыс. м².",
      knowledgeSeedCards
    ).summary.red > 0
  );
  assert.ok(
    checkFactText(
      "Вместимость гостиниц кампуса — 5 000 мест.",
      knowledgeSeedCards
    ).summary.red > 0
  );
});
test("Поле показателя отвергает unsafe URL, даты и дубликаты", () => {
  for (const evidenceUrl of [
    "javascript:alert(1)",
    "http://example.org",
    "https://name:password@example.org",
  ])
    assert.equal(
      structuredMetricSchema.safeParse({
        ...midis.structuredMetrics[0],
        evidenceUrl,
      }).success,
      false
    );
  assert.equal(
    structuredMetricSchema.safeParse({
      ...midis.structuredMetrics[0],
      verifiedAt: "2026-02-30",
    }).success,
    false
  );
  assert.equal(
    knowledgeCardInputSchema.safeParse({
      ...midis,
      structuredMetrics: [
        midis.structuredMetrics[0],
        { ...midis.structuredMetrics[0], id: "other" },
      ],
    }).success,
    false
  );
});
test("Аддитивная миграция не заменяет существующий паспорт с другим ID", () => {
  const existing = { ...midis, id: "user-existing-passport" };
  const missing = missingUniversityPassports([existing]);
  assert.equal(missing.length, 6);
  assert.ok(missing.every((card) => card.universityId !== midis.universityId));
  assert.equal(existing.structuredMetrics[0].value, 120);
});
test("Значимая правка совместного проекта сбрасывает старые согласования", () => {
  const joint = knowledgeSeedCards.find(
    (card): card is ProjectCard => card.type === "project" && card.isJoint
  )!;
  const current = {
    ...joint,
    status: "approved" as const,
    participantApprovals: joint.participantUniversityIds,
  };
  const input = knowledgeCardInputSchema.parse({
    ...current,
    readinessStage: "Внедрено",
  });
  const patch = knowledgeUpdateModeration(current, input, {
    id: "fixture-admin",
    name: "Admin",
    isAdmin: true,
  });
  assert.equal(patch.status, "pending");
  assert.deepEqual(patch.participantApprovals, []);
  assert.deepEqual(
    knowledgeUpdateModeration(current, knowledgeCardInputSchema.parse(current)),
    {}
  );
});
test("Новая редакция сохраняет официальную версию до согласования", () => {
  const input = knowledgeCardInputSchema.parse({
    ...midis,
    structuredMetrics: [{ ...midis.structuredMetrics[0], value: 999 }],
  });
  const patch = knowledgeUpdateModeration(midis, input, {
    id: "fixture-editor",
    name: "Editor",
    isAdmin: false,
  });
  const pending = { ...midis, ...input, ...patch } as UniversityCard;
  const result = checkFactText(
    "МИДиС в 2026 году получил 120 мест в кампусе.",
    [pending]
  );
  assert.equal(result.summary.red, 0);
  assert.equal(result.summary.yellow, 0);
  assert.ok(result.summary.green > 0);
  const visible = visibleKnowledgeCards(null, [pending]);
  assert.equal((visible[0] as UniversityCard).structuredMetrics[0].value, 120);
  const approved = checkFactText(
    "МИДиС в 2026 году получил 999 мест в кампусе.",
    [{ ...pending, status: "approved" }]
  );
  assert.ok(approved.summary.green > 0);
  assert.equal(approved.summary.red, 0);
});
test("Видимость редакций, служебных полей и обращений зависит от роли", () => {
  const reader = getDemoAccount("demo-ministry")!;
  const editor = toSessionUser(getDemoAccount("demo-owner-midis")!);
  const guest = getDemoAccount("demo-guest")!;
  const inquiry: CardEditRequest = {
    id: "fixture-request", authorId: reader.id, authorName: reader.name, authorRole: reader.role,
    authorOrganization: reader.organization, message: "Комментарий заявителя", status: "open",
    createdAt: "2026-01-01T00:00:00Z",
  };
  const requests = [inquiry, { ...inquiry, id: "other", authorId: "other-author", message: "Закрытый комментарий" }];
  const published = { ...midis, title: "Публичная версия", editRequests: requests, reviewComment: "Закрытая заметка" };
  const pending: UniversityCard = {
    ...published, title: "Закрытая редакция", status: "pending", submittedBy: "fixture-editor",
    approvedSnapshot: published,
  };
  const fresh = { ...pending, approvedSnapshot: undefined };
  for (const role of [reader, guest, null]) {
    assert.equal(visibleKnowledgeCard(role, fresh), null);
    assert.equal(canRequestEdit(role, fresh), false);
    const view = visibleKnowledgeCard(role, pending)!;
    assert.equal(view.title, published.title);
    assert.equal(view.approvedSnapshot, undefined);
    assert.equal(view.submittedBy, undefined);
    assert.equal(view.reviewComment, undefined);
    assert.equal(view.diskSync, undefined);
    assert.deepEqual(view.editRequests, role === reader ? [inquiry] : undefined);
  }
  const formerAuthor = { ...guest, id: "fixture-editor" };
  assert.equal(visibleKnowledgeCard(formerAuthor, fresh), null);
  assert.equal(visibleKnowledgeCard({ ...guest, id: reader.id }, pending)?.editRequests, undefined);
  assert.equal(canRequestEdit(reader, pending), true);
  assert.equal(canRequestEdit(guest, pending), false);
  assert.equal(visibleKnowledgeCard(editor, pending)?.title, pending.title);
  assert.deepEqual(visibleKnowledgeCard(editor, pending)?.editRequests, requests);
  assert.equal(visibleKnowledgeCard(editor, pending)?.approvedSnapshot?.editRequests, undefined);
  assert.deepEqual(visibleKnowledgeCard(getDemoAccount("demo-admin"), pending)?.editRequests, requests);
  assert.equal(getPublicApprovedCard(published)?.editRequests, undefined);
  assert.deepEqual(pending.approvedSnapshot?.editRequests, requests);
  assert.equal(isCardOwner(editor, [editor.name + "ва"]), false);
  assert.equal(isCardOwner(editor, [editor.ownershipLabel]), true);
});

test("Руководитель выбывающего вуза видит редакцию, подлежащую его подтверждению", () => {
  const participant = toSessionUser(getDemoAccount("demo-owner-csu")!);
  const pr = toSessionUser(getDemoAccount("demo-pr-csu")!);
  const project = knowledgeSeedCards.find((card): card is ProjectCard => card.type === "project")!;
  const revised: ProjectCard = {
    ...project, status: "pending", owners: ["Автор"], submittedBy: "fixture-owner",
    requiredApprovalUniversityIds: ["csu"], participantUniversityIds: [], isJoint: false,
    participantApprovals: [], reviewComment: "Проверить состав участников",
    approvedSnapshot: { ...project, isJoint: true, folderId: "02_joint", title: "Предыдущая редакция",
      participantUniversityIds: ["susu", "csu"], ownerIds: [participant.id] },
  };
  assert.equal(visibleKnowledgeCard(participant, revised)?.title, revised.title);
  assert.equal(canConfirmJointParticipation(participant, revised), true);
  assert.equal(visibleKnowledgeCard(pr, revised)?.title, revised.approvedSnapshot?.title);
  assert.equal(canConfirmJointParticipation(pr, revised), false);
  assert.equal(canConfirmJointParticipation(participant, { ...revised, status: "rejected" }), false);
});
console.log(`${passed} university fact/lifecycle regressions passed.`);
