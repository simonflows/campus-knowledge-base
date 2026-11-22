import {
  checkFactText,
  factCheckSentenceRanges,
  type FactCheckFinding,
  type FactCheckSummary,
} from "./fact-check";
import {
  getApprovedVersion,
  getUniversityName,
  getUniversityFullName,
  type KnowledgeCard,
} from "./knowledge";
import { sameKnowledgeWord, tokenizeKnowledgeText } from "./knowledge-query";

type EditorialFinding = Pick<
  FactCheckFinding,
  "id" | "level" | "title" | "quote" | "sourceCardId"
>;
type CitedFragment = { quote: string; claim: string; context: string; start: number; end: number; sourceIds: string[] };

const numberFormat = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 12,
});
const citation = /\[([^[\]\r\n]*)\]/gu;
const neutralHeadings = new Set([
  "введение",
  "заключение",
  "источники",
  "контекст",
  "описание",
  "показатели",
  "справка",
  "официальная карточка",
  "официальные данные",
  "участники",
  "участники проекта",
  "роли участников",
  "результаты",
  "результаты проекта",
  "практическая польза",
  "направления работы",
  "статус проекта",
  "площадка и статус",
  "кто участвует",
  "что создано",
  "где работает лаборатория",
  "в чем практическая польза",
]);
const numbers =
  /(?<![\p{L}\p{N}-])[-−+]?\d+(?:[   ]\d{3})*(?:[.,]\d+)?(?![\p{L}\p{N}])/gu;
const metricGrammar = new Set(
  "в на по за к год года году получил получила получили выделен выделено выделили составил составила составило составляет составляла составляло было имеется насчитывается план запланировано планирует планируют будет будут предусмотрен предусмотрено данные данным официальным фактический фактическая фактически показатель".split(
    " "
  )
);
const plan =
  /(?:^|[^\p{L}])(?:план[а-яё]*|запланир[а-яё]*|будет|будут|предусмотр[а-яё]*)(?![\p{L}])/iu;

function citedFragments(text: string): CitedFragment[] {
  return Array.from(text.matchAll(/[^\r\n]+/gu)).flatMap((lineMatch) => {
    const line = lineMatch[0];
    // Spaces preserve offsets and keep citations after a period with the
    // preceding sentence, including the editor's ". [card-id]" format.
    const masked = line.replace(citation, (match) => " ".repeat(match.length));
    return factCheckSentenceRanges(masked).map(({ index, text }) => {
      const quote = line.slice(index, index + text.length).trim();
      return {
        quote,
        claim: text.trim(),
        context: line.replace(citation, " "),
        start: lineMatch.index + index + text.length - text.trimStart().length,
        end: lineMatch.index + index + text.trimEnd().length,
        sourceIds: Array.from(quote.matchAll(citation), (match) => match[1]),
      };
    });
  });
}

function normalizedClaim(text: string) {
  return text
    .trim()
    .normalize("NFC")
    .toLowerCase()
    .replace(/ё/gu, "е")
    .replace(
      /^(?:по данным|согласно данным) (?:(?:официальной|утвержденной) )?карточки\s*,\s*/u,
      ""
    )
    .replace(/[«»"'„“”]/gu, "")
    .replace(/\s[—–]\s/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/(?<![ .:])[ .:]+$/u, "")
    .trim();
}

function evidencePhrases(card: KnowledgeCard): string[] {
  const phrases = [
    card.title,
    card.referenceDescription,
    ...(card.verifiedFacts ?? []).map(
      (fact) =>
        `${fact.scope}: ${fact.label} за ${fact.year} год (${fact.kind === "plan" ? "план" : "факт"}) — ${fact.value} ${fact.unit}`
    ),
  ];
  if (card.type === "project") {
    phrases.push(
      `Проект «${card.title}»`,
      ...card.confirmedFigures,
      `Контур реализации — «${card.contour}», текущая стадия готовности — «${card.readinessStage}»`
    );
  }
  if (card.type === "laboratory") {
    phrases.push(
      card.placementDetails,
      ...card.confirmedIndicators,
      `Партнёр направления — ${card.partner}`,
      `Основные направления работ: ${card.workDirections.join(", ")}`,
      `Оборудование, указанное в официальных данных: ${card.equipment.join(", ")}`
    );
  }
  if (card.type === "campus") {
    phrases.push(
      ...card.campusMetrics.map(
        (metric) => `${metric.label}: ${metric.value} (${metric.note})`
      ),
      ...card.tariffs.map((tariff) => `${tariff.label} — ${tariff.value}`),
      ...card.legalEntities.map((entity) => `${entity.name} — ${entity.role}`)
    );
  }
  if (card.type === "university") {
    const name = getUniversityName(card.universityId);
    phrases.push(
      `${name}: показатели по паспорту вуза`,
      `Показатели ${name} по годам`,
      ...card.structuredMetrics.flatMap((metric) => {
        const value = numberFormat.format(metric.value);
        const period = `${name} за ${metric.year} год (${metric.kind === "plan" ? "план" : "факт"})`;
        return [
          `${period} — ${metric.label} составляет ${value} ${metric.unit}`,
          `${period} — ${metric.label}: ${value} ${metric.unit}`,
        ];
      })
    );
  }
  return phrases;
}

function metricSupports(claim: string, card: KnowledgeCard): boolean {
  if (card.type !== "university" || !card.structuredMetrics?.length)
    return false;
  const key = normalizedClaim(claim);
  const words = tokenizeKnowledgeText(key);
  const numeric = [...key.matchAll(numbers)];
  const year = [
    ...key.matchAll(
      /(?<!\d)([12]\d{3})\s+(?:год(?:а|у)?|г\.)(?![\p{L}\p{N}])/gu
    ),
  ];
  const magnitude = numeric.find((match) => match.index !== year[0]?.index);
  const university = [
    getUniversityName(card.universityId),
    getUniversityFullName(card.universityId),
  ]
    .map(tokenizeKnowledgeText)
    .sort((first, second) => second.length - first.length)
    .find(
      (name) =>
        name.length > 0 &&
        words.some((_, index) =>
          name.every((part, offset) => words[index + offset] === part)
        )
    );
  const kind = plan.test(key) ? "plan" : "actual";
  return card.structuredMetrics.some((metric) => {
    if (metric.kind !== kind) return false;
    const label = tokenizeKnowledgeText(metric.label);
    const units = tokenizeKnowledgeText(metric.unit);
    const semantic = [...label, ...units];
    if (!semantic.length) return false;
    const matches = (word: string, text: string[]) =>
      text.some((item) => sameKnowledgeWord(word, item));
    const cue = key.match(
      /^(?:в (?:карточке|паспорте) )?(?:указан[аоы]?|приведен[аоы]?|зафиксирован[аоы]?) (?:фактическ[а-я]* |планов[а-я]* )?(.+)$/u
    );
    if (!numeric.length) {
      if (cue)
        return tokenizeKnowledgeText(cue[1]).every((word) =>
          matches(word, label)
        );
      return Boolean(
        university &&
        words.some((word) => matches(word, label)) &&
        words.every(
          (word) => university.includes(word) || matches(word, semantic)
        )
      );
    }
    if (
      !university ||
      numeric.length !== 2 ||
      year.length !== 1 ||
      Number(year[0][1]) !== metric.year ||
      !magnitude ||
      Number(
        magnitude[0].replace(/[   ]/gu, "").replace(",", ".").replace("−", "-")
      ) !== metric.value ||
      /\d\s*[-–−]\s*\d/u.test(key)
    )
      return false;
    const numericWords = words.filter((word) => /^\d/u.test(word));
    const afterNumber = tokenizeKnowledgeText(
      key.slice(magnitude.index + magnitude[0].length)
    );
    const hasUnit =
      units.length > 0 &&
      units.every((unit, index) =>
        sameKnowledgeWord(unit, afterNumber[index] ?? "")
      );
    const distinctive = label.filter(
      (word) =>
        !matches(word, units) && !["количество", "численность"].includes(word)
    );
    return (
      hasUnit &&
      distinctive.every((word) => matches(word, words)) &&
      words.every(
        (word) =>
          university.includes(word) ||
          numericWords.includes(word) ||
          metricGrammar.has(word) ||
          matches(word, semantic)
      )
    );
  });
}

export function isSafeEditorialOutput(text: string): boolean {
  return !/<\/?[a-z!]|(?:игнорируй|забудь)\s+(?:все |предыдущ|правил|инструкц)|system\s+prompt|ignore\s+(?:all\s+)?(?:previous|the\s+above)/iu.test(
    text
  );
}

/** Require evidence for each clause, including clauses that lack numeric or named-entity matches. */
export function checkEditorialEvidence(text: string, inputs: KnowledgeCard[]) {
  const cards = inputs.flatMap((card) => {
    const approved = getApprovedVersion(card);
    return approved ? [approved] : [];
  });
  const evidence = new Map<string, Set<string>>();
  const completeUnits: Array<{ start: number; end: number; sourceId: string }> = [];
  const citationMasked = text.replace(citation, match => " ".repeat(match.length));
  for (const card of cards) {
    // A source field is one semantic unit. Splitting it can turn a hypothetical
    // or rebutted statement from a later sentence into a positive fact.
    for (const phrase of evidencePhrases(card)) {
      const key = normalizedClaim(phrase);
      if (!key) continue;
      const sources = evidence.get(key) ?? new Set<string>();
      sources.add(card.id);
      evidence.set(key, sources);
      if (/[\r\n]/u.test(phrase)) {
        const literal = phrase.trim().split(/\s+/u)
          .map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("\\s+");
        const wholeUnit = new RegExp(`(?<![\\p{L}\\p{N}])${literal}(?![\\p{L}\\p{N}])`, "giu");
        for (const match of citationMasked.matchAll(wholeUnit)) {
          completeUnits.push({ start: match.index, end: match.index + match[0].length, sourceId: card.id });
        }
      }
    }
  }

  const checked = checkFactText(text.replace(citation, " "), cards);
  const exact: EditorialFinding[] = [];
  const uncovered: EditorialFinding[] = [];
  for (const [index, { quote, claim, context, start, end, sourceIds }] of citedFragments(
    text
  ).entries()) {
    const key = normalizedClaim(claim);
    if (!sourceIds.length && (!key || neutralHeadings.has(key))) continue;
    const sources = new Set([
      ...(evidence.get(key) ?? []),
      // A complete source paragraph can be reproduced, including its scope.
      // This applies only to this paragraph, not another copy elsewhere.
      ...(evidence.get(normalizedClaim(context)) ?? []),
      ...completeUnits.filter(unit => unit.start <= start && unit.end >= end).map(unit => unit.sourceId),
    ]);
    for (const card of cards) {
      if (metricSupports(claim, card)) sources.add(card.id);
    }
    const sourceCardId = sourceIds.every((id) => sources?.has(id))
      ? (sourceIds[0] ?? sources?.values().next().value)
      : undefined;
    if (sourceCardId) {
      exact.push({
        id: `source-evidence-${index}`,
        level: "green",
        title: "Фрагмент подтверждён источником",
        quote,
        sourceCardId,
      });
    } else {
      uncovered.push({
        id: `unverified-clause-${index}`,
        level: "yellow",
        title: "Фрагмент требует ручной сверки",
        quote,
        sourceCardId: null,
      });
    }
  }
  const factFindings = checked.findings.filter(
    (finding) =>
      !exact.length ||
      finding.level !== "yellow" ||
      !(
        (finding.title === "Подтверждение не найдено" &&
          finding.sourceCardId === null) ||
        exact.some(
          (item) =>
            normalizedClaim(item.quote.replace(citation, " ")) ===
            normalizedClaim(finding.quote)
        )
      )
  );
  const findings: EditorialFinding[] = [
    ...factFindings,
    ...uncovered,
    ...exact,
  ];
  const summary: FactCheckSummary = {
    red: 0,
    yellow: 0,
    green: 0,
    total: findings.length,
  };
  for (const finding of findings) summary[finding.level]++;
  return {
    findings,
    summary,
    canPublish:
      isSafeEditorialOutput(text) &&
      exact.length > 0 &&
      summary.red === 0 &&
      summary.yellow === 0,
  };
}
