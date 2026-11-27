import type { KnowledgeCard } from "./knowledge";
import type { SourceVersionReference } from "./source-references";
import {
  isManagedStrategyCard,
  isOfficialDocument,
  isRoadmapIndicator,
} from "./strategy";

export type StrategySourceFact = { field: string; label: string; text: string };
export type StrategySourceProjection = {
  strategySourceFacts: StrategySourceFact[];
  strategyDependencies: SourceVersionReference[];
  strategyEvidenceCurrent: boolean;
};

/** View metadata supplied by the server, never part of stored card content or version hashes. */
export function strategySourceProjection(
  card: KnowledgeCard | null | undefined
): StrategySourceProjection | null {
  if (!card) return null;
  const projected = card as KnowledgeCard & Partial<StrategySourceProjection>;
  return Array.isArray(projected.strategySourceFacts) &&
    Array.isArray(projected.strategyDependencies)
    ? {
        strategySourceFacts: projected.strategySourceFacts,
        strategyDependencies: projected.strategyDependencies,
        strategyEvidenceCurrent: projected.strategyEvidenceCurrent === true,
      }
    : null;
}

export function strategySourceFacts(card: KnowledgeCard): StrategySourceFact[] {
  return strategySourceProjection(card)?.strategySourceFacts ?? [];
}

export function sourceDescription(card: KnowledgeCard): string {
  return isManagedStrategyCard(card)
    ? strategySourceFacts(card)
        .map((fact) => fact.text)
        .join("\n\n")
    : card.referenceDescription;
}

/** Catalog discovery can index metadata, never an unconfirmed measurement. Caller applies card ACL. */
export function strategySearchFragments(card: KnowledgeCard): string[] {
  const metadata = isOfficialDocument(card)
    ? [
        card.officialDocument.sourceOrganization,
        card.officialDocument.edition,
        ...card.officialDocument.directions.map((item) => item.title),
        ...card.officialDocument.clauses.map(
          (item) =>
            `${item.kind === "plan" ? "План" : item.kind === "actual" ? "Сведения в документе" : "Контекст"}: ${item.excerpt}`
        ),
      ]
    : isRoadmapIndicator(card)
      ? [card.roadmapIndicator.definition, card.roadmapIndicator.unit]
      : [];
  return [...metadata, ...strategySourceFacts(card).map((fact) => fact.text)];
}

/** The downloadable representation uses the same safe evidence as the editor. */
export function buildStrategyCardMarkdown(card: KnowledgeCard): string | null {
  if (!isManagedStrategyCard(card)) return null;
  const lines = [
    `# ${card.title}`,
    "",
    `- ID: ${card.id}`,
    `- Ответственные: ${card.owners.join(", ")}`,
    "",
  ];
  if (card.status !== "approved") {
    return [
      ...lines,
      "Черновик. Сведения ещё не утверждены; числовые значения не включены в экспорт.",
      "",
    ].join("\n");
  }
  if (isOfficialDocument(card)) {
    const doc = card.officialDocument;
    lines.push(
      `- Организация: ${doc.sourceOrganization}`,
      `- Редакция: ${doc.edition} от ${doc.date}`,
      `- Официальный документ: ${doc.url}`,
      "",
      "## Проверенные выдержки",
      ""
    );
    for (const clause of doc.clauses)
      lines.push(
        `### ${clause.locator} · ${clause.kind === "plan" ? "План, не достигнутый результат" : clause.kind === "actual" ? "Сведения о факте в документе" : "Контекст"}`,
        "",
        clause.excerpt,
        ""
      );
  } else {
    lines.push(
      "## Подтверждённые сведения",
      "",
      sourceDescription(card) ||
        "Нет действующих подтверждённых сведений для экспорта. Проверьте источники в карточке.",
      ""
    );
  }
  for (const dependency of strategySourceProjection(card)
    ?.strategyDependencies ?? []) {
    lines.push(
      `- [Зафиксированная версия источника](/knowledge?card=${encodeURIComponent(dependency.cardId)}&version=${encodeURIComponent(dependency.versionId)})`
    );
  }
  return lines.join("\n").trim() + "\n";
}
