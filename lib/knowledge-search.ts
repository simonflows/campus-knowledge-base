import type { KnowledgeCard } from "./knowledge";
import { getUniversityName } from "./knowledge";
const normalize = (value: string) =>
  value
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/(?<=\d)[\s\u00a0]+(?=\d)/g, "")
    .replace(/[\s\u00a0]+/g, " ")
    .trim();
/** Search only supplied ACL-filtered cards. Never include access requests or private metadata. */
export function searchableFragments(card: KnowledgeCard): string[] {
  const base = [
    card.title,
    card.id,
    card.referenceDescription,
    card.stopFormula,
    ...card.owners,
  ];
  if (card.type === "campus")
    return [
      ...base,
      ...card.campusMetrics.map(
        (metric) => `${metric.label}: ${metric.value}. ${metric.note}`
      ),
      ...card.tariffs.map((item) => `${item.label}: ${item.value}`),
      ...card.legalEntities.map((item) => `${item.name}: ${item.role}`),
      ...card.stopList,
    ];
  if (card.type === "project")
    return [
      ...base,
      card.sphere,
      card.industrialPartner,
      card.contour,
      card.readinessStage,
      ...card.confirmedFigures,
      getUniversityName(card.initiatorUniversityId),
      ...card.participantUniversityIds.map(getUniversityName),
      ...card.coExecutors,
    ];
  if (card.type === "laboratory")
    return [
      ...base,
      card.affiliation,
      card.partner,
      card.head,
      card.placementDetails,
      ...card.workDirections,
      ...card.equipment,
      ...card.confirmedIndicators,
    ];
  if (card.type === "custom")
    return [
      ...base,
      ...Object.values(card.customFields).flatMap((value) =>
        Array.isArray(value) ? value : value == null ? [] : [String(value)]
      ),
    ];
  // University metrics are part of the public official card content.
  const university = card as KnowledgeCard & {
    universityId?: string;
    structuredMetrics?: Array<{
      label: string;
      value: number;
      unit: string;
      year: number;
      kind: string;
    }>;
  };
  return [
    ...base,
    university.universityId ? getUniversityName(university.universityId) : "",
    ...(university.structuredMetrics ?? []).map(
      (metric) =>
        `${metric.label}: ${metric.value} ${metric.unit}, ${metric.year}, ${metric.kind === "plan" ? "План" : "Актуальные данные"}`
    ),
  ];
}
function relevance(card: KnowledgeCard, tokens: string[]): number {
  const title = normalize(card.title);
  const fragments = searchableFragments(card).map(normalize);
  if (
    !tokens.every((token) =>
      fragments.some((fragment) => fragment.includes(token))
    )
  )
    return 0;
  return tokens.reduce(
    (score, token) => score + (title.includes(token) ? 10 : 1),
    0
  );
}
export function searchKnowledgeCards(
  cards: KnowledgeCard[],
  query: string
): KnowledgeCard[] {
  const tokens = normalize(query).split(" ").filter(Boolean);
  if (!tokens.length) return cards;
  return cards
    .map((card, index) => ({ card, index, score: relevance(card, tokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.card);
}

function sourceOffset(text: string, normalizedOffset: number): number {
  let start = 0;
  let end = text.length;
  // Find the first source position whose normalized prefix includes the match.
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (normalize(text.slice(0, middle + 1)).length <= normalizedOffset) {
      start = middle + 1;
    } else {
      end = middle;
    }
  }
  return start;
}

export function getSearchFragment(card: KnowledgeCard, query: string): string {
  const tokens = normalize(query).split(" ").filter(Boolean);
  const fragments = searchableFragments(card);
  const fragment =
    [...fragments].sort(
      (a, b) =>
        tokens.filter((token) => normalize(b).includes(token)).length -
        tokens.filter((token) => normalize(a).includes(token)).length
    )[0] ?? card.referenceDescription;
  if (fragment.length <= 260) return fragment;
  const normalized = normalize(fragment);
  const match = tokens
    .map((token) => normalized.indexOf(token))
    .find((index) => index >= 0);
  const start =
    match === undefined ? 0 : Math.max(0, sourceOffset(fragment, match) - 70);
  const end = start + 260;
  return `${start > 0 ? "…" : ""}${fragment.slice(start, end)}${end < fragment.length ? "…" : ""}`;
}
