import {
  getApprovedVersion,
  getPublicApprovedCard,
  getUniversityName,
  type KnowledgeCard,
} from "./knowledge";
import {
  getCardVersionId,
  type ApprovedCardVersion,
} from "./knowledge-versions";
import {
  getCurrentStrategyEvidence,
  INDICATOR_SLOTS,
  isOfficialDocument,
  isRoadmapIndicator,
  type IndicatorMeasurement,
  type IndicatorSlot,
} from "./strategy";
import {
  getTrustedIndicatorMeasurement,
  getVersionIndicatorMeasurement,
  strategyOptionsForCards,
  observeStrategyReferences,
  StrategyWriteError,
} from "./strategy-server";
import type {
  StrategySourceProjection,
  StrategySourceFact,
} from "./strategy-evidence";
import type { SourceVersionReference } from "./source-references";

export function hydrateCanonicalStrategySources(
  rawCards: readonly KnowledgeCard[]
): KnowledgeCard[] {
  const publicCards = rawCards.flatMap((raw) => {
    const card = getPublicApprovedCard(raw);
    return card ? [card] : [];
  });
  const rawById = new Map(rawCards.map((card) => [card.id, card]));
  const context = sourceContext(rawCards);
  return publicCards.map((card) =>
    hydrateStrategySource(card, context, (kind) => {
      const raw = rawById.get(card.id);
      return raw ? getTrustedIndicatorMeasurement(raw, kind) : null;
    })
  );
}

export function hydrateHistoricalStrategySource(
  version: ApprovedCardVersion,
  currentRaw: readonly KnowledgeCard[]
): KnowledgeCard {
  return hydrateStrategySource(
    version.snapshot,
    sourceContext(currentRaw),
    (kind) => getVersionIndicatorMeasurement(version, kind)
  );
}

/** Values require both an independent receipt and the exact currently approved document clause. */
function sourceContext(currentRaw: readonly KnowledgeCard[]) {
  const options = strategyOptionsForCards(currentRaw);
  const docs = new Map(options.documents.map((doc) => [doc.cardId, doc]));
  const published = new Map(
    currentRaw.flatMap((raw) => {
      const approved = getApprovedVersion(raw);
      return approved ? [[raw.id, approved] as const] : [];
    })
  );
  return { docs, published };
}

function hydrateStrategySource(
  card: KnowledgeCard,
  { docs, published }: ReturnType<typeof sourceContext>,
  measurement: (kind: IndicatorSlot) => IndicatorMeasurement | null
): KnowledgeCard {
  const facts: StrategySourceFact[] = [];
  const dependencies = new Map<string, SourceVersionReference>();
  let current = true;
  function add(field: string, label: string, text: string) {
    facts.push({ field, label, text });
  }
  function depend(ref: SourceVersionReference) {
    dependencies.set(ref.cardId, ref);
    const source = published.get(ref.cardId);
    if (!source || getCardVersionId(source) !== ref.versionId) current = false;
  }
  if (isOfficialDocument(card)) {
    const doc = card.officialDocument;
    add(
      "document.identity",
      "Документ",
      `Документ «${card.title}», ${doc.sourceOrganization}, редакция ${doc.edition} от ${doc.date}.`
    );
    for (const clause of doc.clauses) {
      const qualifier =
        clause.kind === "plan"
          ? "План, не достигнутый результат"
          : clause.kind === "actual"
            ? "Сведения о факте в документе"
            : "Контекст документа";
      add(
        `document.clauses.${clause.id}`,
        qualifier,
        `${qualifier}: документ «${card.title}», редакция ${doc.edition} от ${doc.date}, пункт ${clause.locator}: «${clause.excerpt}».`
      );
    }
  }
  if (isRoadmapIndicator(card)) {
    const data = card.roadmapIndicator;
    const scope =
      data.scope.kind === "campus"
        ? "кампус «Южный Урал»"
        : data.scope.kind === "university"
          ? getUniversityName(data.scope.universityId)
          : data.scope.label;
    add(
      "indicator.definition",
      "Определение показателя",
      `Показатель «${card.title}»: ${data.definition} Единица: ${data.unit}. Контур: ${scope}.`
    );
    for (const kind of INDICATOR_SLOTS) {
      const claimed = data[kind];
      if (!claimed) continue;
      depend(claimed.evidence.document);
      const trusted = measurement(kind);
      const evidence =
        trusted && getCurrentStrategyEvidence(trusted.evidence, docs, kind);
      if (!evidence) {
        current = false;
        continue;
      }
      const label =
        kind === "plan" ? "Плановое значение" : "Фактическое значение";
      const qualifier =
        kind === "plan"
          ? `план к ${trusted.date}, не достигнутый результат`
          : `факт по состоянию на ${trusted.date}`;
      add(
        `indicator.${kind}`,
        label,
        `Показатель «${card.title}», ${scope}: ${new Intl.NumberFormat("ru-RU", { maximumSignificantDigits: 21 }).format(trusted.value)} ${data.unit}; ${qualifier}. Источник: «${evidence.source.title}», редакция ${evidence.source.document.edition} от ${evidence.source.document.date}, пункт ${evidence.clause.locator}.`
      );
    }
  }
  if (card.type === "project" || card.type === "laboratory") {
    for (const [index, link] of (card.strategyLinks ?? []).entries()) {
      depend(link.document);
      depend(link.evidence.document);
      const source = docs.get(link.document.cardId);
      const evidence = getCurrentStrategyEvidence(link.evidence, docs);
      const clause = source?.document.clauses.find(
        (item) => item.id === link.clauseId
      );
      const direction = source?.document.directions.find(
        (item) => item.id === link.directionId
      );
      if (
        !source ||
        source.versionId !== link.document.versionId ||
        !evidence ||
        (link.clauseId && !clause) ||
        (link.directionId && !direction)
      ) {
        current = false;
        continue;
      }
      add(
        `strategyLinks.${index}`,
        "Связь со стратегией",
        `В карточке «${card.title}» согласована связь с документом «${source.title}», редакция ${source.document.edition}, ${clause ? `пункт ${clause.locator}` : `направление «${direction!.title}»`}: ${link.explanation} Это связь с документом, а не подтверждение достижения показателей.`
      );
    }
  }
  const projection: StrategySourceProjection = {
    strategySourceFacts: facts,
    strategyDependencies: [...dependencies.values()],
    strategyEvidenceCurrent: current,
  };
  // Only the separate view metadata changes; cardContent and every pinned hash stay identical.
  return Object.assign({ ...card }, projection);
}

/** Observe dependency heads for one read; callers put these same heads in their write transaction. */
export async function observeSourceDependencies(
  cards: readonly KnowledgeCard[],
  readCard: (id: string) => Promise<KnowledgeCard | null>
) {
  const rows = new Map<string, KnowledgeCard>();
  const reads = new Map<string, Promise<KnowledgeCard | null>>();
  const read = (id: string) => {
    let pending = reads.get(id);
    if (!pending) {
      pending = readCard(id).then((row) => {
        if (row) rows.set(id, row);
        return row;
      });
      reads.set(id, pending);
    }
    return pending;
  };
  let current = true;
  for (const card of cards) {
    try {
      await observeStrategyReferences(card, read);
    } catch (error) {
      if (error instanceof StrategyWriteError) current = false;
      else throw error;
    }
  }
  return { rows: [...rows.values()], current };
}

export function decorateStrategyVisibleCards(
  raw: readonly KnowledgeCard[],
  visible: readonly KnowledgeCard[]
): KnowledgeCard[] {
  const projected = new Map(
    hydrateCanonicalStrategySources(raw).map((card) => [card.id, card])
  );
  return visible.map((card) => {
    const source = projected.get(card.id);
    if (!source) return card;
    const projection = {
      strategySourceFacts: (source as KnowledgeCard & StrategySourceProjection)
        .strategySourceFacts,
      strategyDependencies: (source as KnowledgeCard & StrategySourceProjection)
        .strategyDependencies,
      strategyEvidenceCurrent: (
        source as KnowledgeCard & StrategySourceProjection
      ).strategyEvidenceCurrent,
    };
    return card.status === "approved"
      ? Object.assign({ ...card }, projection)
      : card.approvedSnapshot
        ? {
            ...card,
            approvedSnapshot: Object.assign(
              { ...card.approvedSnapshot },
              projection
            ),
          }
        : card;
  });
}
