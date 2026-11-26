import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { canSeeCard, canUseStaffWorkflow, type SessionUser } from "./auth";
import { isApprovedArticle, type ReadyArticle } from "./articles";
import { docClient } from "./db";
import { listEditorial } from "./editorial-models";
import { getEditorialReadiness, type MaterialCheckRecord } from "./editorial-readiness";
import { getApprovedVersion } from "./knowledge";
import { getApprovedCardVersion, getCardVersionId } from "./knowledge-versions";
import { getAllArticles, getKnowledgeCardById } from "./models";
import { WorkflowError } from "./workflow";
import { TableName } from "./schema";
export type CardUsage = { id: string; kind: "draft" | "publication"; title: string; status: string; channel: string; href: string; versionId: string | null; versionDate: string | null; reviewedVersionId?: string; needsReview: boolean };

async function reviewedPublicationVersion(article: ReadyArticle, cardId: string) {
  if (!article.approval?.revisionId) return undefined;
  const { Item } = await docClient.send(new GetCommand({
    TableName: TableName.WORKFLOW_RECORDS,
    Key: { id: `material-check:${article.id}:${article.approval.revisionId}` }, ConsistentRead: true,
  }));
  const receipt = Item as MaterialCheckRecord | undefined;
  const text = [article.title, article.lead, ...article.sections.flatMap(section => [section.heading, ...section.chunks.map(chunk => chunk.content)])].join("\n\n");
  if (receipt?.kind !== "material-check" || receipt.documentId !== article.id ||
      receipt.revisionId !== article.approval.revisionId ||
      receipt.textHash !== createHash("sha256").update(text).digest("hex")) return undefined;
  // Expose only the reviewed reference. The private receipt and comments stay in the editorial workspace.
  return receipt.reviewedSourceVersions.find(ref => ref.cardId === cardId)?.versionId;
}
export async function findCardUsage(user: SessionUser, cardId: string): Promise<CardUsage[]> {
  if (!canUseStaffWorkflow(user)) throw new WorkflowError("Рабочие связи доступны сотрудникам", 403);
  const card = await getKnowledgeCardById(cardId);
  if (!card || (!canSeeCard(user, card) && !getApprovedVersion(card))) throw new WorkflowError("Карточка не найдена", 404);
  const current = getApprovedVersion(card), currentVersionId = current ? getCardVersionId(current) : null;
  const [documents, articles] = await Promise.all([listEditorial(user), getAllArticles()]);
  const linkedDocuments = documents.filter(document => document.content.sourceCardIds.includes(cardId));
  const rows: CardUsage[] = [];
  const dates = new Map<string, Promise<string | null>>();
  const versionDate = (id: string | null) => {
    if (!id) return Promise.resolve(null);
    const result = dates.get(id) ?? getApprovedCardVersion(id).then(version => version?.snapshot.reviewedAt || version?.recordedAt || null);
    dates.set(id, result); return result;
  };
  for (const document of linkedDocuments) {
    try {
      const readiness = await getEditorialReadiness(user, document.id);
      const versionId = document.content.sourceVersions?.find(ref => ref.cardId === cardId)?.versionId ?? null;
      const reviewedVersionId = readiness.reviewedSourceVersions.find(ref => ref.cardId === cardId)?.versionId;
      rows.push({ id: document.id, kind: "draft", title: document.content.title || "Материал без названия", status: document.status,
        channel: document.channel, href: `/editor?draft=${encodeURIComponent(document.id)}`, versionId, versionDate: await versionDate(versionId),
        ...(reviewedVersionId && { reviewedVersionId }),
        needsReview: readiness.changedSources.some(source => source.cardId === cardId) || readiness.unknownSources.includes(cardId) });
    } catch (error) {
      if (!(error instanceof Error && "status" in error && [403, 404].includes(Number(error.status)))) throw error;
    }
  }
  for (const article of articles) {
    if (!isApprovedArticle(article) || !article.sourceCardIds.includes(cardId)) continue;
    if (linkedDocuments.some(document => document.id === article.id && document.status === "approved" && document.approvedRevisionId === article.approval?.revisionId && document.revisionId === article.approval?.revisionId)) continue;
    const versionId = article.sourceVersions?.find(ref => ref.cardId === cardId)?.versionId ?? null;
    const reviewedVersionId = await reviewedPublicationVersion(article, cardId);
    rows.push({ id: article.id, kind: "publication", title: article.title, status: "approved", channel: article.channel || "Готовая статья",
      href: `/editor?article=${encodeURIComponent(article.id)}`, versionId, versionDate: await versionDate(versionId),
      ...(reviewedVersionId && { reviewedVersionId }), needsReview: !(reviewedVersionId ?? versionId) || (reviewedVersionId ?? versionId) !== currentVersionId });
  }
  return rows;
}
