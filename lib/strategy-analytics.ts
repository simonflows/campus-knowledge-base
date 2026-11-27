import { getApprovedVersion, type KnowledgeCard } from "./knowledge";
import { getCardVersionId } from "./knowledge-versions";
import type { SourceVersionReference } from "./source-references";
import {
  getCurrentStrategyEvidence,
  isRoadmapIndicator,
  type IndicatorMeasurement,
  type IndicatorScope,
  type IndicatorSlot,
  type StrategyDocumentOption,
  type StrategyLink,
} from "./strategy";
import {
  getTrustedIndicatorMeasurement,
  strategyOptionsForCards,
} from "./strategy-server";
import type { StrategyAnalyticsQuery } from "./validation/analytics";

type CardReference = SourceVersionReference & { title: string };

export type StrategyAnalyticsMeasurement =
  | { status: "missing" | "stale" }
  | {
      status: "confirmed";
      value: number;
      date: string;
      source: { card: CardReference; clauseLocator: string };
    };

export type StrategyAnalyticsReport = {
  document: CardReference;
  target: { kind: "clause" | "direction"; label: string } | null;
  projects: { card: CardReference; status: "current" | "stale" }[];
  indicators: {
    card: CardReference;
    definition: string;
    scope: IndicatorScope;
    unit: string;
    plan: StrategyAnalyticsMeasurement;
    actual: StrategyAnalyticsMeasurement;
  }[];
};

function documentReference({
  cardId,
  versionId,
  title,
}: StrategyDocumentOption): CardReference {
  return { cardId, versionId, title };
}

function cardReference(card: KnowledgeCard): CardReference {
  return {
    cardId: card.id,
    versionId: getCardVersionId(card),
    title: card.title,
  };
}

export function buildStrategyAnalyticsReport(
  query: StrategyAnalyticsQuery,
  cards: readonly KnowledgeCard[]
): StrategyAnalyticsReport | null {
  const { documents } = strategyOptionsForCards(
    cards.filter(
      (card) =>
        card.type === "custom" || card.approvedSnapshot?.type === "custom"
    )
  );
  const documentsById = new Map(
    documents.map((document) => [document.cardId, document])
  );
  const selected = documentsById.get(query.documentId);
  if (!selected || selected.versionId !== query.documentVersionId) return null;
  const { cardId: documentId, versionId: documentVersionId } = selected;

  const { target } = query;
  const clauses = new Map(
    selected.document.clauses.map((clause) => [clause.id, clause])
  );
  const targetLabel =
    target?.kind === "clause"
      ? clauses.get(target.id)?.locator
      : selected.document.directions.find(({ id }) => id === target?.id)?.title;
  if (target && !targetLabel) return null;

  function matchesTarget(clauseId?: string, directionId?: string) {
    if (!target) return true;
    if (target.kind === "clause") return clauseId === target.id;
    return (
      directionId === target.id ||
      Boolean(
        clauseId && clauses.get(clauseId)?.directionIds.includes(target.id)
      )
    );
  }

  function linkStatus(link: StrategyLink) {
    if (
      link.document.cardId !== documentId ||
      !matchesTarget(link.clauseId, link.directionId)
    )
      return null;
    const evidenceDocument = documentsById.get(link.evidence.document.cardId);
    if (!evidenceDocument) return null;
    if (
      link.document.versionId !== documentVersionId ||
      link.evidence.document.versionId !== evidenceDocument.versionId
    )
      return "stale";
    return getCurrentStrategyEvidence(link.evidence, documentsById)
      ? "current"
      : null;
  }

  const report: StrategyAnalyticsReport = {
    document: documentReference(selected),
    target:
      target && targetLabel ? { kind: target.kind, label: targetLabel } : null,
    projects: [],
    indicators: [],
  };
  const matchingCardIds = new Set<string>();
  const published = cards.flatMap((card) => {
    const approved = getApprovedVersion(card);
    return approved ? [{ card, approved }] : [];
  });
  for (const { approved } of published) {
    if (approved.type !== "project" && approved.type !== "laboratory") continue;
    const statuses = approved.strategyLinks?.map(linkStatus);
    const status = statuses?.includes("current")
      ? "current"
      : statuses?.includes("stale")
        ? "stale"
        : null;
    if (status) {
      if (status === "current") matchingCardIds.add(approved.id);
      if (approved.type === "project")
        report.projects.push({ card: cardReference(approved), status });
    }
  }

  function assessSlot(
    measurement: IndicatorMeasurement | null,
    kind: IndicatorSlot
  ): StrategyAnalyticsMeasurement {
    if (!measurement) return { status: "missing" };
    const { evidence, value, date } = measurement;
    const currentDocument = documentsById.get(evidence.document.cardId);
    if (
      currentDocument &&
      currentDocument.versionId !== evidence.document.versionId
    )
      return { status: "stale" };
    const cited = getCurrentStrategyEvidence(evidence, documentsById, kind);
    if (!cited) return { status: "missing" };
    return {
      status: "confirmed",
      value,
      date,
      source: {
        card: documentReference(cited.source),
        clauseLocator: cited.clause.locator,
      },
    };
  }

  for (const { card, approved } of published) {
    if (!isRoadmapIndicator(approved)) continue;
    const { definition, unit, scope, relatedCardIds } =
      approved.roadmapIndicator;
    const plan = getTrustedIndicatorMeasurement(card, "plan");
    const actual = getTrustedIndicatorMeasurement(card, "actual");
    const matchesEvidence = [plan, actual].some(
      (slot) =>
        slot?.evidence.document.cardId === selected.cardId &&
        matchesTarget(slot.evidence.clauseId)
    );
    if (
      !matchesEvidence &&
      !relatedCardIds.some((id) => matchingCardIds.has(id))
    )
      continue;
    report.indicators.push({
      card: cardReference(approved),
      definition,
      unit,
      scope,
      plan: assessSlot(plan, "plan"),
      actual: assessSlot(actual, "actual"),
    });
  }

  const byTitle = (a: { card: CardReference }, b: { card: CardReference }) =>
    a.card.title.localeCompare(b.card.title, "ru") ||
    a.card.cardId.localeCompare(b.card.cardId);
  report.projects.sort(byTitle);
  report.indicators.sort(byTitle);
  return report;
}
