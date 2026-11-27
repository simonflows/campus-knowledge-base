import { createHash } from "node:crypto";

import { getApprovedVersion, type KnowledgeCard } from "./knowledge";
import {
  getCardVersionId,
  type ApprovedCardVersion,
} from "./knowledge-versions";
import {
  getCurrentStrategyEvidence,
  INDICATOR_SLOTS,
  isOfficialDocument,
  isRoadmapIndicator,
  MAX_STRATEGY_DEPENDENCIES,
  type IndicatorConfirmation,
  type IndicatorMeasurement,
  type IndicatorSlot,
  type StrategyDocumentOption,
  type StrategyOptions,
} from "./strategy";

export class StrategyWriteError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 409
  ) {
    super(message);
  }
}

export type ObservedStrategyReference = { cardId: string; updatedAt: string };

function documentOption(
  card: KnowledgeCard | null
): StrategyDocumentOption | null {
  return isOfficialDocument(card)
    ? {
        cardId: card.id,
        versionId: getCardVersionId(card),
        title: card.title,
        document: card.officialDocument,
      }
    : null;
}

export function strategyOptionsForCards(
  cards: readonly KnowledgeCard[]
): StrategyOptions {
  const options: StrategyOptions = { documents: [], relatedCards: [] };
  for (const card of cards) {
    const published = getApprovedVersion(card);
    const document = documentOption(published);
    if (document) options.documents.push(document);
    if (published?.type === "project" || published?.type === "laboratory") {
      options.relatedCards.push({
        cardId: published.id,
        versionId: getCardVersionId(published),
        title: published.title,
        type: published.type,
      });
    }
  }
  const compare = (
    first: { title: string; cardId: string },
    second: { title: string; cardId: string }
  ) =>
    first.title.localeCompare(second.title, "ru") ||
    first.cardId.localeCompare(second.cardId);
  options.documents.sort(compare);
  options.relatedCards.sort(compare);
  return options;
}

function referenceIds(card: KnowledgeCard): string[] {
  const ids = new Set<string>();
  if (card.type === "project" || card.type === "laboratory") {
    for (const link of card.strategyLinks ?? []) {
      ids.add(link.document.cardId);
      ids.add(link.evidence.document.cardId);
    }
  }
  if (isRoadmapIndicator(card)) {
    for (const id of card.roadmapIndicator.relatedCardIds) ids.add(id);
    for (const kind of INDICATOR_SLOTS) {
      const evidence = card.roadmapIndicator[kind]?.evidence;
      if (evidence) ids.add(evidence.document.cardId);
    }
  }
  if (ids.size > MAX_STRATEGY_DEPENDENCIES || ids.has(card.id)) {
    throw new StrategyWriteError(
      "Проверьте число связанных записей. Карточка не может ссылаться на себя.",
      400
    );
  }
  return [...ids];
}

/** Public card approval is the current read permission for these shared dependencies. */
export function validateKnownStrategyReferences(
  card: KnowledgeCard,
  observed: ReadonlyMap<string, KnowledgeCard>
): ObservedStrategyReference[] {
  const rows = referenceIds(card).map((cardId) => {
    const raw = observed.get(cardId);
    const approved = raw ? getApprovedVersion(raw) : null;
    if (!raw || !approved)
      throw new StrategyWriteError("Связанная утверждённая запись недоступна.");
    return { cardId, approved, updatedAt: raw.updatedAt };
  });
  const documents = new Map(
    rows.flatMap(({ cardId, approved }) => {
      const option = documentOption(approved);
      return option ? [[cardId, option] as const] : [];
    })
  );

  if (card.type === "project" || card.type === "laboratory") {
    for (const link of card.strategyLinks ?? []) {
      const source = documents.get(link.document.cardId);
      if (!source || source.versionId !== link.document.versionId) {
        throw new StrategyWriteError(
          "Выберите текущую утверждённую редакцию документа для связи."
        );
      }
      const clause = source.document.clauses.find(
        (item) => item.id === link.clauseId
      );
      if (
        (!link.clauseId && !link.directionId) ||
        (link.clauseId && !clause) ||
        (link.directionId &&
          (!source.document.directions.some(
            (item) => item.id === link.directionId
          ) ||
            (clause && !clause.directionIds.includes(link.directionId))))
      )
        throw new StrategyWriteError(
          "Пункт и направление должны относиться к выбранной редакции документа."
        );
      if (!getCurrentStrategyEvidence(link.evidence, documents)) {
        throw new StrategyWriteError(
          "Выберите действующую утверждённую выдержку для подтверждения связи."
        );
      }
    }
  }

  if (isRoadmapIndicator(card)) {
    const related = new Set(
      rows
        .filter(
          ({ approved }) =>
            approved.type === "project" || approved.type === "laboratory"
        )
        .map(({ cardId }) => cardId)
    );
    if (card.roadmapIndicator.relatedCardIds.some((id) => !related.has(id))) {
      throw new StrategyWriteError(
        "Для показателя выберите утверждённые проекты или лаборатории."
      );
    }
    for (const kind of INDICATOR_SLOTS) {
      const measurement = card.roadmapIndicator[kind];
      if (
        measurement &&
        !getCurrentStrategyEvidence(measurement.evidence, documents, kind)
      ) {
        throw new StrategyWriteError(
          kind === "plan"
            ? "Выберите действующую утверждённую выдержку, подтверждающую план."
            : "Выберите действующую утверждённую выдержку, подтверждающую факт."
        );
      }
    }
  }
  return rows.map(({ cardId, updatedAt }) => ({ cardId, updatedAt }));
}

export async function observeStrategyReferences(
  card: KnowledgeCard,
  readCard: (id: string) => Promise<KnowledgeCard | null>
): Promise<ObservedStrategyReference[]> {
  const ids = referenceIds(card);
  if (ids.length === 0) return [];
  const rows = await Promise.all(ids.map((id) => readCard(id)));
  return validateKnownStrategyReferences(
    card,
    new Map(rows.flatMap((row) => (row ? [[row.id, row] as const] : [])))
  );
}

function indicatorFingerprint(
  card: KnowledgeCard,
  kind: IndicatorSlot
): string | null {
  if (!isRoadmapIndicator(card)) return null;
  const { definition, unit, scope } = card.roadmapIndicator;
  const measurement = card.roadmapIndicator[kind];
  if (!measurement) return null;
  const { document, clauseId } = measurement.evidence;
  const scopeKey =
    scope.kind === "university"
      ? scope.universityId
      : scope.kind === "other"
        ? scope.label
        : "";
  return createHash("sha256")
    .update(
      JSON.stringify([
        card.id,
        definition,
        unit,
        scope.kind,
        scopeKey,
        kind,
        measurement.value,
        measurement.date,
        document.cardId,
        document.versionId,
        clauseId,
      ])
    )
    .digest("hex");
}

export function createIndicatorConfirmation(
  card: KnowledgeCard,
  kind: IndicatorSlot,
  actorId: string
): IndicatorConfirmation {
  const fingerprint = indicatorFingerprint(card, kind);
  if (!fingerprint)
    throw new StrategyWriteError(
      kind === "plan"
        ? "Сначала внесите плановое значение."
        : "Сначала внесите фактическое значение."
    );
  return { fingerprint, actorId, at: new Date().toISOString() };
}

export function retainedIndicatorConfirmations(
  previous: KnowledgeCard,
  next: KnowledgeCard
) {
  const confirmations: Partial<Record<IndicatorSlot, IndicatorConfirmation>> =
    {};
  if (!isRoadmapIndicator(previous) || !isRoadmapIndicator(next))
    return confirmations;
  for (const kind of INDICATOR_SLOTS) {
    const stored = previous.indicatorConfirmations?.[kind];
    if (stored?.fingerprint === indicatorFingerprint(next, kind))
      confirmations[kind] = stored;
  }
  return confirmations;
}

export function requireConfirmedIndicatorSlots(card: KnowledgeCard): void {
  if (!isRoadmapIndicator(card)) return;
  const missing = INDICATOR_SLOTS.filter(
    (kind) =>
      card.roadmapIndicator[kind] &&
      card.indicatorConfirmations?.[kind]?.fingerprint !==
        indicatorFingerprint(card, kind)
  );
  if (missing.length) {
    const label = missing
      .map((kind) =>
        kind === "plan" ? "плановое значение" : "фактическое значение"
      )
      .join(" и ");
    throw new StrategyWriteError(
      `Перед утверждением отдельно подтвердите ${label}.`
    );
  }
}

/** Only the currently published snapshot can attest to a stored measurement. */
export function getTrustedIndicatorMeasurement(
  card: KnowledgeCard,
  kind: IndicatorSlot
): IndicatorMeasurement | null {
  const approved = getApprovedVersion(card);
  if (!isRoadmapIndicator(approved)) return null;
  const measurement = approved.roadmapIndicator[kind];
  const receipt = approved.indicatorConfirmations?.[kind];
  return measurement &&
    receipt &&
    receipt.fingerprint === indicatorFingerprint(approved, kind)
    ? measurement
    : null;
}

/** Historical trust is independent from whether the pinned source is current today. */
export function getVersionIndicatorMeasurement(
  version: ApprovedCardVersion,
  kind: IndicatorSlot
): IndicatorMeasurement | null {
  if (!isRoadmapIndicator(version.snapshot)) return null;
  return getTrustedIndicatorMeasurement(
    {
      ...version.snapshot,
      indicatorConfirmations: version.indicatorConfirmations,
    },
    kind
  );
}

/** A slot can be confirmed while the other slot awaits a newer source. Final approval still validates all. */
export function indicatorConfirmationReferenceCard(
  card: KnowledgeCard,
  kind: IndicatorSlot
): KnowledgeCard {
  if (!isRoadmapIndicator(card)) return card;
  return {
    ...card,
    roadmapIndicator: {
      ...card.roadmapIndicator,
      relatedCardIds: [],
      plan: kind === "plan" ? card.roadmapIndicator.plan : undefined,
      actual: kind === "actual" ? card.roadmapIndicator.actual : undefined,
    },
  };
}
