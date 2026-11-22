import { canConfirmJointParticipation, canConfirmStakeholderApproval, canEditCard, canManageEditRequests, canSeeCard, type SessionUser } from "./auth";
import { universities } from "./data";
import { canReadEditorial, type EditorialDocument } from "./editorial";
import { canAnswerInformationRequest, canSeeInformationRequest, type InformationRequest } from "./information-requests";
import { getApprovedVersion, getCardStatus, type KnowledgeCard } from "./knowledge";
import { canVerifyCardFreshness, isReviewOverdue } from "./knowledge-freshness";
import type { WorkflowRecord } from "./workflow";
import { WorkflowError } from "./workflow-policy";

export type WorkItem = { id: string; kind: string; title: string; reason: string; href: string; responsibleId: string | null; responsibleName: string; dueDate: string | null; state: "action" | "waiting" };
export type QueueReadiness = { changedSources: { cardId: string; usedVersionId: string | null; currentVersionId: string }[]; unknownSources: string[] };
export type WorkQueueInput = { cards: KnowledgeCard[]; documents: EditorialDocument[]; requests: InformationRequest[]; workflows: WorkflowRecord[]; readiness: Record<string, QueueReadiness>; now?: string };
export type UniversityCoverage = { universityId: string; name: string; cards: number; gaps: { cardId: string | null; title: string; reason: string }[] };
export function buildWorkQueue(user: SessionUser, data: WorkQueueInput): WorkItem[] {
  if (user.role === "guest") return [];
  const now = data.now ?? new Date();
  const items: WorkItem[] = [];
  const add = (item: WorkItem) => items.push(item);
  for (const card of data.cards) {
    const href = `/knowledge?card=${encodeURIComponent(card.id)}`;
    const fresh = card.freshness;
    const published = getApprovedVersion(card);
    if (published && isReviewOverdue(fresh?.nextReviewAt, now) && canVerifyCardFreshness(user, card)) {
      const responsibleName = fresh?.responsibleName || published.owners.join(", ") || "Ответственный не назначен";
      add({ id: `freshness:${card.id}`, kind: "freshness", title: published.title, reason: "Истёк назначенный срок повторной сверки", href, responsibleId: fresh?.responsibleId ?? card.ownerIds?.[0] ?? null, responsibleName, dueDate: fresh?.nextReviewAt ?? null, state: "action" });
    }
    if (!canSeeCard(user, card)) continue;
    const status = getCardStatus(card), canEdit = canEditCard(user, card);
    const responsibleId = fresh?.responsibleId ?? card.ownerIds?.[0] ?? null;
    const responsibleName = fresh?.responsibleName || card.owners.join(", ") || "Ответственный не назначен";
    const stakeholder = canConfirmStakeholderApproval(user, card);
    if (status === "pending" && (user.role === "admin" || stakeholder || canConfirmJointParticipation(user, card)))
      add({ id: `card-approval:${card.id}`, kind: "card-approval", title: card.title, reason: user.role === "admin" ? "Карточка ожидает решения координатора" : stakeholder ? "Согласуйте сведения в зоне ответственности вашей организации" : "Нужно подтвердить участие вашего вуза в этой редакции", href, responsibleId: user.id, responsibleName: user.name, dueDate: null, state: "action" });
    if (status === "rejected" && canEdit)
      add({ id: `card-return:${card.id}`, kind: "card-return", title: card.title, reason: card.reviewComment || "Карточка возвращена для уточнения", href, responsibleId, responsibleName, dueDate: null, state: "action" });
    if (canManageEditRequests(user, card)) for (const request of card.editRequests ?? []) {
      const coordinator = user.role === "admin" && (request.recipient === "coordinator" || card.ownerIds?.length === 0);
      if (request.status === "open") add({ id: `card-request:${card.id}:${request.id}`, kind: "card-request", title: card.title, reason: `Запрос на правку от ${request.authorName}`, href, responsibleId: coordinator || user.role !== "admin" ? user.id : responsibleId, responsibleName: coordinator || user.role !== "admin" ? user.name : responsibleName, dueDate: null, state: "action" });
    }
  }
  for (const document of data.documents) {
    if (!canReadEditorial(user, document)) continue;
    const href = `/editor?draft=${encodeURIComponent(document.id)}`;
    const title = document.content.title || "Материал без названия";
    if (document.status === "submitted") {
      const reviewer = document.reviewerId === user.id || (!document.reviewerId && user.role === "admin");
      add({ id: `article-approval:${document.id}`, kind: "article-approval", title, reason: reviewer ? "Редакция ожидает вашего решения" : "Редакция передана на согласование", href,
        responsibleId: document.reviewerId ?? null, responsibleName: document.reviewerName || "Координатор", dueDate: null, state: reviewer ? "action" : "waiting" });
    }
    if (document.status === "returned" && document.ownerId === user.id)
      add({ id: `article-return:${document.id}`, kind: "article-return", title, reason: "Материал возвращён с замечаниями согласующего", href, responsibleId: document.ownerId, responsibleName: document.ownerName, dueDate: null, state: "action" });
    const readiness = data.readiness[document.id];
    for (const change of readiness?.changedSources ?? [])
      add({ id: `source-change:${document.id}:${change.cardId}:${change.currentVersionId}`, kind: "source-change", title, reason: change.usedVersionId ? "После подготовки материала утверждена новая версия источника" : "Версия использованного источника не была зафиксирована. Нужна ручная сверка", href, responsibleId: document.ownerId, responsibleName: document.ownerName, dueDate: null, state: "action" });
    if (readiness?.unknownSources.some(id => !readiness.changedSources.some(change => change.cardId === id)))
      add({ id: `source-unknown:${document.id}`, kind: "source-change", title, reason: "Часть источников недоступна или не имеет закреплённой версии", href, responsibleId: document.ownerId, responsibleName: document.ownerName, dueDate: null, state: "action" });
  }
  for (const request of data.requests) {
    if (!canSeeInformationRequest(user, request)) continue;
    const metadata = request as InformationRequest & { responsibleId?: string | null; responsibleName?: string; dueDate?: string | null; participantIds?: string[] };
    const recipient = canAnswerInformationRequest(user, request);
    const awaitingAnswer = request.status === "open" && (user.role === "admin" || recipient);
    const awaitingAuthor = ["answered", "approved", "rejected"].includes(request.status) && (request.authorId === user.id || metadata.participantIds?.includes(user.id));
    if ((awaitingAnswer && (!metadata.responsibleId || metadata.responsibleId === user.id || user.role === "admin")) || awaitingAuthor)
      add({ id: `request:${request.id}`, kind: "request", title: request.subject,
        reason: awaitingAnswer ? "Нужен ответ на входящий запрос" : request.status === "answered" ? "Получен ответ с источником: проверьте результат" : "Координатор принял решение по карточке из ответа",
        href: `/requests?request=${encodeURIComponent(request.id)}`, responsibleId: awaitingAnswer ? metadata.responsibleId ?? null : user.id,
        responsibleName: awaitingAnswer ? metadata.responsibleName || "Вуз-получатель" : user.name, dueDate: metadata.dueDate ?? null, state: "action" });
  }
  for (const record of data.workflows) {
    if (record.responsibleId !== user.id && user.role !== "admin") continue;
    if (record.kind === "dispute" && record.status === "resolved") continue;
    add({ id: `workflow:${record.id}`, kind: record.kind === "package" ? "package" : "dispute", title: record.title,
      reason: record.kind === "package" ? "Подготовка материалов к общему инфоповоду" : "Нужно сопоставить источники и зафиксировать решение",
      href: `/work?tab=${record.kind === "package" ? "packages" : "disputes"}&record=${encodeURIComponent(record.id)}`,
      responsibleId: record.responsibleId, responsibleName: record.responsibleId === user.id ? user.name : "Назначенный сотрудник", dueDate: record.dueDate, state: "action" });
  }
  return [...new Map(items.map(item => [item.id, item])).values()].sort((a, b) => (a.state === "waiting" ? 1 : 0) - (b.state === "waiting" ? 1 : 0) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.title.localeCompare(b.title, "ru"));
}

function universityIds(card: KnowledgeCard): string[] {
  if (card.type === "university") return [card.universityId];
  if (card.type === "project") return [...new Set([card.initiatorUniversityId, ...card.participantUniversityIds].filter(Boolean))];
  const id = card.folderId.startsWith("01_universities/") ? card.folderId.split("/")[1] : null;
  return id ? [id] : [];
}
function hasEvidence(card: KnowledgeCard) {
  return Boolean(card.sources?.length || card.verifiedFacts?.length || /https:\/\/\S+/u.test(card.referenceDescription) || (card.type === "university" && card.structuredMetrics.some(metric => metric.evidenceUrl)));
}
export function buildUniversityCoverage(user: SessionUser, cards: KnowledgeCard[], now = new Date().toISOString()): UniversityCoverage[] {
  if (user.role !== "admin") throw new WorkflowError("Карта полноты доступна координатору", 403);
  return universities.map(university => {
    const related = cards.filter(card => universityIds(card).includes(university.id));
    const gaps: UniversityCoverage["gaps"] = [];
    if (!related.some(card => card.type === "university" && getApprovedVersion(card)))
      gaps.push({ cardId: null, title: university.fullName, reason: "Нет утверждённого паспорта вуза" });
    for (const card of related) {
      const add = (reason: string) => gaps.push({ cardId: card.id, title: card.title, reason });
      if (!card.title.trim() || !card.referenceDescription.trim()) add("Не заполнено обязательное название или описание");
      if (!getApprovedVersion(card)) add("Сведения ещё не утверждены");
      if (!hasEvidence(card)) add("Не указан проверяемый источник");
      if (!card.owners.length) add("Не указан ответственный за карточку");
      if (!card.freshness?.responsibleId) add("Не назначен ответственный за сверку");
      if (!card.freshness?.lastVerifiedAt) add("Повторная сверка в сервисе ещё не зафиксирована");
      if (isReviewOverdue(card.freshness?.nextReviewAt, now)) add("Просрочен явно назначенный срок сверки");
    }
    return { universityId: university.id, name: university.shortName, cards: related.length, gaps };
  });
}
