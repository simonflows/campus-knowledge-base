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
  type PlacementStatus,
  type ReadinessStage,
} from "./knowledge";
import {
  indexKnowledgeFragment,
  knowledgeQueryTerms,
  matchKnowledgeTerm,
  normalizeKnowledgeText,
  tokenizeKnowledgeText,
} from "./knowledge-query";
import { knowledgeCardMatch } from "./knowledge-search";

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
  interpretation?: {
    status: "ready" | "needs-clarification";
    message?: string;
    unparsed?: string[];
  };
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
      "робототехн",
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

const CONTOUR_KEYWORDS: Array<{ contour: Contour; pattern: RegExp }> = [
  {
    contour: "ПИШ",
    pattern:
      /пиш|передов[а-я]+\s+(?:инженерн[а-я]+\s+школ[а-я]+|технологи[а-я]+)/u,
  },
  { contour: "УМНОЦ", pattern: /умноц/u },
  {
    contour: "кампус",
    pattern:
      /контур[а-я]*\s+(?:в\s+)?кампус[а-я]*|кампус[а-я]*\s+контур[а-я]*/u,
  },
  {
    contour: "собственный проект вуза",
    pattern: /собственн[а-я]*\s+проект[а-я]*\s+вуз[а-я]*/u,
  },
];

const normalize = normalizeKnowledgeText;

const includesAny = (haystack: string, keywords: string[]) =>
  keywords.some((keyword) => haystack.includes(normalize(keyword)));

function matchUniversityName(value: string, universityShortName: string) {
  const normalizedValue = normalize(value);
  const normalizedShortName = normalize(universityShortName);

  if (!normalizedValue) return false;
  if (normalizedValue.length < 3) {
    return normalizedValue === normalizedShortName;
  }

  const abbreviation = normalizedShortName.split(" ")[0];
  return (
    normalizedValue === normalizedShortName ||
    normalizedValue.includes(normalizedShortName) ||
    normalizedShortName.includes(normalizedValue) ||
    tokenizeKnowledgeText(normalizedValue).includes(abbreviation)
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
    return universities
      .filter(
        (item) =>
          matchUniversityName(card.affiliation, item.shortName) ||
          normalize(card.affiliation).includes(
            normalize(item.fullName.replace(/\s*\([^)]*\)\s*$/u, ""))
          )
      )
      .map((university) => university.id);
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
  usesDefaultCardTypes: boolean;
  industries: IndustryDefinition[];
  universityIds: string[];
  universityAlternatives: boolean;
  universityCooperation: boolean;
  excludedUniversities: string[];
  partner: "present" | "absent" | null;
  partnerName: string | null;
  customTypeIds: string[];
  stages: ReadinessStage[];
  excludedStages: ReadinessStage[];
  placements: PlacementStatus[];
  excludedPlacements: PlacementStatus[];
  contours: Contour[];
  excludedContours: Contour[];
  jointOnly: boolean;
  equipmentOnly: boolean;
  terms: string[][];
  unparsed: string[];
};

const typePhrases: Array<[AnalyticsCardType, RegExp]> = [
  [
    "campus",
    /паспорт[а-я]*\s+кампус[а-я]*|общие параметры(?:\s+кампус[а-я]*)?/u,
  ],
  [
    "university",
    /(?:паспорт[а-я]*|показател[а-я]*)\s+(?:вуз[а-я]*|университет[а-я]*)/u,
  ],
  ["project", /проект[а-я]*|разработк[а-я]*|продукт[а-я]*/u],
  ["laboratory", /лаборатор[а-я]*|объект[а-я]*\s+инфраструктур[а-я]*/u],
];

const placementPhrases: Array<[PlacementStatus, RegExp]> = [
  [
    "active",
    /действующ[а-я]*|действует|работающ[а-я]*|работают|работает|открыт(?:а|ы|о|ый|ая|ые|ых)?|на\s+площадк[а-я]*\s+вуз[а-я]*/u,
  ],
  [
    "planned",
    /запланирован[а-я]*|планируем[а-я]*|планируется(?:\s+к\s+открытию)?|в\s+(?:новом\s+)?унк(?:\s+кампус[а-я]*)?/u,
  ],
];

const requestLead =
  /^(?:(?:в\s+каки[хм]\s+вуз[а-я]*(?:\s+есть)?|что\s+известно\s+о|какие\s+есть|есть\s+ли|составь|собери|найди|покажи|перечисли|расскажи|выведи|представь|сделай|напиши|опиши|запиши|дай|подготовь|пожалуйста|какие|какой|какая|сколько)(?![\p{L}\p{N}])[ ,?!]*)+/u;
const relationWords =
  /(?:взаимодействи[а-я]*|сотрудничеств[а-я]*|коопераци[а-я]*)/u;
const filler = new Set(
  "в во на по с со о об обо из у про за от среди для к ко и а также все весь вся всех нужен нужна нужно только лишь пожалуйста отчёт отчет справка список перечень со статусом стадии этапе".split(
    " "
  )
);
const clarificationWord =
  /^(?:не|без|кроме|исключая|исключением|либо|или|более|меньше|менее|старше|ранее|позднее|после|до|между|свыше|необходим[а-я]*)$/u;
const industryScope =
  /(?:в\s+сфер[а-я]*|в\s+област[а-я]*|по\s+отрасл[а-я]*|в\s+отрасл[а-я]*|по\s+тем[а-я]*|в\s+тематик[а-я]*)/u;

function escapePattern(text: string) {
  return text.replace(/[.*+?^\${}()|[\]\\]/gu, "\\$&");
}

function bounded(pattern: RegExp) {
  return new RegExp(
    "(?<![\\p{L}\\p{N}-])(?:" + pattern.source + ")(?![\\p{L}\\p{N}-])",
    "gu"
  );
}

function polarity(pattern: RegExp) {
  return new RegExp(
    "(?:(не|кроме|исключая)\\s+)?(?:" + pattern.source + ")",
    "u"
  );
}

function consumePolarity<T>(
  query: string,
  pattern: RegExp,
  value: T,
  included: T[],
  excluded: T[]
) {
  return query.replace(
    bounded(polarity(pattern)),
    (_, negative: string | undefined) => {
      const list = negative ? excluded : included;
      if (!list.includes(value)) list.push(value);
      return " ";
    }
  );
}

const universityAliases = universities
  .flatMap((university) =>
    [
      university.fullName,
      university.fullName.replace(/\s*\([^)]*\)\s*$/u, ""),
      university.shortName,
      university.shortName.split(" ")[0],
      university.id,
    ].map((name) => ({ name: normalize(name), id: university.id }))
  )
  .sort((first, second) => second.name.length - first.name.length);
const universityByAlias = new Map(
  universityAliases.map(({ name, id }) => [name, id])
);
const aliasesPattern = [...universityByAlias.keys()]
  .map(escapePattern)
  .join("|");
const universityList = new RegExp(
  "(?:(кроме|без\\s+участия|исключая|за\\s+исключением)\\s+)?(" +
    "(?:" +
    aliasesPattern +
    ")(?:(?:\\s*,\\s*|\\s+(?:и|или|с|со)\\s+)(?:" +
    aliasesPattern +
    "))*)",
  "u"
);
const universityAliasPattern = bounded(new RegExp(aliasesPattern, "u"));
const universityRole = new RegExp(
  "(?:от(?:\\s+имени)?|для)\\s+(?:" + aliasesPattern + ")",
  "u"
);
const typeExclusion =
  /(?:кроме|исключая|за\s+исключением)\s+(?:[\p{L}-]+\s+){0,3}(?:проект|лаборатор|паспорт|объект|карточк)[а-я]*/u;
const quotes = /[«"“]([^»"”]+)[»"”]/gu;
const partnerLabel = /(?:индустриальн[а-я]*\s+)?партнер[а-я]*/u;
const organizationType = /(?:ооо|пао|ао|гк)/u;
const equipmentQualifier = bounded(
  /(?:с\s+)?оборудовани[а-я]*|оснащенн[а-я]*/u
);

function parseQuery(
  rawQuery: string,
  customTypes: CardTypeDefinition[]
): ParsedQuery {
  let rest = normalize(rawQuery).replace(requestLead, " ");
  const filters: AnalyticsFilter[] = [];
  const unparsed: string[] = [];
  const explicitCustomType = bounded(
    /(?:карточк[а-я]*\s+)?тип[а-я]*\s+[«"“]([^»"”]+)[»"”]/u
  );
  const customName = [...rest.matchAll(explicitCustomType)][0]?.[1];
  const customTypeIds = customTypes
    .filter((type) => normalize(type.name) === customName)
    .map((type) => type.id);
  rest = rest.replace(explicitCustomType, (_match, name: string) => {
    if (name !== customName || customTypeIds.length === 0) unparsed.push(name);
    return " ";
  });

  const namedPartner = new RegExp(
    "(?:с\\s+)?" +
      partnerLabel.source +
      "\\s+(?:(" +
      organizationType.source +
      ')\\s+)?[«"“]([^»"”]+)[»"”]',
    "u"
  );
  const unquotedPartner =
    /(?:с\s+)?(?:индустриальн[а-я]*\s+)?партнером\s+((?!(?:в|по|на|кроме|без|из|у)\s)[\p{L}\p{N}][^«"“,.;!?]*?)(?=$|[.,;!?]|\s+(?:в|по|на|кроме|без|и|или|из|у)\s)/u;
  const partnerNames = new Set<string>();
  rest = rest.replace(
    bounded(namedPartner),
    (_match, legal: string | undefined, name: string) => {
      partnerNames.add(legal ? legal + " " + name : name);
      return " ";
    }
  );
  rest = rest.replace(bounded(unquotedPartner), (_match, name: string) => {
    partnerNames.add(name.trim());
    return " ";
  });
  const partnerName = partnerNames.values().next().value ?? null;
  if (partnerNames.size > 1) unparsed.push(...partnerNames);

  // Quoted entity names remain required phrases and do not activate keyword filters.
  const terms = [...rest.matchAll(quotes)]
    .map((match) => tokenizeKnowledgeText(match[1]))
    .filter((term) => term.length > 0);
  rest = rest.replace(quotes, " ");
  if (/[«»"“”]/u.test(rest)) unparsed.push("незакрытая цитата");
  const equipmentOnly = [...rest.matchAll(equipmentQualifier)].length > 0;
  rest = rest.replace(equipmentQualifier, " ");

  const universityIds: string[] = [];
  let universityAlternatives = false;
  let universityCooperation = false;
  const excludedUniversities: string[] = [];
  if (bounded(universityRole).test(rest)) unparsed.push("роль вуза");
  rest = rest.replace(
    bounded(universityList),
    (_, negative: string | undefined, names: string) => {
      const ids = negative ? excludedUniversities : universityIds;
      const aliases = [...names.matchAll(universityAliasPattern)];
      const connectors = aliases.slice(1).map((next, index) => {
        const previous = aliases[index];
        return names
          .slice(previous.index + previous[0].length, next.index)
          .trim();
      });
      if (!negative) {
        if (connectors.some((word) => word === "с" || word === "со"))
          universityCooperation = true;
        if (connectors.includes("или")) {
          if (connectors.some((word) => word !== "или"))
            unparsed.push("связь между вузами");
          universityAlternatives = true;
        }
      }
      for (const [alias] of aliases) {
        const id = universityByAlias.get(alias);
        if (id && !ids.includes(id)) ids.push(id);
      }
      return " ";
    }
  );

  const absentPartner = bounded(
    new RegExp("без\\s+" + partnerLabel.source, "u")
  );
  const withoutPartner = [...rest.matchAll(absentPartner)].length > 0;
  rest = rest.replace(absentPartner, " ");
  const presence = bounded(new RegExp("(?:с\\s+)?" + partnerLabel.source, "u"));
  const withPartner =
    Boolean(partnerName) || [...rest.matchAll(presence)].length > 0;
  rest = rest.replace(presence, " ");
  if (withPartner && withoutPartner) unparsed.push("наличие партнёра");
  const partner = withoutPartner ? "absent" : withPartner ? "present" : null;

  const contours: Contour[] = [];
  const excludedContours: Contour[] = [];
  for (const { contour, pattern } of CONTOUR_KEYWORDS) {
    rest = consumePolarity(rest, pattern, contour, contours, excludedContours);
  }
  if (contours.length || excludedContours.length) {
    rest = rest.replace(bounded(/в\s+контур[а-я]*|контур[а-я]*/u), " ");
  }

  const cardTypes = new Set<AnalyticsCardType>();
  if (bounded(typeExclusion).test(rest))
    unparsed.push("исключение типа карточки");
  if (customName) cardTypes.add("custom");
  for (const [type, pattern] of typePhrases) {
    const matches = [...rest.matchAll(bounded(pattern))];
    if (!matches.length) continue;
    cardTypes.add(type);
    rest = rest.replace(bounded(pattern), " ");
  }
  const stages: ReadinessStage[] = [];
  const excludedStages: ReadinessStage[] = [];
  for (const { stage, keywords } of READINESS_KEYWORDS) {
    const pattern = new RegExp(
      "(?:" + keywords.map(escapePattern).join("|") + ")[а-я]*",
      "u"
    );
    rest = consumePolarity(rest, pattern, stage, stages, excludedStages);
  }
  const placements: PlacementStatus[] = [];
  const excludedPlacements: PlacementStatus[] = [];
  for (const [status, pattern] of placementPhrases) {
    rest = consumePolarity(
      rest,
      pattern,
      status,
      placements,
      excludedPlacements
    );
  }
  if (placements.length > 1) unparsed.push("размещение лаборатории");
  if (stages.length > 1) unparsed.push("стадия проекта");
  if (contours.length > 1) unparsed.push("контур проекта");
  if (
    (placements.length ||
      excludedPlacements.length ||
      cardTypes.has("laboratory")) &&
    bounded(/в\s+кампус[а-я]*/u).test(rest)
  ) {
    unparsed.push("в кампусе");
  }
  const jointPattern = bounded(
    /между\s+собой|межвузовск[а-я]*|совместн[а-я]*/u
  );
  const jointOnly = [...rest.matchAll(jointPattern)].length > 0;
  rest = rest.replace(jointPattern, " ");
  if (jointOnly || partner) {
    rest = rest
      .replace(bounded(relationWords), " ")
      .replace(bounded(/вуз[а-я]*/u), " ");
  }

  const allCards = bounded(/карточк[а-я]*/u);
  const explicitAllCards = [...rest.matchAll(allCards)].length > 0;
  rest = rest.replace(allCards, " ");
  const usesDefaultCardTypes =
    cardTypes.size === 0 &&
    !jointOnly &&
    !explicitAllCards &&
    !equipmentOnly &&
    !contours.length &&
    !excludedContours.length &&
    !placements.length &&
    !excludedPlacements.length &&
    !stages.length &&
    !excludedStages.length;
  if (cardTypes.size === 0) {
    if (equipmentOnly || placements.length || excludedPlacements.length)
      cardTypes.add("laboratory");
    if (
      jointOnly ||
      contours.length ||
      excludedContours.length ||
      stages.length ||
      excludedStages.length
    ) {
      cardTypes.add("project");
    }
    if (cardTypes.size === 0) {
      cardTypes.add("project").add("laboratory");
      if (explicitAllCards)
        cardTypes.add("campus").add("university").add("custom");
    }
  }

  const industries: IndustryDefinition[] = [];
  for (const industry of INDUSTRIES) {
    const topic = new RegExp(
      "(?:" + industry.queryKeywords.map(escapePattern).join("|") + ")[а-я]*",
      "u"
    );
    const topicPhrase = new RegExp(
      topic.source + "(?:\\s+технологи[а-я]*)?",
      "u"
    );
    const scoped = bounded(
      new RegExp(industryScope.source + "\\s+" + topicPhrase.source, "u")
    );
    if ([...rest.matchAll(scoped)].length > 0) {
      industries.push(industry);
      rest = rest.replace(scoped, " ");
      continue;
    }
    // A bare topic can be an industry only when it is the whole remaining query.
    // In "робот KUKA", both words remain subject constraints.
    const words = tokenizeKnowledgeText(rest).filter(
      (word) => !filler.has(word)
    );
    const isBareTopic =
      words.length > 0 &&
      new RegExp("^(?:" + topicPhrase.source + ")$", "u").test(words.join(" "));
    if (isBareTopic && !equipmentOnly && terms.length === 0) {
      industries.push(industry);
      rest = rest.replace(bounded(topicPhrase), " ");
    }
  }

  const unknownScope = [...rest.matchAll(bounded(industryScope))][0];
  const unknownIndustry = unknownScope
    ? rest.slice(unknownScope.index + unknownScope[0].length).trim()
    : null;
  if (unknownScope) unparsed.push(unknownIndustry || unknownScope[0] || "");
  for (const term of knowledgeQueryTerms(rest)) {
    const word = term[0];
    if (filler.has(word)) continue;
    if (clarificationWord.test(word) || /^\d/u.test(word)) unparsed.push(word);
    else terms.push(term);
  }

  const addFilter = (key: AnalyticsFilterKey, label: string, value: string) =>
    filters.push({ key, label, value });
  addFilter(
    "type",
    "Тип карточки",
    [...cardTypes]
      .map((type) =>
        type === "custom" && customName
          ? customName
          : knowledgeCardTypeLabels[type]
      )
      .join(", ")
  );
  industries.forEach((industry) =>
    addFilter("industry", "Отрасль", industry.label)
  );
  if (unknownIndustry)
    addFilter(
      "industry",
      "Отрасль",
      unknownIndustry + " — точного совпадения нет"
    );
  universityIds.forEach((id) =>
    addFilter(
      "university",
      universityAlternatives ? "Один из вузов" : "Вуз",
      getUniversityName(id)
    )
  );
  excludedUniversities.forEach((id) =>
    addFilter("university", "Вуз", "Кроме " + getUniversityName(id))
  );
  if (partner === "present") {
    addFilter(
      "partner",
      "Партнёры",
      partnerName
        ? "Партнёр «" + partnerName + "»"
        : "Только карточки с указанным партнёром"
    );
  } else if (partner === "absent") {
    addFilter("partner", "Партнёры", "Без указанного партнёра");
  }
  stages.forEach((stage) => addFilter("readiness", "Статус", stage));
  excludedStages.forEach((stage) =>
    addFilter("readiness", "Статус", "Кроме: " + stage)
  );
  placements.forEach((status) =>
    addFilter("readiness", "Размещение", placementStatusLabels[status])
  );
  excludedPlacements.forEach((status) =>
    addFilter(
      "readiness",
      "Размещение",
      "Кроме: " + placementStatusLabels[status]
    )
  );
  contours.forEach((contour) => addFilter("contour", "Контур", contour));
  excludedContours.forEach((contour) =>
    addFilter("contour", "Контур", "Кроме: " + contour)
  );
  if (jointOnly) addFilter("joint", "Связи", "Только совместные проекты вузов");
  if (
    usesDefaultCardTypes &&
    filters.length === 1 &&
    terms.length === 0 &&
    !tokenizeKnowledgeText(rawQuery).some((word) => word === "все")
  ) {
    unparsed.push("предмет запроса");
  }

  const remainingTerms = [...terms];
  // Quoted subjects were extracted before parsing the filters. Restore their
  // position before the equipment matcher pairs a model with the preceding kind.
  const orderedTerms = knowledgeQueryTerms(rawQuery).flatMap((original) => {
    const index = remainingTerms.findIndex(
      (term) => term.join("\0") === original.join("\0")
    );
    return index < 0 ? [] : remainingTerms.splice(index, 1);
  });
  return {
    filters,
    cardTypes,
    usesDefaultCardTypes,
    industries,
    universityIds,
    universityAlternatives,
    universityCooperation,
    excludedUniversities,
    partner,
    partnerName,
    customTypeIds,
    stages,
    excludedStages,
    placements,
    excludedPlacements,
    contours,
    excludedContours,
    jointOnly,
    equipmentOnly,
    terms: [...orderedTerms, ...remainingTerms],
    unparsed: [...new Set(unparsed)],
  };
}

export function getAnalyticsCriteria(
  query: string,
  customTypes: CardTypeDefinition[]
) {
  const { filters, usesDefaultCardTypes, equipmentOnly, terms, unparsed } =
    parseQuery(query, customTypes);
  return { filters, usesDefaultCardTypes, equipmentOnly, terms, unparsed };
}

function hasPartner(value: string) {
  const name = normalize(value);
  const absence =
    /^(?:[-—–]+|нет|не применимо|(?:(?:индустриальн[а-я]*\s+)?партнер[а-я]*(?:\s+[а-я-]+){0,6}\s+)?не\s+(?:указан|установлен|определен|подтвержден|назначен|известен)[а-я]*)(?:[.!])?$/u;
  return Boolean(name) && !absence.test(name);
}

function matchesQuery(card: KnowledgeCard, parsed: ParsedQuery): boolean {
  if (parsed.unparsed.length || !parsed.cardTypes.has(card.type)) return false;
  if (
    card.type === "custom" &&
    parsed.customTypeIds.length &&
    !parsed.customTypeIds.includes(card.customTypeId)
  ) {
    return false;
  }
  if (
    !parsed.industries.every((industry) =>
      includesAny(normalize(cardIndustryText(card)), industry.cardKeywords)
    )
  ) {
    return false;
  }

  const ids = cardUniversityIds(card);
  if (parsed.excludedUniversities.some((id) => ids.includes(id))) return false;
  if (parsed.universityIds.length) {
    const hasUniversities =
      (parsed.jointOnly || parsed.universityCooperation) &&
      !parsed.universityAlternatives
        ? parsed.universityIds.every((id) => ids.includes(id))
        : parsed.universityIds.some((id) => ids.includes(id));
    if (!hasUniversities) return false;
  }

  const partner = cardPartner(card);
  if (parsed.partner === "present" && !hasPartner(partner)) return false;
  if (
    parsed.partner === "absent" &&
    !["project", "laboratory"].includes(card.type)
  )
    return false;
  if (parsed.partner === "absent" && hasPartner(partner)) return false;
  if (
    parsed.partnerName &&
    matchKnowledgeTerm(
      indexKnowledgeFragment(partner),
      tokenizeKnowledgeText(parsed.partnerName)
    ) < 0
  )
    return false;
  if (parsed.stages.length || parsed.excludedStages.length) {
    if (
      card.type !== "project" ||
      parsed.excludedStages.includes(card.readinessStage)
    )
      return false;
    if (parsed.stages.length && !parsed.stages.includes(card.readinessStage))
      return false;
  }
  if (parsed.placements.length || parsed.excludedPlacements.length) {
    if (
      card.type !== "laboratory" ||
      parsed.excludedPlacements.includes(card.placementStatus)
    )
      return false;
    if (
      parsed.placements.length &&
      !parsed.placements.includes(card.placementStatus)
    )
      return false;
  }
  if (parsed.contours.length || parsed.excludedContours.length) {
    if (
      card.type !== "project" ||
      parsed.excludedContours.includes(card.contour)
    )
      return false;
    if (parsed.contours.length && !parsed.contours.includes(card.contour))
      return false;
  }
  return !parsed.jointOnly || isJointProject(card);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniquePartners(values: string[]): string[] {
  const seen = new Map<string, string>();

  values.filter(hasPartner).forEach((value) => {
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
    .map((card) => ({
      card,
      relevance: knowledgeCardMatch(
        card,
        parsed.terms,
        parsed.equipmentOnly ? "equipment" : "structured"
      ),
    }))
    .filter(({ relevance }) => relevance > 0)
    .sort(({ card: a, relevance: first }, { card: b, relevance: second }) => {
      if (first !== second) return second - first;
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
  const rows = matchedCards.map(({ card }) => toRow(card, customTypes));

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

  const needsClarification = parsed.unparsed.length > 0;
  if (needsClarification) {
    notice =
      "Уточните условия запроса: «" + parsed.unparsed.join("», «") + "».";
  } else if (rows.length === 0) {
    notice = `По запросу «${query}» в базе нет подходящих карточек. Система не добавляет сведения и не делает предположений.`;
  }

  return {
    query,
    filters: parsed.filters,
    cards: rows,
    summary,
    notice,
    interpretation: needsClarification
      ? {
          status: "needs-clarification",
          message: notice ?? undefined,
          unparsed: parsed.unparsed,
        }
      : { status: "ready" },
  };
}

export function getAnalyticsExamples(
  cards: KnowledgeCard[],
  customTypes: CardTypeDefinition[] = []
): string[] {
  const approved = cards
    .map(getApprovedVersion)
    .filter((card) => card !== null);
  if (!approved.length) return [];

  const candidates = [
    "Собери все проекты взаимодействия вузов с индустриальными партнёрами в сфере медицины",
    "Сделай отчёт по взаимодействию вузов между собой в здравоохранении",
    "Покажи действующие лаборатории",
    "Покажи паспорт кампуса",
    ...approved
      .toSorted(
        (first, second) =>
          Number(second.type === "laboratory") -
          Number(first.type === "laboratory")
      )
      .map((card) => {
        if (card.type === "university")
          return "Покажи паспорт вуза " + getUniversityName(card.universityId);
        if (card.type === "laboratory") {
          const equipment = card.equipment.find(
            (entry) => entry && entry.length < 80 && !/[«»"]/u.test(entry)
          );
          if (equipment) return "Покажи лаборатории с «" + equipment + "»";
        }
        return "Покажи карточки «" + card.id + "»";
      }),
  ];
  const examples: string[] = [];
  const results = new Set<string>();
  for (const query of new Set(candidates)) {
    const { cards: rows, interpretation } = buildAnalyticsReport(
      query,
      approved,
      customTypes
    );
    if (!rows.length || interpretation?.status !== "ready") continue;
    const ids = rows
      .map((row) => row.id)
      .sort()
      .join("|");
    if (results.has(ids)) continue;
    results.add(ids);
    examples.push(query);
    if (examples.length === 5) break;
  }
  return examples;
}
