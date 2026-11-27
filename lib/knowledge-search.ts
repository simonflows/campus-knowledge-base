import { isManagedStrategyCard } from "./strategy";
import {
  sourceDescription,
  strategySearchFragments,
} from "./strategy-evidence";
import {
  getUniversityName,
  placementStatusLabels,
  type KnowledgeCard,
} from "./knowledge";
import { universities } from "./data";
import {
  indexKnowledgeFragment,
  knowledgeQueryTerms,
  matchKnowledgeTerm,
  normalizeKnowledgeText,
  sameKnowledgeWord,
  withoutSourceUrls,
} from "./knowledge-query";

function universityNames(id: string) {
  const university = universities.find((item) => item.id === id);
  return university ? [university.shortName, university.fullName] : [];
}

/** Search card content already filtered by the caller's access policy. */
function structuredFragments(card: KnowledgeCard): string[] {
  if (isManagedStrategyCard(card)) return strategySearchFragments(card);
  const common = (card.verifiedFacts ?? []).map((fact) =>
    [
      fact.scope,
      fact.label,
      fact.value,
      fact.unit,
      fact.year,
      fact.kind === "plan" ? "план" : "факт",
    ].join(" ")
  );
  switch (card.type) {
    case "campus":
      return [
        ...common,
        ...card.campusMetrics.map((metric) =>
          [metric.label, metric.value, metric.note].join(" ")
        ),
        ...card.tariffs.map((item) => [item.label, item.value].join(" ")),
        ...card.legalEntities.map((item) => [item.name, item.role].join(" ")),
      ];
    case "project":
      return [
        ...common,
        card.sphere,
        card.industrialPartner,
        card.contour,
        card.readinessStage,
        ...card.confirmedFigures,
        ...universityNames(card.initiatorUniversityId),
        ...card.participantUniversityIds.flatMap(universityNames),
        ...card.coExecutors,
      ];
    case "laboratory":
      return [
        ...common,
        card.affiliation,
        card.partner,
        placementStatusLabels[card.placementStatus],
        card.placementDetails,
        ...card.workDirections,
        ...card.confirmedIndicators,
      ];
    case "custom":
      return [
        ...common,
        ...Object.values(card.customFields).flatMap((value) =>
          Array.isArray(value) ? value : value == null ? [] : [String(value)]
        ),
      ];
    case "university":
      return [
        ...common,
        getUniversityName(card.universityId),
        ...universityNames(card.universityId),
        ...(card.structuredMetrics ?? []).map((metric) =>
          [
            metric.label,
            metric.value,
            metric.unit,
            metric.year,
            metric.kind === "plan" ? "План" : "Актуальные данные",
          ].join(" ")
        ),
      ];
  }
}

function searchFields(card: KnowledgeCard, structuredOnly: boolean) {
  const candidates: Array<[string, number]> = [
    [card.title, 10],
    [card.id, 8],
    ...(card.type === "laboratory"
      ? card.equipment.map((item): [string, number] => [item, 6])
      : []),
    ...structuredFragments(card).map((item): [string, number] => [item, 4]),
    ...(structuredOnly
      ? []
      : sourceDescription(card)
          .split(/\r?\n/u)
          .map((line): [string, number] => [line, 1])),
  ];
  const fields = new Map<string, number>();
  for (const [value, weight] of candidates) {
    const text = withoutSourceUrls(value);
    if (text && !fields.has(text)) fields.set(text, weight);
  }
  return [...fields].map(([text, weight]) => ({
    ...indexKnowledgeFragment(text),
    weight,
  }));
}

export function searchableFragments(card: KnowledgeCard): string[] {
  return searchFields(card, false).map(({ text }) => text);
}

const equipmentKind =
  /^(?:робот[а-я]*|контроллер[а-я]*|стан(?:ок|к[а-я]*)|принтер[а-я]*|манипулятор[а-я]*|датчик[а-я]*|сканер[а-я]*|тренажер[а-я]*|стенд[а-я]*|микроскоп[а-я]*)$/u;
const modelToken =
  /^(?:[a-z][a-z\d-]{1,}|\p{L}[\p{L}\p{N}-]*\d[\p{L}\p{N}-]*|\d[\p{L}\p{N}.-]*)$/u;
const equipmentModifier =
  /^[а-я]{4,}(?:ый|ий|ая|яя|ое|ее|ые|ие|ого|его|ому|ему|ыми|ими|ых|их|ым|им|ую|юю|ой|ей)$/u;
const nextEquipment = /^(?:для|и|или|но|на|в|при|с|со)$/u;
type EquipmentFragment = ReturnType<typeof indexKnowledgeFragment>;

function equipmentUnits(
  field: EquipmentFragment,
  isModel: (word: string) => boolean
) {
  const normalized = normalizeKnowledgeText(field.text);
  const groups: Array<{
    words: string[];
    heads: Array<{ start: number; end: number }>;
  }> = [];
  let words: string[] = [];
  let heads: Array<{ start: number; end: number }> = [];
  function flush() {
    groups.push({ words, heads });
    words = [];
    heads = [];
  }
  for (const [index, item] of field.words.entries()) {
    const previous = field.words[index - 1];
    const separator = previous
      ? normalized.slice(previous.index + previous.word.length, item.index)
      : "";
    if (/[,;.!?]/u.test(separator) || nextEquipment.test(item.word)) flush();
    if (nextEquipment.test(item.word)) continue;
    if (equipmentKind.test(item.word)) {
      const latest = heads.at(-1);
      if (separator === "-" && latest?.end === words.length - 1) {
        // A compound kind such as «робот-манипулятор» describes one unit.
        latest.end = words.length;
      } else {
        heads.push({ start: words.length, end: words.length });
      }
    }
    words.push(item.word);
  }
  flush();
  return groups.flatMap(({ words, heads }) => {
    if (!heads.length) return [];
    const prefix = words.slice(0, heads[0].start);
    const suffix = words.slice(heads[heads.length - 1].end + 1);
    // When several kinds appear without a delimiter, the outer model positions
    // distinguish «A робот B контроллер» from «робот A контроллер B».
    const modelFirst = prefix.some(isModel) && !suffix.some(isModel);
    return heads.map(({ start, end }, index) => ({
      kinds: words.slice(start, end + 1),
      details: [
        ...(index === 0
          ? prefix
          : modelFirst
            ? words.slice(heads[index - 1].end + 1, start)
            : []),
        ...(index === heads.length - 1
          ? suffix
          : modelFirst
            ? []
            : words.slice(end + 1, heads[index + 1].start)),
      ],
    }));
  });
}

function matchesEquipmentConstraints(
  terms: string[][],
  catalog: EquipmentFragment[],
  fields: EquipmentFragment[]
): boolean {
  const query = indexKnowledgeFragment(terms.flat().join(" "));
  if (!query.words.some(({ word }) => equipmentKind.test(word))) return true;
  const aliases = query.words
    .map(({ word }) => word)
    .filter(
      (word) =>
        word.length >= 4 &&
        !equipmentKind.test(word) &&
        !equipmentModifier.test(word) &&
        catalog.some((item) => matchKnowledgeTerm(item, [word]) >= 0)
    );
  const isModel = (word: string) =>
    modelToken.test(word) ||
    aliases.some((alias) => sameKnowledgeWord(word, alias));
  for (const { kinds, details } of equipmentUnits(query, isModel)) {
    const model = details.filter(isModel);
    if (!model.length) continue;
    const modifiers = details.filter((word) => equipmentModifier.test(word));
    const listed = catalog.filter((item) =>
      model.some((word) => matchKnowledgeTerm(item, [word]) >= 0)
    );
    // An explicit equipment record takes precedence over incidental mentions in
    // the card title, description, or the names of other equipment.
    const evidence = listed.length ? listed : fields;
    const confirmed = evidence.some((field) =>
      equipmentUnits(field, isModel).some(
        (unit) =>
          kinds.every((kind) =>
            unit.kinds.some((word) => sameKnowledgeWord(word, kind))
          ) &&
          modifiers.every((modifier) =>
            unit.details.some((word) => sameKnowledgeWord(word, modifier))
          ) &&
          unit.details.some((_, index) =>
            model.every((word, offset) =>
              sameKnowledgeWord(word, unit.details[index + offset] ?? "")
            )
          )
      )
    );
    if (!confirmed) return false;
  }
  return true;
}

export function knowledgeCardMatch(
  card: KnowledgeCard,
  terms: string[][],
  scope: "all" | "structured" | "equipment" = "all"
): number {
  if (
    scope === "equipment" &&
    (card.type !== "laboratory" || !card.equipment.some((item) => item.trim()))
  ) {
    return 0;
  }
  if (terms.length === 0) return 1;
  const catalog =
    card.type === "laboratory"
      ? card.equipment.map((text) => ({
          ...indexKnowledgeFragment(withoutSourceUrls(text)),
          weight: 6,
        }))
      : [];
  const fields =
    scope === "equipment"
      ? catalog
      : searchFields(card, scope === "structured");
  if (!matchesEquipmentConstraints(terms, catalog, fields)) return 0;
  let score = 0;
  for (const term of terms) {
    const best = fields.find((field) => matchKnowledgeTerm(field, term) >= 0);
    if (!best) return 0;
    score += best.weight;
  }
  return score;
}

export function searchKnowledgeCards(
  cards: KnowledgeCard[],
  query: string
): KnowledgeCard[] {
  const terms = knowledgeQueryTerms(query);
  if (!terms.length) return query.trim() ? [] : cards;
  return cards
    .map((card) => ({ card, score: knowledgeCardMatch(card, terms) }))
    .filter(({ score }) => score > 0)
    .sort((first, second) => second.score - first.score)
    .map(({ card }) => card);
}

function sourceOffset(text: string, normalizedOffset: number): number {
  let start = 0;
  let end = text.length;
  // Find the first source position whose normalized prefix includes the match.
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (
      normalizeKnowledgeText(text.slice(0, middle + 1)).length <=
      normalizedOffset
    ) {
      start = middle + 1;
    } else {
      end = middle;
    }
  }
  return start;
}

export function getSearchFragment(card: KnowledgeCard, query: string): string {
  const terms = knowledgeQueryTerms(query);
  const best = searchFields(card, false)
    .map((field) => ({
      ...field,
      matches: terms
        .map((term) => matchKnowledgeTerm(field, term))
        .filter((index) => index >= 0),
    }))
    .sort(
      (first, second) =>
        second.matches.length - first.matches.length ||
        second.weight - first.weight
    )[0];
  const text = best?.text ?? "";
  if (text.length <= 260) return text;
  const start = Math.max(0, sourceOffset(text, best.matches[0] ?? 0) - 70);
  const end = start + 260;
  return (
    (start > 0 ? "…" : "") +
    text.slice(start, end) +
    (end < text.length ? "…" : "")
  );
}
