import { universities } from "./data";
import {
  CONTOURS,
  READINESS_STAGES,
  getApprovedVersion,
  getCardTypeLabel,
  getFolderPathLabel,
  getUniversityName,
  isJointProject,
  knowledgeCardTypeLabels,
  placementStatusLabels,
  type CardTypeDefinition,
  type Contour,
  type KnowledgeCard,
  type ReadinessStage,
} from "./knowledge";

export type AnalyticsFilterKey =
  | "type"
  | "industry"
  | "university"
  | "partner"
  | "readiness"
  | "contour"
  | "joint";

export type AnalyticsFilter = {
  key: AnalyticsFilterKey;
  label: string;
  value: string;
};

export type AnalyticsCardType =
  | "project"
  | "laboratory"
  | "campus"
  | "university"
  | "custom";

export type AnalyticsCardRow = {
  id: string;
  title: string;
  cardType: AnalyticsCardType;
  cardTypeLabel: string;
  industry: string;
  universities: string[];
  partner: string;
  status: string;
  contour: string;
  readinessStage: ReadinessStage | null;
  contourValue: Contour | null;
  figures: string[];
  folder: string;
  sourceHref: string;
  isJoint: boolean;
};

export type AnalyticsSummary = {
  total: number;
  projects: number;
  laboratories: number;
  jointProjects: number;
  universities: string[];
  partners: string[];
  industries: string[];
  stages: Array<{ label: string; count: number }>;
  contours: Array<{ label: string; count: number }>;
};

export type AnalyticsReport = {
  query: string;
  filters: AnalyticsFilter[];
  cards: AnalyticsCardRow[];
  summary: AnalyticsSummary;
  notice: string | null;
};

type IndustryDefinition = {
  id: string;
  label: string;
  queryKeywords: string[];
  cardKeywords: string[];
};

const INDUSTRIES: IndustryDefinition[] = [
  {
    id: "medicine",
    label: "Медицина и здравоохранение",
    queryKeywords: [
      "медицин",
      "здравоохран",
      "врач",
      "клинич",
      "реабилитац",
      "биомед",
      "травмпункт",
      "больниц",
    ],
    cardKeywords: [
      "медицин",
      "здравоохран",
      "реабилитац",
      "биомед",
      "клиническ",
      "травмпункт",
    ],
  },
  {
    id: "metallurgy",
    label: "Металлургия, машиностроение и промышленность",
    queryKeywords: [
      "металлург",
      "металл",
      "трубопрокат",
      "промышленн",
      "производств",
      "машиностроен",
      "спецтехник",
      "транспорт",
      "робот",
      "чпу",
      "микроэлектроник",
    ],
    cardKeywords: [
      "металлург",
      "металл",
      "промышленн",
      "трубопрокат",
      "машиностроен",
      "спецтехник",
      "транспорт",
      "робот",
      "чпу",
      "микроэлектроник",
      "интеллектуальн",
    ],
  },
  {
    id: "ecology",
    label: "Экология и природопользование",
    queryKeywords: ["эколог", "водоем", "природопользован", "воды", "водоем"],
    cardKeywords: ["эколог", "природопользован", "водоем", "водоем"],
  },
  {
    id: "creative",
    label: "Креативные индустрии и сервис",
    queryKeywords: ["креатив", "дизайн", "сервисн", "сервис"],
    cardKeywords: ["креатив", "дизайн", "сервис"],
  },
  {
    id: "agro",
    label: "АПК и сельское хозяйство",
    queryKeywords: [
      "агро",
      "апк",
      "сельск",
      "урожай",
      "животн",
      "ветеринар",
      "ферм",
    ],
    cardKeywords: ["агро", "апк", "сельск", "урожай", "животн", "ветеринар"],
  },
  {
    id: "education",
    label: "Образование и педагогика",
    queryKeywords: ["образован", "педагог", "наставник", "школ"],
    cardKeywords: ["образован", "педагог", "наставник"],
  },
  {
    id: "digital",
    label: "Цифровые технологии и ИИ",
    queryKeywords: [
      "цифров",
      "искусственн",
      "компьютерн",
      "информацион",
      "нейросет",
    ],
    cardKeywords: [
      "цифров",
      "искусственн",
      "компьютерн",
      "информацион",
      "нейросет",
    ],
  },
];

const READINESS_KEYWORDS: Array<{
  stage: ReadinessStage;
  keywords: string[];
}> = [
  { stage: "Идея", keywords: ["идея", "идее", "идею", "идеи"] },
  { stage: "НИОКР", keywords: ["ниокр"] },
  { stage: "Прототип", keywords: ["прототип"] },
  { stage: "Испытания", keywords: ["испытани"] },
  { stage: "Внедрено", keywords: ["внедрен", "внедрён"] },
];

const CONTOUR_KEYWORDS: Array<{ contour: Contour; keywords: string[] }> = [
  { contour: "ПИШ", keywords: ["пиш", "передов"] },
  { contour: "УМНОЦ", keywords: ["умноц"] },
  {
    contour: "собственный проект вуза",
    keywords: ["собственн"],
  },
];

const normalize = (value: string) =>
  value.toLowerCase().replace(/ё/g, "е").trim();

const includesAny = (haystack: string, keywords: string[]) =>
  keywords.some((keyword) => haystack.includes(normalize(keyword)));

function matchUniversityName(value: string, universityShortName: string) {
  const normalizedValue = normalize(value);
  const normalizedShortName = normalize(universityShortName);

  if (!normalizedValue) return false;
  if (normalizedValue.length < 3) {
    return normalizedValue === normalizedShortName;
  }

  return (
    normalizedValue === normalizedShortName ||
    normalizedValue.includes(normalizedShortName) ||
    normalizedShortName.includes(normalizedValue)
  );
}

function cardUniversityIds(card: KnowledgeCard): string[] {
  if (card.type === "university") return [card.universityId];

  if (card.type === "project") {
    const ids = new Set<string>([card.initiatorUniversityId]);

    card.participantUniversityIds.forEach((id) => ids.add(id));

    card.coExecutors.forEach((executor) => {
      const university = universities.find((item) =>
        matchUniversityName(executor, item.shortName)
      );

      if (university) ids.add(university.id);
    });

    return [...ids];
  }

  if (card.type === "laboratory") {
    const university = universities.find((item) =>
      matchUniversityName(card.affiliation, item.shortName)
    );

    return university ? [university.id] : [];
  }

  return [];
}

function cardIndustryText(card: KnowledgeCard): string {
  if (card.type === "project") return card.sphere;
  if (card.type === "laboratory") return card.workDirections.join(" ");
  return "";
}

function cardPartner(card: KnowledgeCard): string {
  if (card.type === "project") return card.industrialPartner;
  if (card.type === "laboratory") return card.partner;
  return "";
}

function cardFigures(card: KnowledgeCard): string[] {
  if (card.type === "project") return card.confirmedFigures;
  if (card.type === "laboratory") return card.confirmedIndicators;
  if (card.type === "university")
    return (card.structuredMetrics ?? []).map(
      (metric) =>
        `${metric.label}: ${metric.value} ${metric.unit} (${metric.year}, ${metric.kind === "actual" ? "факт" : "план"})`
    );
  if (card.type === "campus")
    return card.campusMetrics.map(
      (metric) => `${metric.label}: ${metric.value}`
    );
  return [];
}

function cardStatus(card: KnowledgeCard): string {
  if (card.type === "project") return card.readinessStage;
  if (card.type === "laboratory")
    return placementStatusLabels[card.placementStatus];
  return getCardTypeLabel(card);
}

function cardContour(card: KnowledgeCard): {
  label: string;
  value: Contour | null;
} {
  if (card.type === "project") {
    return { label: card.contour, value: card.contour };
  }

  if (card.type === "laboratory") {
    return {
      label:
        card.placementStatus === "planned"
          ? "УНК кампуса (планируется)"
          : "Площадка вуза",
      value: null,
    };
  }

  return { label: "—", value: null };
}

function toRow(
  card: KnowledgeCard,
  customTypes: CardTypeDefinition[]
): AnalyticsCardRow {
  const contour = cardContour(card);
  const universityIds = cardUniversityIds(card);

  return {
    id: card.id,
    title: card.title,
    cardType: card.type,
    cardTypeLabel: isJointProject(card)
      ? "Совместный проект"
      : getCardTypeLabel(card, customTypes),
    industry: cardIndustryText(card) || "—",
    universities: universityIds.map(getUniversityName),
    partner: cardPartner(card) || "—",
    status: cardStatus(card),
    contour: contour.label,
    readinessStage: card.type === "project" ? card.readinessStage : null,
    contourValue: contour.value,
    figures: cardFigures(card),
    folder: getFolderPathLabel(card.folderId),
    sourceHref: `/knowledge?card=${encodeURIComponent(card.id)}&version=approved`,
    isJoint: isJointProject(card),
  };
}

type ParsedQuery = {
  filters: AnalyticsFilter[];
  cardTypes: Set<AnalyticsCardType>;
  industries: IndustryDefinition[];
  universityIds: string[];
  requirePartner: boolean;
  partnerName: string | null;
  customTypeIds: string[];
  stages: ReadinessStage[];
  contours: Contour[];
  jointOnly: boolean;
  unknownIndustry: string | null;
};

function detectCardTypes(
  query: string,
  hasCustomType: boolean
): Set<AnalyticsCardType> {
  const types = new Set<AnalyticsCardType>();
  if (hasCustomType) {
    types.add("custom");
    return types;
  }
  if (/проект|разработ|продукт/.test(query)) types.add("project");
  if (/лаборатор|инфраструктур|объект/.test(query)) types.add("laboratory");
  if (/паспорт[а-я]*\s+кампус|общие параметры/.test(query)) types.add("campus");
  if (
    /паспорт[а-я]*\s+(?:вуз|университет)|показател[а-я]*\s+(?:вуз|университет)/.test(
      query
    )
  )
    types.add("university");
  if (types.size === 0) {
    types.add("project");
    types.add("laboratory");
  }
  return types;
}

function parseQuery(
  rawQuery: string,
  customTypes: CardTypeDefinition[]
): ParsedQuery {
  const query = normalize(rawQuery);
  const filters: AnalyticsFilter[] = [];
  const explicitCustomName = query.match(
    /(?:^|\s)тип[а-я]*\s+[«"]([^"»]+)["»]/u
  )?.[1];
  const activeCustomTypes = explicitCustomName
    ? customTypes.filter(
        (type) => normalize(type.name) === normalize(explicitCustomName)
      )
    : [];
  const cardTypes = detectCardTypes(query, Boolean(explicitCustomName));
  const filterQuery = query.replace(/[«"][^"»]+["»]/gu, "");
  const industries = INDUSTRIES.filter((industry) =>
    includesAny(filterQuery, industry.queryKeywords)
  );
  const universityIds = universities
    .filter((university) => {
      const names = [university.id, university.shortName, university.fullName];

      return names.some((name) => {
        const normalizedName = normalize(name);
        return (
          filterQuery.includes(normalizedName) ||
          (name === university.fullName &&
            normalizedName
              .split(/\s+/)
              .every((part) => filterQuery.includes(part)))
        );
      });
    })
    .map((university) => university.id);
  const requirePartner = /партнер|индустриальн/.test(filterQuery);
  const partnerName =
    query.match(
      /партнер[а-я]*\s+(?:(?:ооо|пао|ао|гк)\s+)?[«"]([^"»]+)["»]/u
    )?.[1] ?? null;
  const stages = READINESS_KEYWORDS.filter((item) =>
    includesAny(filterQuery, item.keywords)
  ).map((item) => item.stage);
  const contours = CONTOUR_KEYWORDS.filter((item) =>
    includesAny(filterQuery, item.keywords)
  ).map((item) => item.contour);
  const hasCampusContour =
    /контур[а-яёa-z]*\s+(?:в\s+)?кампус/.test(query) ||
    /кампус[а-яёa-z]*\s+контур/.test(query);

  if (hasCampusContour) contours.push("кампус");

  const jointOnly =
    /между собой|межвузов|совместн|кооперац/.test(query) &&
    cardTypes.has("project");

  if (jointOnly) {
    cardTypes.clear();
    cardTypes.add("project");
  }

  const sphereMention = query.match(
    /(?:в\s+сфере|в\s+области|по\s+отрасли|в\s+отрасли|по\s+теме|в\s+тематике)\s+([^.,;!?]{2,80})/
  );
  const unknownIndustry =
    industries.length === 0 && sphereMention ? sphereMention[1].trim() : null;

  const activeTypeLabels = Array.from(cardTypes, (type) =>
    type === "custom" && explicitCustomName
      ? explicitCustomName
      : knowledgeCardTypeLabels[type]
  );
  filters.push({
    key: "type",
    label: "Тип карточки",
    value: activeTypeLabels.join(", "),
  });

  industries.forEach((industry) => {
    filters.push({
      key: "industry",
      label: "Отрасль",
      value: industry.label,
    });
  });

  if (unknownIndustry) {
    filters.push({
      key: "industry",
      label: "Отрасль",
      value: `${unknownIndustry} — точного совпадения нет`,
    });
  }

  universityIds.forEach((id) => {
    filters.push({
      key: "university",
      label: "Вуз",
      value: getUniversityName(id),
    });
  });

  if (requirePartner) {
    filters.push({
      key: "partner",
      label: "Партнёры",
      value: partnerName
        ? `Партнёр «${partnerName}»`
        : "Только карточки с указанным партнёром",
    });
  }

  stages.forEach((stage) => {
    filters.push({ key: "readiness", label: "Статус", value: stage });
  });

  contours.forEach((contour) => {
    filters.push({ key: "contour", label: "Контур", value: contour });
  });

  if (jointOnly) {
    filters.push({
      key: "joint",
      label: "Связи",
      value: "Только совместные проекты вузов",
    });
  }

  return {
    filters,
    cardTypes,
    industries,
    universityIds,
    requirePartner,
    partnerName,
    customTypeIds: activeCustomTypes.map((type) => type.id),
    stages,
    contours,
    jointOnly,
    unknownIndustry,
  };
}

function matchesQuery(card: KnowledgeCard, parsed: ParsedQuery): boolean {
  if (
    card.type === "custom" &&
    !parsed.customTypeIds.includes(card.customTypeId)
  )
    return false;
  if (!parsed.cardTypes.has(card.type)) return false;

  if (parsed.unknownIndustry) return false;

  if (parsed.industries.length > 0) {
    const industryText = normalize(cardIndustryText(card));
    const matchesIndustry = parsed.industries.some((industry) =>
      includesAny(industryText, industry.cardKeywords)
    );

    if (!matchesIndustry) return false;
  }

  if (parsed.universityIds.length > 0) {
    const ids = cardUniversityIds(card);
    const hasUniversities = parsed.jointOnly
      ? parsed.universityIds.every((id) => ids.includes(id))
      : parsed.universityIds.some((id) => ids.includes(id));

    if (!hasUniversities) return false;
  }

  const partner = normalize(cardPartner(card));
  if (
    parsed.requirePartner &&
    (!partner || /^(?:[-—]+|нет|не указан[а-я]*|не применимо)$/.test(partner))
  )
    return false;
  if (parsed.partnerName && !partner.includes(normalize(parsed.partnerName)))
    return false;

  if (parsed.stages.length > 0) {
    if (card.type !== "project") return false;
    if (!parsed.stages.includes(card.readinessStage)) return false;
  }

  if (parsed.contours.length > 0) {
    if (card.type !== "project") return false;
    if (!parsed.contours.includes(card.contour)) return false;
  }

  if (parsed.jointOnly && !isJointProject(card)) return false;

  return true;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniquePartners(values: string[]): string[] {
  const seen = new Map<string, string>();

  values
    .filter((value) => Boolean(value) && value !== "—")
    .forEach((value) => {
      const cleaned =
        value
          .replace(/\s*\([^)]*\)/g, "")
          .split(";")[0]
          ?.trim() ?? value;
      const key = normalize(cleaned).replace(/[«»"']/g, "");
      if (key && !seen.has(key)) {
        seen.set(key, cleaned);
      }
    });

  return [...seen.values()];
}

function countBy<T extends string>(
  values: T[],
  order: readonly T[]
): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();

  values.forEach((value) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  });

  return order
    .filter((value) => counts.has(value))
    .map((value) => ({ label: value, count: counts.get(value) ?? 0 }));
}

export function buildAnalyticsReport(
  rawQuery: string,
  cards: KnowledgeCard[],
  customTypes: CardTypeDefinition[] = []
): AnalyticsReport {
  const query = rawQuery.trim();
  const parsed = parseQuery(query, customTypes);
  const matchedCards = cards
    .map(getApprovedVersion)
    .filter(
      (card): card is KnowledgeCard =>
        card !== null && matchesQuery(card, parsed)
    )
    .sort((a, b) => {
      const typeOrder: Record<KnowledgeCard["type"], number> = {
        project: 0,
        laboratory: 1,
        campus: 2,
        custom: 3,
        university: 2,
      };
      const typeDelta = typeOrder[a.type] - typeOrder[b.type];

      if (typeDelta !== 0) return typeDelta;

      return a.title.localeCompare(b.title, "ru");
    });
  const rows = matchedCards.map((card) => toRow(card, customTypes));

  const summary: AnalyticsSummary = {
    total: rows.length,
    projects: rows.filter((row) => row.cardType === "project").length,
    laboratories: rows.filter((row) => row.cardType === "laboratory").length,
    jointProjects: rows.filter((row) => row.isJoint).length,
    universities: unique(rows.flatMap((row) => row.universities)),
    partners: uniquePartners(rows.map((row) => row.partner)),
    industries: unique(
      rows.map((row) => row.industry).filter((industry) => industry !== "—")
    ),
    stages: countBy(
      rows.flatMap((row) => (row.readinessStage ? [row.readinessStage] : [])),
      READINESS_STAGES
    ),
    contours: countBy(
      rows.flatMap((row) => (row.contourValue ? [row.contourValue] : [])),
      CONTOURS
    ),
  };

  let notice: string | null = null;

  if (rows.length === 0) {
    notice = parsed.unknownIndustry
      ? `В базе нет карточек с отраслью «${parsed.unknownIndustry}». Система не добавляет сведения и не делает предположений.`
      : `По запросу «${query}» в базе нет подходящих карточек. Система не добавляет сведения и не делает предположений.`;
  }

  return {
    query,
    filters: parsed.filters,
    cards: rows,
    summary,
    notice,
  };
}
