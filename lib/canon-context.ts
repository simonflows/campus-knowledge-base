import { getApprovedVersion, getUniversityName, placementStatusLabels, type KnowledgeCard } from "./knowledge";

export type CanonFact = { id: string; field: string; label: string; text: string };
export type CanonSource = {
  id: string;
  cardId: string;
  versionId: string;
  title: string;
  type: KnowledgeCard["type"];
  href: string;
  facts: CanonFact[];
  constraints: string[];
};
export type CanonQuoteInput = { sourceId: string; factId: string; quote: string };
export type CanonCitation = CanonQuoteInput & {
  cardId: string;
  versionId: string;
  title: string;
  href: string;
  field: string;
  label: string;
};

/** Explicit public projection: never serialize owners, approval actors or a raw database row. */
export function buildCanonSources(cards: KnowledgeCard[], versions: Record<string, string>): CanonSource[] {
  return cards.flatMap((input, index) => {
    const card = getApprovedVersion(input);
    if (!card) return [];
    const facts: CanonFact[] = [];
    function add(field: string, label: string, value: unknown) {
      if (Array.isArray(value)) {
        value.forEach((item, index) => add(`${field}.${index}`, label, item));
      } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        const text = String(value).trim();
        if (text) facts.push({ id: `f${facts.length + 1}`, field, label, text });
      }
    }
    add("title", "Название", card.title);
    add("referenceDescription", "Утверждённое описание", card.referenceDescription.replace(/https?:\/\/\S+/giu, "").trim());
    if (card.type === "project") {
      add("sphere", "Отрасль", card.sphere);
      add("initiatorUniversityId", "Вуз-инициатор", getUniversityName(card.initiatorUniversityId));
      add("participantUniversityIds", "Вуз-участник", card.participantUniversityIds.map(getUniversityName));
      add("coExecutors", "Соисполнитель", card.coExecutors);
      add("industrialPartner", "Индустриальный партнёр", card.industrialPartner);
      add("readinessStage", "Стадия готовности", card.readinessStage);
      add("contour", "Контур", card.contour);
      add("confirmedFigures", "Подтверждённый показатель", card.confirmedFigures);
    } else if (card.type === "laboratory") {
      add("affiliation", "Принадлежность", card.affiliation);
      add("partner", "Партнёр", card.partner);
      add("head", "Руководитель по публичной карточке", card.head);
      add("placementStatus", "Статус размещения", placementStatusLabels[card.placementStatus]);
      add("placementDetails", "Размещение", card.placementDetails);
      add("workDirections", "Направление работы", card.workDirections);
      add("equipment", "Оборудование", card.equipment);
      add("confirmedIndicators", "Подтверждённый показатель", card.confirmedIndicators);
    } else if (card.type === "campus") {
      card.campusMetrics.forEach((metric, index) => add(`campusMetrics.${index}`, metric.label, `${metric.value}${metric.note ? ` (${metric.note})` : ""}`));
      card.tariffs.forEach((tariff, index) => add(`tariffs.${index}`, tariff.label, tariff.value));
      card.legalEntities.forEach((entity, index) => add(`legalEntities.${index}`, entity.name, entity.role));
    } else if (card.type === "university") {
      add("universityId", "Вуз", getUniversityName(card.universityId));
      card.structuredMetrics.forEach((metric, index) => add(`structuredMetrics.${index}`, metric.label,
        `${getUniversityName(card.universityId)}: ${metric.value} ${metric.unit}, ${metric.year} год, ${metric.kind === "plan" ? "план" : "факт"}`));
    } else if (card.type === "custom") {
      for (const [key, value] of Object.entries(card.customFields)) add(`customFields.${key}`, key, value);
    }
    for (const [index, fact] of (card.verifiedFacts ?? []).entries()) {
      add(`verifiedFacts.${index}`, fact.label,
        `${fact.scope}: ${fact.value} ${fact.unit}, ${fact.year} год, ${fact.kind === "plan" ? "план" : "факт"}`);
    }
    const versionId = versions[card.id] ?? "approved";
    return [{
      id: `s${index + 1}`, cardId: card.id, versionId, title: card.title, type: card.type,
      href: `/knowledge?card=${encodeURIComponent(card.id)}&version=${encodeURIComponent(versionId)}`,
      facts,
      constraints: [card.stopFormula, ...(card.type === "campus" ? card.stopList : [])].filter(Boolean),
    }];
  });
}

export function validateCanonQuote(input: CanonQuoteInput, sources: CanonSource[]): CanonCitation | null {
  const source = sources.find(source => source.id === input.sourceId);
  const fact = source?.facts.find(fact => fact.id === input.factId);
  const quote = input.quote.trim();
  if (!source || !fact || quote.length < 8 || quote.length > 1200 || !fact.text.includes(quote)) return null;
  return {
    // Display and verify the complete canonical field, including negation and qualifications.
    // A model-selected substring must never become a new standalone positive assertion.
    sourceId: source.id, factId: fact.id, quote: fact.text, cardId: source.cardId, versionId: source.versionId,
    title: source.title, href: source.href, field: fact.field, label: fact.label,
  };
}
