import { createHash, randomUUID } from "node:crypto";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { ReadyArticle } from "./articles";
import type { SessionUser } from "./auth";
import { docClient } from "./db";
import type { DiskSyncStatus } from "./disk-sync";
import { EditorialError, editorialText, type EditorialDocument, type EditorialRevision } from "./editorial";
import { getCurrentEditorialSnapshot } from "./editorial-models";
import { checkEditorialEvidence } from "./editorial-evidence";
import type { FactCheckResult } from "./fact-check";
import { getPublicApprovedCard, type KnowledgeCard } from "./knowledge";
import { isReviewOverdue } from "./knowledge-freshness";
import { ensureApprovedCardVersion, getApprovedCardVersion, getCardVersionId } from "./knowledge-versions";
import { getArticleById, getKnowledgeCardById } from "./models";
import { TableName } from "./schema";
import { sourceVersionSchema, type SourceVersionReference } from "./source-references";

const revisionFields = {
  revisionId: z.string().min(1).max(100),
  version: z.number().int().positive(),
};
export const editorialReadinessMutationSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("check"), ...revisionFields }),
  z.strictObject({
    action: z.literal("review-sources"),
    ...revisionFields,
    sourceVersions: z.array(sourceVersionSchema).min(1).max(20),
    comment: z.string().trim().min(1).max(1000),
  }),
]);
type ReadinessMutation = z.infer<typeof editorialReadinessMutationSchema>;

const EDITORIAL_EVIDENCE_VERSION = 1;
type ReviewedSource = SourceVersionReference & { reviewedAt: string; reviewedBy: string; comment: string };
type StoredCheck = Pick<FactCheckResult, "summary" | "canPublish"> & {
  evidenceVersion?: number;
  findings: Pick<FactCheckResult["findings"][number], "id" | "level" | "title" | "quote" | "sourceCardId">[];
};
export type MaterialCheckRecord = {
  id: string;
  kind: "material-check";
  documentId: string;
  revisionId: string;
  etag: string;
  textHash: string;
  checkedAt: string | null;
  checkedBy?: string;
  sourceVersions: SourceVersionReference[];
  result?: StoredCheck;
  reviewedSourceVersions: ReviewedSource[];
};
type SourceState = {
  cardId: string;
  currentVersionId?: string;
  availableVersionIds: string[];
  overdue?: boolean;
};
type LoadedSource = SourceState & {
  updatedAt?: string;
  current?: KnowledgeCard;
  snapshots: Map<string, KnowledgeCard>;
};

function textHash(revision: EditorialRevision) {
  return createHash("sha256").update(editorialText(revision.content)).digest("hex");
}

function effectiveVersions(revision: EditorialRevision, record: MaterialCheckRecord | null) {
  const pins = new Map(revision.content.sourceVersions?.map((ref) => [ref.cardId, ref.versionId]));
  for (const ref of record?.reviewedSourceVersions ?? []) pins.set(ref.cardId, ref.versionId);
  return [...new Set(revision.content.sourceCardIds)].flatMap((cardId) => {
    const versionId = pins.get(cardId);
    return versionId ? [{ cardId, versionId }] : [];
  });
}

function equalVersions(first: SourceVersionReference[], second: SourceVersionReference[]) {
  return first.length === second.length && first.every((ref, index) =>
    ref.cardId === second[index]?.cardId && ref.versionId === second[index]?.versionId,
  );
}

export function evaluateEditorialReadiness({
  document, revision, sources, record: receipt, publication,
}: {
  document: EditorialDocument;
  revision: EditorialRevision;
  sources: SourceState[];
  record: MaterialCheckRecord | null;
  publication: ReadyArticle | null;
}) {
  const record = receipt?.documentId === document.id && receipt.revisionId === revision.id ? receipt : null;
  const sourceVersions = revision.content.sourceVersions ?? [];
  const effective = effectiveVersions(revision, record);
  const effectiveByCard = new Map(effective.map((ref) => [ref.cardId, ref.versionId]));
  const sourceByCard = new Map(sources.map((source) => [source.cardId, source]));
  const changedSources: { cardId: string; usedVersionId: string | null; currentVersionId: string }[] = [];
  const unknownSources: string[] = [];
  const overdueSources: string[] = [];
  for (const cardId of new Set(revision.content.sourceCardIds)) {
    const state = sourceByCard.get(cardId);
    const usedVersionId = effectiveByCard.get(cardId) ?? null;
    if (!usedVersionId || !state?.currentVersionId || !state.availableVersionIds.includes(usedVersionId)) {
      unknownSources.push(cardId);
    }
    if (state?.currentVersionId && usedVersionId !== state.currentVersionId) {
      changedSources.push({ cardId, usedVersionId, currentVersionId: state.currentVersionId });
    }
    if (state?.overdue) overdueSources.push(cardId);
  }
  const sameRevision = document.revisionId === revision.id
    && editorialText(document.content) === editorialText(revision.content)
    && equalVersions(document.content.sourceVersions ?? [], sourceVersions)
    && JSON.stringify(document.content.sourceCardIds) === JSON.stringify(revision.content.sourceCardIds);
  const approved = sameRevision && document.approvedRevisionId === revision.id
    && document.status === "approved" && publication?.approval?.revisionId === revision.id;
  const approval = {
    status: approved ? "approved" as const : sameRevision && document.status !== "approved" ? document.status : "draft" as const,
    ...(approved && { approvedBy: publication.approval!.approvedBy, approvedAt: publication.approval!.approvedAt }),
  };
  const disk = publication?.approval?.revisionId === revision.id ? publication.diskSync : undefined;
  const syncMatches = disk?.sourceRevisionId === revision.id ||
    disk?.lastSuccessfulExport?.sourceRevisionId === revision.id;
  const diskStatus: DiskSyncStatus | "stale" | "missing" =
    disk?.status === "synced" && !syncMatches ? "stale" : disk?.status ?? "missing";
  const checkCurrent = sameRevision && record?.textHash === textHash(revision)
    && Boolean(record.checkedAt) && record.result?.evidenceVersion === EDITORIAL_EVIDENCE_VERSION
    && equalVersions(record.sourceVersions, effective);
  const check = {
    status: !record?.checkedAt ? "missing" as const
      : !checkCurrent ? "stale" as const
      : record.result?.canPublish ? "passed" as const : "attention" as const,
    checkedAt: record?.checkedAt ?? null,
    summary: checkCurrent ? record?.result?.summary ?? null : null,
    findings: checkCurrent ? record?.result?.findings ?? [] : [],
  };
  const reasons: string[] = [];
  if (!approved) reasons.push("Точная редакция ещё не согласована.");
  if (check.status !== "passed") reasons.push(check.status === "attention"
    ? "Проверка нашла утверждения для ручной сверки."
    : "Нужна проверка точного текста и зафиксированных версий источников.");
  if (!revision.content.sourceCardIds.length) reasons.push("У редакции пока нет источников.");
  if (unknownSources.length) reasons.push("У части источников неизвестна или недоступна точная версия.");
  if (changedSources.length) reasons.push("Источники обновились: нужна ручная сверка.");
  if (diskStatus !== "synced") reasons.push("Выгрузка этой редакции на Диск ещё не подтверждена.");
  const ready = reasons.length === 0;
  if (overdueSources.length) reasons.push("У части карточек истёк срок плановой сверки.");
  return {
    documentId: document.id, revisionId: revision.id, version: document.version,
    revisionNumber: revision.number, ready, reasons, changedSources, unknownSources, overdueSources,
    sourceVersions, reviewedSourceVersions: record?.reviewedSourceVersions ?? [],
    approval, check, disk: { status: diskStatus, syncedAt: syncMatches ? disk?.lastSyncedAt ?? null : null },
  };
}
export type EditorialReadiness = ReturnType<typeof evaluateEditorialReadiness>;

async function readContext(user: SessionUser, documentId: string) {
  const { document, revision } = await getCurrentEditorialSnapshot(documentId, user);
  const id = `material-check:${document.id}:${revision.id}`;
  const [{ Item }, publication] = await Promise.all([
    docClient.send(new GetCommand({ TableName: TableName.WORKFLOW_RECORDS, Key: { id }, ConsistentRead: true })),
    document.approvedRevisionId === revision.id ? getArticleById(document.id) : null,
  ]);
  const stored = Item?.kind === "material-check" ? Item as MaterialCheckRecord : null;
  const record = stored?.documentId === document.id && stored.revisionId === revision.id ? stored : null;
  const selected = new Map(effectiveVersions(revision, record).map((version) => [version.cardId, version.versionId]));
  const sources: LoadedSource[] = await Promise.all([...new Set(revision.content.sourceCardIds)].map(async (cardId) => {
    const used = selected.get(cardId);
    const [raw, previous] = await Promise.all([getKnowledgeCardById(cardId), used ? getApprovedCardVersion(used) : null]);
    const current = raw && getPublicApprovedCard(raw);
    const snapshots = new Map<string, KnowledgeCard>();
    if (!current || !raw) return { cardId, availableVersionIds: [], snapshots };
    const currentVersionId = getCardVersionId(current);
    snapshots.set(currentVersionId, current);
    if (previous?.cardId === cardId && previous.id === used && getCardVersionId(previous.snapshot) === used) {
      snapshots.set(used, previous.snapshot);
    }
    const deadline = current.freshness?.nextReviewAt;
    return { cardId, currentVersionId, availableVersionIds: [...snapshots.keys()], overdue: isReviewOverdue(deadline),
      snapshots, current, updatedAt: raw.updatedAt };
  }));
  return { document, revision, sources, record, publication, id };
}

export async function getEditorialReadiness(user: SessionUser, documentId: string) {
  return evaluateEditorialReadiness(await readContext(user, documentId));
}

export async function updateEditorialReadiness(user: SessionUser, documentId: string, mutation: ReadinessMutation) {
  const context = await readContext(user, documentId);
  const { document, revision, sources, record, id } = context;
  if (document.version !== mutation.version || revision.id !== mutation.revisionId) {
    throw new EditorialError("Открытая редакция изменилась. Обновите материал.", 409);
  }
  const now = new Date().toISOString();
  const hash = textHash(revision);
  const next: MaterialCheckRecord = {
    ...(record ?? { checkedAt: null, sourceVersions: [], reviewedSourceVersions: [] }),
    id, kind: "material-check", documentId, revisionId: revision.id, textHash: hash, etag: randomUUID(),
  };
  const guards: NonNullable<TransactWriteCommandInput["TransactItems"]> = [{
    ConditionCheck: {
      TableName: TableName.EDITORIAL_DOCUMENTS, Key: { id: document.id },
      ConditionExpression: "revisionId = :revision AND #version = :version",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":revision": revision.id, ":version": document.version },
    },
  }];
  const sourceByCard = new Map(sources.map((source) => [source.cardId, source]));
  if (mutation.action === "check") {
    const refs = effectiveVersions(revision, record);
    const available = refs.flatMap((ref) => {
      const card = sourceByCard.get(ref.cardId)?.snapshots.get(ref.versionId);
      return card ? [{ ref, card }] : [];
    });
    const check = checkEditorialEvidence(editorialText(revision.content), available.map(({ card }) => card));
    next.checkedAt = now;
    next.checkedBy = user.id;
    next.sourceVersions = available.map(({ ref }) => ref);
    next.result = {
      evidenceVersion: EDITORIAL_EVIDENCE_VERSION, summary: check.summary, canPublish: check.canPublish,
      findings: check.findings.filter((finding) => finding.level !== "green").slice(0, 30).map(
        ({ id, level, title, quote, sourceCardId }) => ({ id, level, title, quote: quote.slice(0, 500), sourceCardId }),
      ),
    };
  } else {
    const references = mutation.sourceVersions;
    if (new Set(references.map((ref) => ref.cardId)).size !== references.length) {
      throw new EditorialError("Укажите одну версию для каждого источника", 422);
    }
    const reviewed = new Map(next.reviewedSourceVersions.map((ref) => [ref.cardId, ref]));
    const used = new Map(effectiveVersions(revision, record).map((ref) => [ref.cardId, ref.versionId]));
    let changed = false;
    for (const ref of references) {
      const source = sourceByCard.get(ref.cardId);
      if (!source?.current || source.currentVersionId !== ref.versionId || !source.updatedAt) {
        throw new EditorialError("Каноническая версия источника изменилась. Откройте текущую версию.", 409);
      }
      if (used.get(ref.cardId) === ref.versionId) continue;
      await ensureApprovedCardVersion(source.current);
      changed = true;
      reviewed.set(ref.cardId, { ...ref, reviewedAt: now, reviewedBy: user.id, comment: mutation.comment });
      guards.push({
        ConditionCheck: {
          TableName: TableName.KNOWLEDGE_CARDS, Key: { id: ref.cardId },
          ConditionExpression: "updatedAt = :updated",
          ExpressionAttributeValues: { ":updated": source.updatedAt },
        },
      });
    }
    if (!changed) return evaluateEditorialReadiness(context);
    next.reviewedSourceVersions = [...reviewed.values()];
    // The reviewed versions changed. The prior result cannot confirm the newly reviewed evidence.
    next.checkedAt = null;
    next.sourceVersions = [];
    delete next.checkedBy;
    delete next.result;
  }
  guards.push({
    Put: {
      TableName: TableName.WORKFLOW_RECORDS, Item: next,
      ConditionExpression: record ? "etag = :etag" : "attribute_not_exists(id)",
      ...(record && { ExpressionAttributeValues: { ":etag": record.etag } }),
    },
  });
  try {
    await docClient.send(new TransactWriteCommand({ TransactItems: guards }));
  } catch (error) {
    if (error instanceof TransactionCanceledException &&
        error.CancellationReasons?.some(({ Code }) => Code && !["None", "ConditionalCheckFailed", "TransactionConflict"].includes(Code))) {
      throw error;
    }
    if (error instanceof Error && ["TransactionCanceledException", "ConditionalCheckFailedException"].includes(error.name)) {
      throw new EditorialError("Редакция или источник изменились. Обновите паспорт.", 409);
    }
    throw error;
  }
  return getEditorialReadiness(user, documentId);
}
