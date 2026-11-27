import { z } from "zod";

import { universities } from "./data";
import type {
  CardTypeDefinition,
  CustomCard,
  KnowledgeCard,
} from "./knowledge";
import type { SourceVersionReference } from "./source-references";

export const OFFICIAL_DOCUMENT_TYPE_ID = "canon-official-document";
export const ROADMAP_INDICATOR_TYPE_ID = "canon-roadmap-indicator";

export const officialDocumentKindLabels = {
  concept: "Концепция кампуса",
  "regional-strategy": "Стратегия развития региона",
  roadmap: "Дорожная карта кампуса",
  other: "Другой официальный документ",
} as const;

export const strategyClauseKindLabels = {
  plan: "План",
  actual: "Достигнутый результат",
  context: "Контекст",
} as const;

export const INDICATOR_SLOTS = ["plan", "actual"] as const;
export type IndicatorSlot = (typeof INDICATOR_SLOTS)[number];
export const CONFIRM_INDICATOR_ACTIONS = [
  "confirm-plan",
  "confirm-actual",
] as const;
export type ConfirmIndicatorAction = (typeof CONFIRM_INDICATOR_ACTIONS)[number];

export const MAX_STRATEGY_LINKS = 6;
export const MAX_INDICATOR_RELATED_CARDS = 12;
export const MAX_STRATEGY_DEPENDENCIES = 16;

const managedDefinitions: Record<string, CardTypeDefinition> = {
  [OFFICIAL_DOCUMENT_TYPE_ID]: {
    id: OFFICIAL_DOCUMENT_TYPE_ID,
    name: "Официальный документ",
    description: "Концепции, стратегии, дорожные карты и проверенные выдержки",
    fields: [],
    createdAt: "",
    updatedAt: "",
  },
  [ROADMAP_INDICATOR_TYPE_ID]: {
    id: ROADMAP_INDICATOR_TYPE_ID,
    name: "Показатель",
    description: "Плановые и фактические показатели развития кампуса",
    fields: [],
    createdAt: "",
    updatedAt: "",
  },
};

export function isManagedStrategyType(id: string): boolean {
  return id === OFFICIAL_DOCUMENT_TYPE_ID || id === ROADMAP_INDICATOR_TYPE_ID;
}

export function isManagedStrategyCard(card: {
  type: string;
  customTypeId?: string;
}): boolean {
  return (
    card.type === "custom" &&
    card.customTypeId !== undefined &&
    isManagedStrategyType(card.customTypeId)
  );
}

export function managedStrategyType(id: string): CardTypeDefinition | null {
  return isManagedStrategyType(id) ? managedDefinitions[id] : null;
}

export function managedStrategyTypes(): CardTypeDefinition[] {
  return Object.values(managedDefinitions);
}

const requiredText = (max: number) =>
  z.string().trim().min(1, "Заполните поле").max(max);
const stableId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/, "Некорректный идентификатор");
const cardId = requiredText(200);
const date = z.iso.date();

export const evidenceUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url("Укажите ссылку на документ")
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Документ должен иметь безопасную HTTPS-ссылку без логина и пароля");

export const cardVersionIdSchema = z.string().regex(/^cv-[0-9a-f]{64}$/);

const strategyDocumentReferenceSchema = z.strictObject({
  cardId,
  versionId: cardVersionIdSchema,
});

const directionSchema = z.strictObject({
  id: stableId,
  title: requiredText(200),
});
const directionIdsSchema = z
  .array(stableId)
  .max(12)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Направления не должны повторяться"
  );

const clauseSchema = z.strictObject({
  id: stableId,
  locator: requiredText(200),
  excerpt: requiredText(1200),
  kind: z.enum(["plan", "actual", "context"]),
  directionIds: directionIdsSchema,
});

export const officialDocumentDataSchema = z
  .strictObject({
    kind: z.enum(["concept", "regional-strategy", "roadmap", "other"]),
    sourceOrganization: requiredText(200),
    url: evidenceUrlSchema,
    date,
    edition: requiredText(160),
    directions: z.array(directionSchema).max(32),
    clauses: z.array(clauseSchema).max(40),
  })
  .superRefine(({ directions, clauses }, ctx) => {
    const directionIds = new Set(directions.map((direction) => direction.id));
    if (directionIds.size !== directions.length) {
      ctx.addIssue({
        code: "custom",
        path: ["directions"],
        message: "Направления не должны повторяться",
      });
    }
    if (new Set(clauses.map((clause) => clause.id)).size !== clauses.length) {
      ctx.addIssue({
        code: "custom",
        path: ["clauses"],
        message: "Выдержки не должны повторяться",
      });
    }
    clauses.forEach((clause, index) => {
      if (clause.directionIds.some((id) => !directionIds.has(id))) {
        ctx.addIssue({
          code: "custom",
          path: ["clauses", index, "directionIds"],
          message: "Выберите направления этого документа",
        });
      }
    });
  });

export const strategyEvidenceSchema = z.strictObject({
  document: strategyDocumentReferenceSchema,
  clauseId: stableId,
});

const strategyLinkSchema = z
  .strictObject({
    document: strategyDocumentReferenceSchema,
    clauseId: stableId.optional(),
    directionId: stableId.optional(),
    explanation: requiredText(500),
    evidence: strategyEvidenceSchema,
  })
  .refine(
    (link) => Boolean(link.clauseId || link.directionId),
    "Укажите пункт или направление документа"
  );

export const strategyLinksSchema = z
  .array(strategyLinkSchema)
  .max(MAX_STRATEGY_LINKS)
  .refine(
    (links) =>
      new Set(
        links.map((link) =>
          JSON.stringify([
            link.document.cardId,
            link.clauseId,
            link.directionId,
            link.evidence.document.cardId,
            link.evidence.clauseId,
          ])
        )
      ).size === links.length,
    "Связи не должны повторяться"
  );

const indicatorScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("campus") }),
  z.strictObject({
    kind: z.literal("university"),
    universityId: requiredText(80).refine(
      (id) => universities.some((item) => item.id === id),
      "Выберите вуз-резидент"
    ),
  }),
  z.strictObject({ kind: z.literal("other"), label: requiredText(200) }),
]);

const indicatorMeasurementSchema = z.strictObject({
  value: z
    .number()
    .finite()
    .min(-Number.MAX_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER),
  date,
  evidence: strategyEvidenceSchema,
});

export const roadmapIndicatorDataSchema = z
  .strictObject({
    definition: requiredText(1000),
    unit: requiredText(80),
    scope: indicatorScopeSchema,
    relatedCardIds: z
      .array(cardId)
      .max(MAX_INDICATOR_RELATED_CARDS)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Связанные карточки не должны повторяться"
      ),
    plan: indicatorMeasurementSchema.optional(),
    actual: indicatorMeasurementSchema.optional(),
  })
  .superRefine((indicator, ctx) => {
    if (
      indicator.actual &&
      indicator.actual.date > new Date().toISOString().slice(0, 10)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["actual", "date"],
        message:
          "Дата факта не может быть в будущем. Для будущего значения используйте план.",
      });
    }
  });

export type OfficialDocumentData = z.infer<typeof officialDocumentDataSchema>;
export type OfficialDocumentKind = OfficialDocumentData["kind"];
export type StrategyClause = OfficialDocumentData["clauses"][number];
export type StrategyDirection = OfficialDocumentData["directions"][number];
export type StrategyEvidence = z.infer<typeof strategyEvidenceSchema>;
export type StrategyLink = z.infer<typeof strategyLinkSchema>;
export type RoadmapIndicatorData = z.infer<typeof roadmapIndicatorDataSchema>;
export type IndicatorMeasurement = z.infer<typeof indicatorMeasurementSchema>;
export type IndicatorScope = z.infer<typeof indicatorScopeSchema>;
export type IndicatorConfirmation = {
  fingerprint: string;
  actorId: string;
  at: string;
};

export type StrategyDocumentOption = SourceVersionReference & {
  title: string;
  document: OfficialDocumentData;
};
export type StrategyRelatedCardOption = SourceVersionReference & {
  title: string;
  type: "project" | "laboratory";
};
export type StrategyOptions = {
  documents: StrategyDocumentOption[];
  relatedCards: StrategyRelatedCardOption[];
};

export function isOfficialDocument(
  card: KnowledgeCard | null | undefined
): card is CustomCard & { officialDocument: OfficialDocumentData } {
  return (
    card?.type === "custom" &&
    card.customTypeId === OFFICIAL_DOCUMENT_TYPE_ID &&
    card.officialDocument !== undefined
  );
}

export function isRoadmapIndicator(
  card: KnowledgeCard | null | undefined
): card is CustomCard & { roadmapIndicator: RoadmapIndicatorData } {
  return (
    card?.type === "custom" &&
    card.customTypeId === ROADMAP_INDICATOR_TYPE_ID &&
    card.roadmapIndicator !== undefined
  );
}

export function getOfficialDocument(
  card: KnowledgeCard | null | undefined
): OfficialDocumentData | null {
  return isOfficialDocument(card) ? card.officialDocument : null;
}

export function getRoadmapIndicator(
  card: KnowledgeCard | null | undefined
): RoadmapIndicatorData | null {
  return isRoadmapIndicator(card) ? card.roadmapIndicator : null;
}

export function getCurrentStrategyEvidence(
  evidence: StrategyEvidence,
  documents: ReadonlyMap<string, StrategyDocumentOption>,
  kind?: IndicatorSlot
): { source: StrategyDocumentOption; clause: StrategyClause } | null {
  const source = documents.get(evidence.document.cardId);
  if (!source || source.versionId !== evidence.document.versionId) return null;
  const clause = source.document.clauses.find(
    (item) => item.id === evidence.clauseId
  );
  return clause && (!kind || clause.kind === kind) ? { source, clause } : null;
}
