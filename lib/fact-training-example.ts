import type { FactCheckPreset } from "./audit-canon-registry";
import { checkFactText } from "./fact-check";
import { getApprovedVersion, type KnowledgeCard } from "./knowledge";

export type ApprovedFactExample = FactCheckPreset & {
  sourceVersions: Record<string, string>;
};

/** Build an educational draft from the same approved corpus used by checking. */
export function buildApprovedFactExample(input: KnowledgeCard[], versionId: (card: KnowledgeCard) => string): ApprovedFactExample | null {
  const cards = input.map(getApprovedVersion).filter((card): card is KnowledgeCard => card !== null);
  const candidates: string[] = [];
  for (const card of cards) {
    if (card.type !== "campus") continue;
    for (const metric of card.campusMetrics) {
      const places = metric.value.match(/(?:^|[,/]\s*)(\d+(?:[ \u00a0\u202f]\d{3})*)\s+(мест(?:а|о)?)\s*(?=$|[,/])/iu);
      if (!places) continue;
      const value = `${places[1]} ${places[2]}`;
      const label = metric.label.trim().toLocaleLowerCase("ru");
      if (label === "первая очередь гостиниц") candidates.push(`Первая очередь гостиниц кампуса рассчитана на ${value}.`);
      if (label === "вторая очередь гостиниц") candidates.push(`Вторая очередь гостиниц кампуса рассчитана на ${value}.`);
      if (["общая вместимость гостиниц", "вместимость и контингент"].includes(label)) {
        candidates.push(`Общая вместимость гостиниц кампуса составляет ${value}.`);
      }
    }
    for (const item of new Intl.Segmenter("ru", { granularity: "sentence" }).segment(card.referenceDescription)) {
      const sentence = item.segment.trim();
      if (sentence.length >= 45 && sentence.length <= 400) candidates.push(sentence);
    }
  }
  const sentences = [...new Set(candidates)].slice(0, 24).filter(sentence => {
    const result = checkFactText(sentence, cards);
    return result.summary.green > 0 && result.summary.red + result.summary.yellow === 0;
  }).slice(0, 4);
  if (!sentences.length) return null;
  const text = sentences.join("\n\n");
  const result = checkFactText(text, cards);
  if (!result.summary.green || result.summary.red + result.summary.yellow) return null;
  const cited = new Set(result.findings.flatMap(finding => finding.sourceCardId ? [finding.sourceCardId] : []));
  return {
    id: "approved-current",
    label: "Проверенные сведения о кампусе",
    badge: "Все факты подтверждены",
    description: "Пример составлен по текущим утверждённым карточкам. Нажмите «Проверить текст», чтобы сверить его обычной проверкой.",
    text,
    sourceVersions: Object.fromEntries(cards.filter(card => cited.has(card.id)).map(card => [card.id, versionId(card)])),
  };
}
