import { checkFactText, type FactCheckFinding, type FactCheckSummary } from "./fact-check";
import { getApprovedVersion, getUniversityName, type KnowledgeCard } from "./knowledge";

type EditorialFinding = Pick<FactCheckFinding, "id" | "level" | "title" | "quote" | "sourceCardId">;
type CitedFragment = { quote: string; claim: string; sourceIds: string[] };

const sentences = new Intl.Segmenter("ru", { granularity: "sentence" });
const numberFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 12 });
const citation = /\[([^[\]\r\n]*)\]/gu;
const neutralHeadings = new Set([
  "введение", "заключение", "источники", "контекст", "описание", "показатели", "справка",
]);

function fragments(text: string): string[] {
  return text
    .split(/[\r\n]+/u)
    .flatMap(line => Array.from(sentences.segment(line), ({ segment }) => segment.trim()))
    .filter(Boolean);
}

function citedFragments(text: string): CitedFragment[] {
  return text.split(/[\r\n]+/u).flatMap(line => {
    // Spaces preserve offsets and keep citations after a period with the
    // preceding sentence, including the editor's ". [card-id]" format.
    const masked = line.replace(citation, match => " ".repeat(match.length));
    return Array.from(sentences.segment(masked), ({ index, segment }) => {
      const quote = line.slice(index, index + segment.length).trim();
      return {
        quote,
        claim: segment.trim(),
        sourceIds: Array.from(quote.matchAll(citation), match => match[1]),
      };
    });
  });
}

function normalizedClaim(text: string) {
  return text.trim().normalize("NFC").toLowerCase()
    .replace(/ё/gu, "е")
    .replace(/^(?:по данным|согласно данным) (?:(?:официальной|утвержденной) )?карточки\s*,\s*/u, "")
    .replace(/[«»"'„“”]/gu, "")
    .replace(/\s[—–]\s/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/(?<![ .:])[ .:]+$/u, "")
    .trim();
}

function evidencePhrases(card: KnowledgeCard): string[] {
  const phrases = [
    card.title, card.referenceDescription,
    ...(card.verifiedFacts ?? []).map(fact =>
      `${fact.scope}: ${fact.label} за ${fact.year} год (${fact.kind === "plan" ? "план" : "факт"}) — ${fact.value} ${fact.unit}`),
  ];
  if (card.type === "project") {
    phrases.push(`Проект «${card.title}»`, ...card.confirmedFigures,
      `Контур реализации — «${card.contour}», текущая стадия готовности — «${card.readinessStage}»`);
  }
  if (card.type === "laboratory") {
    phrases.push(card.placementDetails, ...card.confirmedIndicators,
      `Партнёр направления — ${card.partner}`,
      `Основные направления работ: ${card.workDirections.join(", ")}`,
      `Оборудование, указанное в официальных данных: ${card.equipment.join(", ")}`);
  }
  if (card.type === "campus") {
    phrases.push(...card.campusMetrics.map(metric => `${metric.label}: ${metric.value} (${metric.note})`),
      ...card.tariffs.map(tariff => `${tariff.label} — ${tariff.value}`),
      ...card.legalEntities.map(entity => `${entity.name} — ${entity.role}`));
  }
  if (card.type === "university") {
    const name = getUniversityName(card.universityId);
    phrases.push(`${name}: показатели по паспорту вуза`, `Показатели ${name} по годам`,
      ...card.structuredMetrics.flatMap(metric => {
        const value = numberFormat.format(metric.value);
        const period = `${name} за ${metric.year} год (${metric.kind === "plan" ? "план" : "факт"})`;
        return [
          `${period} — ${metric.label} составляет ${value} ${metric.unit}`,
          `${period} — ${metric.label}: ${value} ${metric.unit}`,
        ];
      }));
  }
  return phrases;
}

/** Require evidence for each clause, including clauses that lack numeric or named-entity matches. */
export function checkEditorialEvidence(text: string, inputs: KnowledgeCard[]) {
  const cards = inputs.flatMap(card => {
    const approved = getApprovedVersion(card);
    return approved ? [approved] : [];
  });
  const evidence = new Map<string, Set<string>>();
  for (const card of cards) {
    for (const phrase of evidencePhrases(card).flatMap(fragments)) {
      const key = normalizedClaim(phrase);
      if (!key) continue;
      const sources = evidence.get(key) ?? new Set<string>();
      sources.add(card.id);
      evidence.set(key, sources);
    }
  }

  const checked = checkFactText(text.replace(citation, " "), cards);
  const exact: EditorialFinding[] = [];
  const uncovered: EditorialFinding[] = [];
  for (const [index, { quote, claim, sourceIds }] of citedFragments(text).entries()) {
    const key = normalizedClaim(claim);
    if (!sourceIds.length && (!key || neutralHeadings.has(key))) continue;
    const sources = evidence.get(key);
    const sourceCardId = sourceIds.every(id => sources?.has(id))
      ? sourceIds[0] ?? sources?.values().next().value
      : undefined;
    if (sourceCardId) {
      exact.push({ id: `source-evidence-${index}`, level: "green", title: "Фрагмент подтверждён источником", quote, sourceCardId });
    } else {
      uncovered.push({ id: `unverified-clause-${index}`, level: "yellow", title: "Фрагмент требует ручной сверки", quote, sourceCardId: null });
    }
  }
  const factFindings = checked.findings.filter(finding =>
    !exact.length || finding.title !== "Подтверждение не найдено" || finding.sourceCardId !== null);
  const findings: EditorialFinding[] = [...factFindings, ...uncovered, ...exact];
  const summary: FactCheckSummary = { red: 0, yellow: 0, green: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return { findings, summary, canPublish: exact.length > 0 && summary.red === 0 && summary.yellow === 0 };
}
