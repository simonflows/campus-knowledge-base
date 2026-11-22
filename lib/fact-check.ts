import {
  AUDIT_STOP_RULES,
  type AuditStopCategory,
} from "./audit-canon-registry";
import {
  getFolderPathLabel,
  getUniversityById,
  getUniversityFullName,
  getUniversityName,
  getApprovedVersion,
  type UniversityCard,
  placementStatusLabels,
  type CampusCard,
  type KnowledgeCard,
  type LaboratoryCard,
  type ProjectCard,
} from "./knowledge";
import { universities } from "./data";
import {
  knowledgeQueryTerms,
  sameKnowledgeWord,
  tokenizeKnowledgeText,
  withoutSourceUrls,
} from "./knowledge-query";
import { knowledgeCardMatch } from "./knowledge-search";

export const FACT_CHECK_CHECKPOINTS = {
  campus: "Общие параметры кампуса",
  placement: "Статус и размещение объекта",
  authorship: "Авторство и соисполнители",
  contour: "Разделение контуров",
  names: "Официальные названия и должности",
  figures: "Неподтверждённые цифры",
} as const;

export type FactCheckCheckpoint = keyof typeof FACT_CHECK_CHECKPOINTS;

export const FACT_CHECK_LEVELS = ["red", "yellow", "green"] as const;

export type FactCheckLevel = (typeof FACT_CHECK_LEVELS)[number];

export const levelLabels: Record<FactCheckLevel, string> = {
  red: "Красный",
  yellow: "Жёлтый",
  green: "Зелёный",
};

export const levelDescriptions: Record<FactCheckLevel, string> = {
  red: "Прямое искажение — публикация запрещена до правки",
  yellow: "Нет подтверждения в базе — требуется уточнение",
  green: "Факт подтверждён официальной карточкой",
};

export type FactCheckFinding = {
  id: string;
  level: FactCheckLevel;
  checkpoint: FactCheckCheckpoint;
  checkpointLabel: string;
  title: string;
  quote: string;
  explanation: string;
  suggestion: string;
  sourceCardId: string | null;
  sourceCardTitle: string | null;
  sourceFolder: string | null;
  sourceUrl?: string | null;
  quoteStart?: number;
  quoteEnd?: number;
};

export type FactCheckSummary = {
  red: number;
  yellow: number;
  green: number;
  total: number;
};

export type FactCheckCheckpointSummary = {
  key: FactCheckCheckpoint;
  label: string;
  red: number;
  yellow: number;
  green: number;
};

export type FactCheckResult = {
  findings: FactCheckFinding[];
  summary: FactCheckSummary;
  checkpoints: FactCheckCheckpointSummary[];
  canPublish: boolean;
  checkedChars: number;
  coverage: "confirmed" | "partial" | "unverified";
};

export type CanonicalRewriteChunk = {
  id: string;
  content: string;
};

export type CanonicalRewriteSection = {
  id: string;
  heading: string;
  level: 2 | 3;
  chunks: CanonicalRewriteChunk[];
};

export type CanonicalRewrite = {
  title: string;
  lead: string;
  sections: CanonicalRewriteSection[];
  sourceCardIds: string[];
  sourceCardTitles: string[];
  plainText: string;
};

export const FACT_CHECK_EXAMPLE_TEXT =
  "В новом учебно-научном корпусе кампуса «Южный Урал» в Челябинске уже работает уникальная медицинская VR-лаборатория, полностью разработанная одним из вузов-резидентов. В 2025 году здесь создали виртуальный тренажёр травмпункта, через который уже прошли обучение более 5000 врачей области. Общая площадь кампуса на сегодня составляет 110 тыс. кв. метров";

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .trim();
}

function tokenRoots(value: string): string[] {
  return normalize(value)
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .map((token) => token.slice(0, 5));
}

function uniqueRoots(value: string): string[] {
  return Array.from(new Set(tokenRoots(value)));
}

function termMatches(term: string, draftRoots: Set<string>): boolean {
  const cleaned = term.replace(/\([A-ZА-Я0-9\s._-]{3,32}\)/g, " ");
  const roots = uniqueRoots(cleaned);

  if (roots.length === 0) return false;

  const matched = roots.filter((root) => draftRoots.has(root)).length;
  const required =
    roots.length === 1
      ? 1
      : roots.length === 2
        ? 2
        : Math.ceil(roots.length * 0.65);

  return matched >= required;
}

function distinctiveTermMatches(
  term: string,
  draftRoots: Set<string>
): boolean {
  const roots = uniqueRoots(term);

  if (roots.length < 2 || normalize(term).length < 10) return false;

  const matched = roots.filter((root) => draftRoots.has(root)).length;

  return matched >= Math.ceil(roots.length * 0.75);
}

function isVrLaboratory(card: KnowledgeCard): card is LaboratoryCard {
  if (card.type !== "laboratory") return false;

  const text = normalize(
    [
      card.title,
      ...card.workDirections,
      ...card.equipment,
      card.referenceDescription,
    ].join(" ")
  );

  return text.includes("vr");
}

function cardReferenceTerms(card: KnowledgeCard): string[] {
  const terms: string[] = [card.title];

  if (card.type === "project") {
    terms.push(card.sphere, card.industrialPartner);
    terms.push(...card.confirmedFigures);

    if (card.isJoint) {
      terms.push(
        card.participantUniversityIds
          .map((universityId) => getUniversityFullName(universityId))
          .join(" и ")
      );
    }
  }

  if (card.type === "laboratory") {
    terms.push(
      card.affiliation,
      ...card.workDirections,
      ...card.equipment,
      ...card.confirmedIndicators
    );
  }

  if (card.type === "campus") {
    terms.push(
      "кампус «Южный Урал»",
      ...card.campusMetrics.map((metric) => metric.label)
    );
  }

  return terms.filter((term) => term.trim().length > 0);
}

function isCardReferenced(
  card: KnowledgeCard,
  draftRoots: Set<string>,
  normalizedDraft: string
): boolean {
  if (termMatches(card.title, draftRoots)) return true;

  if (
    isVrLaboratory(card) &&
    normalizedDraft.includes("vr") &&
    normalizedDraft.includes("лаборатор")
  ) {
    return true;
  }

  const nonTitleMatches = cardReferenceTerms(card)
    .slice(1)
    .filter((term) => distinctiveTermMatches(term, draftRoots));

  return nonTitleMatches.length >= 2;
}

function isSentenceBoundary(text: string, index: number): boolean {
  if (text[index] === "\n" || text[index] === "\r") return true;
  if (
    !/[.!?]/.test(text[index]) ||
    (index + 1 < text.length && !/\s/.test(text[index + 1]))
  )
    return false;
  if (
    text[index] === "." &&
    /(?:тыс|кв|г|гг|гост|корп|уч|млн|млрд|авг|сент|эт|студ|им|пр|ул|лаб|(?<![а-яё])[а-яё])\.$/i.test(
      text.slice(Math.max(0, index - 8), index + 1)
    )
  )
    return false;
  return true;
}

function sentenceAt(text: string, index: number, ellipsize = true): string {
  let start = 0;
  let end = text.length;

  for (let i = index; i >= 0; i -= 1) {
    if (isSentenceBoundary(text, i)) {
      start = i + 1;
      break;
    }
  }

  for (let i = index; i < text.length; i += 1) {
    if (isSentenceBoundary(text, i)) {
      end = i + 1;
      break;
    }
  }

  const sentence = text.slice(start, end).trim();

  if (!ellipsize || sentence.length <= 280) return sentence;

  return `${sentence.slice(0, 277).trimEnd()}…`;
}

function sourceFromCard(card: KnowledgeCard) {
  return {
    sourceCardId: card.id,
    sourceCardTitle: card.title,
    sourceFolder: getFolderPathLabel(card.folderId),
  };
}

function parseNumeric(value: string): number {
  const firstBound = value.split(/[–—-]/)[0] ?? value;
  const cleaned = firstBound
    .replace(/\s+/g, "")
    .replace(/,/g, ".")
    .replace(/[^\d.]/g, "");

  return Number.parseFloat(cleaned);
}

function formatArea(value: number): string {
  return `${value.toLocaleString("ru-RU").replace(/\u00a0/g, " ")} м²`;
}

function resolveQueue(value: string): "first" | "second" | "third" | null {
  const normalized = normalize(value);

  if (
    normalized === "iii" ||
    normalized === "3" ||
    normalized.startsWith("трет")
  ) {
    return "third";
  }

  if (
    normalized === "ii" ||
    normalized === "2" ||
    normalized.startsWith("втор")
  ) {
    return "second";
  }

  if (
    normalized === "i" ||
    normalized === "1" ||
    normalized.startsWith("перв")
  ) {
    return "first";
  }

  return null;
}

const AUDIT_CATEGORY_TO_CHECKPOINT: Record<
  AuditStopCategory,
  FactCheckCheckpoint
> = {
  campus_params: "campus",
  placement_status: "placement",
  coauthorship: "authorship",
  contours: "contour",
  names_entities: "names",
  unverified_metrics: "figures",
};

type CampusAreaScope = "land" | "academic" | "hotel" | "housing" | "campus";

function campusAreaScope(text: string): CampusAreaScope | null {
  if (/земл|зем[её]л|участ(?:ок|к[а-яё]*)/iu.test(text)) return "land";
  if (/(?<![а-яё])унк(?![а-яё])|учебно[- ]научн/iu.test(text)) return "academic";
  if (/гостини[цч]|общежити/iu.test(text)) return "hotel";
  if (/жил[а-яё]*\s+част|жилая|жилой/iu.test(text)) return "housing";
  if (/общ[а-яё]*\s+площад|площад[а-яё]*\s+(?:объект|кампус)/iu.test(text)) return "campus";
  return null;
}

function campusAreaEvidence(card: CampusCard, scope: CampusAreaScope | null) {
  if (!scope) return [];
  const sources = card.campusMetrics
    .filter(({ label }) => /площад/iu.test(label))
    .flatMap(({ label, value, note }) => [
      ...(campusAreaScope(label) === scope ? [`${label}: ${value}`] : []),
      ...note.split(/[,;](?!\d)/u).filter((part) => campusAreaScope(part) === scope),
    ]);
  const pattern = /(\d[\d \u00a0.,]*?)(?:[–—-](\d[\d \u00a0.,]*?))?\s*(тыс\.?\s*)?(?:м²|м2|кв\.?\s*м(?:етр[а-яё]*)?)/giu;
  return sources.flatMap((source) => Array.from(source.matchAll(pattern), (match) => {
    const multiplier = match[3] ? 1_000 : 1;
    return {
      source: source.trim(),
      low: parseNumeric(match[1]) * multiplier,
      high: parseNumeric(match[2] ?? match[1]) * multiplier,
    };
  })).filter(({ low, high }) => Number.isFinite(low) && Number.isFinite(high));
}

function isOfficialCampusMeasure(
  card: CampusCard,
  kind: "cost" | "places",
  value: number,
  claim: string
): boolean {
  let sources: string[] = [];
  if (kind === "cost") {
    sources = card.campusMetrics
      .filter((metric) => /стоим|инвест|грант/i.test(metric.label))
      .flatMap((metric) => [metric.value, metric.note]);
  } else {
    const queue = /перв|(?<!\d)1[- ]?я/i.test(claim)
      ? "first"
      : /втор|(?<!\d)2[- ]?я/i.test(claim)
        ? "second"
        : null;
    if (queue) {
      const markers = Array.from(
        card.referenceDescription.matchAll(/(1|2|3)[- ]?я\s+очеред[а-яё]*/gi)
      );
      const markerIndex = markers.findIndex(
        (match) => resolveQueue(match[1]) === queue
      );
      if (markerIndex >= 0)
        sources = [
          card.referenceDescription.slice(
            markers[markerIndex].index,
            markers[markerIndex + 1]?.index ?? card.referenceDescription.length
          ),
        ];
    } else
      sources = card.campusMetrics
        .filter((metric) => /вместимость/i.test(metric.label))
        .flatMap((metric) => [metric.value, metric.note]);
  }
  const unit = kind === "cost" ? "млрд" : "мест[а-яё]*";
  const pattern = new RegExp(
    `(\\d[\\d \u00a0.,]*?)(?:[–—-](\\d[\\d \u00a0.,]*?))?\\s*(тыс\\.?\\s*)?${unit}`,
    "gi"
  );
  return sources.some((source) =>
    Array.from(source.matchAll(pattern)).some((match) => {
      const low = parseNumeric(match[1]);
      const high = parseNumeric(match[2] ?? match[1]);
      return value >= low && value <= high;
    })
  );
}

function campusMeasureContext(draft: string, index: number): string {
  const clause = claimClause(draft, index);
  const prefix = draft.slice(Math.max(0, index - 220), index);
  const marker = Array.from(
    prefix.matchAll(
      /(?:[123][- ]?я|перв[а-яё]*|втор[а-яё]*|трет[а-яё]*)(?:\s+(?:очеред[а-яё]*|этап[а-яё]*)|\s*(?=\())/gi
    )
  ).at(-1);
  return marker &&
    !/[.!?]\s+[А-ЯЁ]/.test(prefix.slice(marker.index! + marker[0].length))
    ? `${marker[0]} ${clause}`
    : clause;
}

function officialQueueYears(
  card: CampusCard,
  queue: "first" | "second" | "third"
): number[] {
  const markers = Array.from(
    card.referenceDescription.matchAll(/([123])[- ]?я\s+очеред[а-яё]*/gi)
  );
  const index = markers.findIndex((match) => resolveQueue(match[1]) === queue);
  if (index < 0) return [];
  return Array.from(
    card.referenceDescription
      .slice(
        markers[index].index,
        markers[index + 1]?.index ?? card.referenceDescription.length
      )
      .matchAll(/\b(?:19|20|21)\d{2}\b/g)
  ).map((match) => Number(match[0]));
}

const singleAuthorPatterns: RegExp[] = [
  /одн(?:им|ого|ому)\s+(?:из\s+)?вуз[а-яё]*/i,
  /одним\s+вузом/i,
  /единственн[а-яё]*\s+(?:автор|разработчик|вуз)[а-яё]*/i,
  /полностью\s+разраб[а-яё]*/i,
  /самостоятельно\s+разраб[а-яё]*/i,
  /силами\s+одного\s+вуз[а-яё]*/i,
  /принадлежит\s+одному\s+вуз[а-яё]*/i,
];

const authorVerb =
  /(?:разработ[а-яё]*|созда[а-яё]*|сделан[а-яё]*|принадлеж[а-яё]*|автор[а-яё]*)/iu;
const soleNamedAuthorVerb =
  /(?:разработал[аи]?|создал[аи]?|разработан[а-яё]*|создан[а-яё]*|принадлежит)/iu;
const activePlacementPattern =
  /(?:работа(?:ет|ют|л[аи]?)|действу(?:ет|ют)|функциониру[а-яё]*|введ[её]н[а-яё]*\s+в\s+эксплуатацию|открыт(?:а|ы|о|ый|ых|ая)?|запущен[а-яё]*)(?![\p{L}])/iu;
const campusPlacementPattern =
  /(?:в|на)\s+(?:новом\s+)?(?:унк(?![а-яё])|учебно[- ]научн[а-яё]*\s+(?:корпус[а-яё]*|комплекс[а-яё]*)|кампус[а-яё]*)/iu;
const futurePlacement =
  /(?:планиру[а-яё]*|до\s+(?:завершения|открытия|ввода)|после\s+(?:ввода|открытия)|буд(?:ет|ут))(?![\p{L}])/iu;
const plannedOpening =
  /планиру[а-яё]*\s+(?:к\s+открытию|открытие|открыть)|откроется|(?:открытие|ввод)\s+запланирован[а-яё]*/iu;
const presentTime =
  /(?:сейчас|сегодня|пока|ещ[её]|в\s+настоящее\s+время|на\s+данный\s+момент)/iu;
const presentPrefix = new RegExp("^" + presentTime.source + "\\s+", "iu");
const presentDenial = new RegExp(
  "^(.+?)\\s+(?:(" +
    presentTime.source +
    ")\\s+)?не\\s+(?:работает|действует|функционирует|открыт[ао]?|запущен[ао]?)\\s*[.!]*$",
  "iu"
);
const openingAndDenial = new RegExp(
  "^(.+?)\\s+(?:(?:только|лишь)\\s+)?(?:" +
    plannedOpening.source +
    ")(?:\\s+(?!и(?:\\s|$))[^\\s,.!?;]+){0,16}\\s+и$",
  "iu"
);
const openingOnly = new RegExp(
  "^(.+?)\\s+(?:" +
    presentTime.source +
    "\\s+)?(?:только|лишь)\\s+(?:" +
    plannedOpening.source +
    ")\\s*[.!]*$",
  "iu"
);
const previousSubject =
  /^\s*(?:он[аи]?|эт(?:от|а|о|и)\s+(?:проект|объект|лаборатор[а-яё]*|тренаж[её]р|робот))\s/iu;
const statementSegmenter = new Intl.Segmenter("ru", {
  granularity: "sentence",
});
const abbreviationDot =
  /(?<![\p{L}\p{N}])(?:им|г|гг|ул|пр|корп|тыс|млн|млрд|кв|лаб|гост|эт|[А-ЯA-Z])\.(?=\s|[)])|(?<=ВЭБ)\.(?=РФ)/gu;

export function factCheckSentenceRanges(line: string) {
  const masked = line.replace(
    abbreviationDot,
    (value) => value.slice(0, -1) + "·"
  );
  return Array.from(
    statementSegmenter.segment(masked),
    ({ index, segment }) => ({
      index,
      text: line.slice(index, index + segment.length),
    })
  );
}

/** Respect paragraph boundaries, then split the independent sides of a contrast. */
function lineStatements(line: string): string[] {
  return factCheckSentenceRanges(line)
    .flatMap(({ text }) => text.split(/;\s+|,\s+(?:а|но|тогда\s+как)\s+/iu))
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export function factCheckStatements(text: string): string[] {
  return text.split(/[\r\n]/u).flatMap(lineStatements);
}

function locallyNegated(claim: string, index: number): boolean {
  const prefix = claim.slice(Math.max(0, index - 72), index);
  return /(?:^|[^\p{L}])(?:не(?!\s+только)|нельзя|запрещено)(?:\s+[\p{L}-]+){0,6}\s*[«„"']?\s*$/iu.test(
    prefix
  );
}

function affirmed(claim: string, pattern: RegExp): boolean {
  return [...claim.matchAll(new RegExp(pattern.source, "giu"))].some(
    (match) => !locallyNegated(claim, match.index)
  );
}

const contourClaims: Array<{
  contour: ProjectCard["contour"];
  wording: RegExp;
}> = [
  {
    contour: "ПИШ",
    wording:
      /(?<![\p{L}\p{N}])пиш(?![\p{L}\p{N}])|передов[а-яё]*\s+инженерн[а-яё]*\s+школ[а-яё]*/iu,
  },
  {
    contour: "УМНОЦ",
    wording:
      /(?<![\p{L}\p{N}])умноц(?![\p{L}\p{N}])|межвузовск[а-яё]*\s+научно[- ]образовательн[а-яё]*/iu,
  },
  {
    contour: "собственный проект вуза",
    wording: /собственн[а-яё]*\s+(?:проект[а-яё]*\s+вуза|инициатив[а-яё]*)/iu,
  },
  {
    contour: "кампус",
    wording: /(?:контур[а-яё]*|в\s+рамках|продукт[а-яё]*)\s+«?кампус[а-яё]*/iu,
  },
];
const contourCue =
  /контур|относ[иия][а-яё]*\s+к|проект[а-яё]*\s+(?:пиш|умноц)|в\s+(?:рамках|пиш|умноц)|контекст[а-яё]*\s+программ|передов[а-яё]*\s+инженерн[а-яё]*\s+школ[а-яё]*|собственн[а-яё]*\s+проект|продукт[а-яё]*\s+кампуса/iu;

function projectTitle(card: KnowledgeCard) {
  return card.title.replace(/\s*\([A-ZА-Я0-9\s._-]{3,32}\)\s*$/u, "").trim();
}

function scopedCards<T extends KnowledgeCard>(
  statement: string,
  candidates: T[]
): T[] {
  const text = " " + normalize(statement) + " ";
  const exact = candidates.filter((card) =>
    [card.id, projectTitle(card)].some((part) => {
      const name = normalize(part);
      return name.length >= 5 && text.includes(" " + name + " ");
    })
  );
  if (exact.length) return exact;
  const roots = new Set(tokenRoots(statement));
  return candidates.filter(
    (card) =>
      distinctiveTermMatches(projectTitle(card), roots) ||
      (card.type === "laboratory" &&
        card.equipment.some((equipment) => {
          const names =
            equipment.match(
              /(?<![\p{L}\p{N}])(?=[A-Za-z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{2,}(?![\p{L}\p{N}])/gu
            ) ?? [];
          return names.some((name) =>
            text.includes(" " + normalize(name) + " ")
          );
        })) ||
      (isVrLaboratory(card) &&
        /vr[\s-]+лаборатор|лаборатор[а-яё]*[\s-]+[^.!?]{0,30}\bvr\b/iu.test(
          statement
        ))
  );
}

function uniqueScopedCard<T extends KnowledgeCard>(
  statement: string,
  candidates: T[]
): T | undefined {
  const scoped = scopedCards(statement, candidates);
  return scoped.length === 1 ? scoped[0] : undefined;
}

export function deniesCurrentOperation(
  statement: string,
  lab: LaboratoryCard,
  labs: LaboratoryCard[]
): boolean {
  if (lab.placementStatus !== "active" || statement.length > 500) return false;
  const claim = statement.replace(presentPrefix, "");
  const denial = presentDenial.exec(claim);
  const precedingPlan = denial && openingAndDenial.exec(denial[1]);
  // A coordinated denial after a plan must explicitly refer to the present.
  if (precedingPlan && !denial[2] && claim === statement) return false;
  const subject =
    precedingPlan?.[1] ?? denial?.[1] ?? openingOnly.exec(claim)?.[1];
  if (!subject) return false;

  // Resolve the complete subject before scoring a negative claim. The alias
  // may connect the lab and its equipment with «с» in place of «и».
  const withoutLinkers = (text: string) =>
    tokenizeKnowledgeText(text)
      .filter((word) => !/^(?:и|с|со)$/u.test(word))
      .join(" ");
  const names = labs.filter((card) =>
    [projectTitle(card), card.title, card.id].some((name) =>
      equivalentWords(withoutLinkers(subject), withoutLinkers(name))
    )
  );
  return names.length === 1 && names[0].id === lab.id;
}
function collectScopedFindings(
  statements: string[],
  projects: ProjectCard[],
  labs: LaboratoryCard[]
): FactCheckFinding[] {
  const findings: FactCheckFinding[] = [];
  const scoped = new Map<
    string,
    { project?: ProjectCard; lab?: LaboratoryCard }
  >();
  const models = recordedEquipmentModels(labs);
  let previousProject: ProjectCard | undefined;
  let previousLab: LaboratoryCard | undefined;
  for (const [index, statement] of statements.entries()) {
    const anaphora = previousSubject.test(statement);
    let scope = scoped.get(statement);
    if (!scope) {
      const equipment = namedEquipmentMentions(statement, models);
      scope = {
        project: uniqueScopedCard(statement, projects),
        lab: equipment.length
          ? scopedEquipmentLab(equipment, labs)
          : uniqueScopedCard(statement, labs),
      };
      scoped.set(statement, scope);
    }
    const project = scope.project ?? (anaphora ? previousProject : undefined);
    const lab = scope.lab ?? (anaphora ? previousLab : undefined);
    previousProject = project;
    previousLab = lab;

    const sole =
      singleAuthorPatterns.some((pattern) => affirmed(statement, pattern)) &&
      affirmed(statement, authorVerb);
    const directlyLinked = statements[index + 1] ?? "";
    const linkedProject =
      !project &&
      lab &&
      sole &&
      /(?:здесь|в этой лаборатории)\s+(?:созда|разработ)[а-яё]+/iu.test(
        directlyLinked
      )
        ? uniqueScopedCard(directlyLinked, projects)
        : undefined;
    const authorProject = project ?? linkedProject;
    if (authorProject) {
      const participants =
        authorProject.participantUniversityIds.map(getUniversityName);
      const mentionsSingleAuthor =
        authorProject.isJoint &&
        authorProject.participantUniversityIds.filter((id) =>
          universityMentioned(id, statement)
        ).length === 1 &&
        affirmed(statement, soleNamedAuthorVerb) &&
        !/совместн|соисполн|вместе/iu.test(statement);
      if (
        (sole || mentionsSingleAuthor) &&
        (authorProject.isJoint || authorProject.coExecutors.length > 0)
      ) {
        const names = authorProject.isJoint
          ? participants.join(" и ")
          : authorProject.coExecutors.join(", ");
        findings.push(
          createFinding({
            level: "red",
            checkpoint: "authorship",
            title: authorProject.isJoint
              ? "Совместный проект приписан одному вузу"
              : "Не указаны соисполнители проекта",
            quote: linkedProject ? statement + " " + directlyLinked : statement,
            explanation:
              "В утверждённой карточке «" +
              authorProject.title +
              "» указаны соисполнители: " +
              names +
              ".",
            suggestion:
              "Укажите роли соисполнителей. Инициатор — " +
              getUniversityName(authorProject.initiatorUniversityId) +
              ".",
            ...sourceFromCard(authorProject),
          })
        );
      }
    }

    if (project && contourCue.test(statement)) {
      for (const { contour, wording } of contourClaims) {
        for (const match of statement.matchAll(
          new RegExp(wording.source, "giu")
        )) {
          const negative = locallyNegated(statement, match.index);
          if (negative !== (contour === project.contour)) continue;
          findings.push(
            createFinding({
              level: "red",
              checkpoint: "contour",
              title: "Утверждение о контуре противоречит карточке",
              quote: statement,
              explanation:
                "В действующей карточке проекта указан контур «" +
                project.contour +
                "».",
              suggestion:
                "Укажите контур «" +
                project.contour +
                "» и отделите участие в других программах.",
              ...sourceFromCard(project),
            })
          );
        }
      }
    }

    if (
      lab &&
      (activePlacementPattern.test(statement) || plannedOpening.test(statement))
    ) {
      const activeHere =
        affirmed(statement, activePlacementPattern) &&
        !futurePlacement.test(statement);
      const campusHere = affirmed(statement, campusPlacementPattern);
      const currentLocations = lab.placementDetails
        .split(/;|,\s*(?=план)/iu)
        .filter((part) => !futurePlacement.test(part));
      const previouslyActive = currentLocations.some((part) =>
        affirmed(part, activePlacementPattern)
      );
      const currentCampus = currentLocations.some((part) =>
        affirmed(part, campusPlacementPattern)
      );
      const years = (value: string) => [
        ...new Set(value.match(/\b(?:19|20|21)\d{2}\b/gu) ?? []),
      ];
      const dates = years(statement);
      const plannedDates = years(
        lab.placementDetails
          .split(/;|,\s*(?=план)/iu)
          .filter((part) => futurePlacement.test(part))
          .join(" ")
      );
      const wrongOpening =
        affirmed(statement, plannedOpening) &&
        dates.length === 1 &&
        plannedDates.length === 1 &&
        dates[0] !== plannedDates[0];
      const contradicts =
        activeHere &&
        ((lab.placementStatus === "planned" &&
          (campusHere || !previouslyActive)) ||
          (lab.placementStatus === "active" && campusHere && !currentCampus));
      if (contradicts || wrongOpening || deniesCurrentOperation(statement, lab, labs)) {
        const details =
          lab.placementDetails.trim() ||
          placementStatusLabels[lab.placementStatus];
        findings.push(
          createFinding({
            level: "red",
            checkpoint: "placement",
            title: "Статус или площадка лаборатории противоречит карточке",
            quote: statement,
            explanation:
              "В действующей карточке «" + lab.title + "»: " + details + ".",
            suggestion: "Укажите размещение по карточке: " + details + ".",
            ...sourceFromCard(lab),
          })
        );
      }
    }
  }
  return findings;
}

function universityMentioned(universityId: string, draft: string): boolean {
  const university = getUniversityById(universityId);

  if (!university) {
    return normalize(draft).includes(normalize(universityId));
  }

  return (
    normalize(draft).includes(normalize(university.shortName)) ||
    normalize(draft).includes(normalize(university.fullName))
  );
}

const noSource = {
  sourceCardId: null,
  sourceCardTitle: null,
  sourceFolder: null,
  sourceUrl: null,
};

function auditSuggestion(ruleId: string, card: KnowledgeCard, fallback: string) {
  if (ruleId === "RULE-KUKA-TRANSCRIPTION" && card.type === "laboratory") {
    const equipment = card.equipment.find((item) => /\bKUKA\b/iu.test(item));
    const name = equipment ? `Название в карточке — «${equipment}». ` : "";
    return name + "Уточните способ изготовления и материал по первоисточнику.";
  }
  if (ruleId === "RULE-245-PRODUCTS-5REGIONS") {
    return "Уточните показатели Челябинска по официальному источнику. Для сводного показателя укажите охват и период.";
  }
  return fallback;
}

/** Scope at the claim, never at the whole document. Commas in decimals stay intact. */
function claimClause(text: string, index: number): string {
  const separatorAt = (position: number) =>
    /[;\n]/.test(text[position]) ||
    isSentenceBoundary(text, position) ||
    (text[position] === "," && !/\d/.test(text[position + 1] ?? ""));
  let start = index;
  let end = index;
  while (start > 0 && !separatorAt(start - 1)) start--;
  while (end < text.length && !separatorAt(end)) end++;
  return text.slice(start, end).trim();
}

function universitiesIn(value: string): string[] {
  return universities
    .filter((university) => universityMentioned(university.id, value))
    .map((university) => university.id);
}

function scopedUniversity(draft: string, index: number): string | null {
  const clause = claimClause(draft, index);
  const ids = universitiesIn(clause);
  if (ids.length === 1) return ids[0];
  // A statement naming several universities cannot assign one university's number.
  return null;
}

function isCampusClaim(draft: string, index: number): boolean {
  const clause = claimClause(draft, index);
  const sentence = sentenceAt(draft, index);
  return (
    universitiesIn(clause).length === 0 &&
    (/кампус|(?<![а-яё])унк(?![а-яё])|учебно[- ]научн|гостини[цч]|очеред|этап|земл/i.test(
      clause
    ) ||
      (universitiesIn(sentence).length === 0 &&
        /кампус|(?<![а-яё])унк(?![а-яё])|учебно[- ]научн|гостини[цч]/i.test(
          sentence
        )))
  );
}

function unitRoot(value: string): string {
  return normalize(value)
    .split(" ")
    .map((token) => token.slice(0, 5))
    .join(" ");
}

function sameUnit(unit: string, claim: string): boolean {
  const roots = unitRoot(unit).split(" ").filter(Boolean);
  const claimRoots = new Set(unitRoot(claim).split(" "));
  return roots.length > 0 && roots.every((root) => claimRoots.has(root));
}

const universityMetricWords = new Set(
  "в за с к по на год года году факт фактический план фактически получил получила получили выделено выделены предоставлено составляет составило насчитывается было будет будут предусмотрено планирует запланировано".split(
    " "
  )
);

function namesUniversityMetric(
  item: UniversityCard["structuredMetrics"][number],
  claim: string,
  universityId: string
): boolean {
  const words = tokenizeKnowledgeText(claim).filter(
    (word) => !/^\d/u.test(word)
  );
  const label = tokenizeKnowledgeText(item.label);
  const unit = tokenizeKnowledgeText(item.unit);
  const names = tokenizeKnowledgeText(
    getUniversityName(universityId) + " " + getUniversityFullName(universityId)
  );
  const inSet = (word: string, values: string[]) =>
    values.some((value) => sameKnowledgeWord(word, value));
  const quota =
    label.includes("квота") &&
    words.some((word) =>
      /^(?:получил[аи]?|выделен[оы]?|предоставлено|планирует)$/u.test(word)
    );
  const labelDefined = label.every(
    (word) =>
      inSet(word, unit) || inSet(word, words) || (quota && word === "квота")
  );
  return (
    labelDefined &&
    words.every(
      (word) =>
        universityMetricWords.has(word) ||
        inSet(word, names) ||
        inSet(word, label) ||
        inSet(word, unit) ||
        (quota && sameKnowledgeWord(word, "кампус"))
    )
  );
}

type FindingInput = Omit<FactCheckFinding, "id" | "checkpointLabel">;

function normalizeQuoteForCompare(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function createFinding(input: FindingInput): FactCheckFinding {
  return {
    ...input,
    id: `${input.checkpoint}-${input.sourceCardId}-${input.level}-${input.title}-${normalizeQuoteForCompare(input.quote).slice(0, 48)}`,
    checkpointLabel: FACT_CHECK_CHECKPOINTS[input.checkpoint],
  };
}

function buildSummary(findings: FactCheckFinding[]): FactCheckSummary {
  return {
    red: findings.filter((finding) => finding.level === "red").length,
    yellow: findings.filter((finding) => finding.level === "yellow").length,
    green: findings.filter((finding) => finding.level === "green").length,
    total: findings.length,
  };
}

function buildCheckpointSummaries(
  findings: FactCheckFinding[]
): FactCheckCheckpointSummary[] {
  return (Object.keys(FACT_CHECK_CHECKPOINTS) as FactCheckCheckpoint[]).map(
    (key) => {
      const scoped = findings.filter((finding) => finding.checkpoint === key);

      return {
        key,
        label: FACT_CHECK_CHECKPOINTS[key],
        red: scoped.filter((finding) => finding.level === "red").length,
        yellow: scoped.filter((finding) => finding.level === "yellow").length,
        green: scoped.filter((finding) => finding.level === "green").length,
      };
    }
  );
}

function evidenceKey(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/\[[a-z0-9._-]+\]/giu, "")
    .replace(/[«»„“”"]/gu, "")
    .replace(/\s[—–]\s/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.;:!?]+$/u, "")
    .trim();
}

type OfficialField = "head" | "partner" | "title" | "organization";
type OfficialClaim = {
  field: OfficialField;
  predicate: string;
  value: string;
  subject?: string;
  negated?: boolean;
};

const position =
  /(?:(?:заместител[а-яё]*|исполняющ[а-яё]*\s+обязанности)\s+)?(?:руководител[а-яё]*|заведующ[а-яё]*|директор[а-яё]*)/i;
const partnerRole =
  /(?:(?:индустриальн[а-яё]*|промышленн[а-яё]*|будущ[а-яё]*|планируем[а-яё]*|действующ[а-яё]*|бывш[а-яё]*|прежн[а-яё]*|предыдущ[а-яё]*)\s+){0,2}партн[её]р[а-яё]*/i;
const titleRole =
  /(?:(?:официальн[а-яё]*|полн[а-яё]*|кратк[а-яё]*)\s+)?(?:название|наименование)/i;
const organizationRole =
  /(?:техническ[а-яё]*\s+заказчик[а-яё]*|финансов[а-яё]*\s+партн[её]р[а-яё]*|концессионер[а-яё]*|оператор[а-яё]*|инвестор[а-яё]*|кредитор[а-яё]*)/i;
const officialRoles = [
  { field: "head", pattern: position },
  { field: "partner", pattern: partnerRole },
  { field: "title", pattern: titleRole },
  { field: "organization", pattern: organizationRole },
] satisfies Array<{ field: OfficialField; pattern: RegExp }>;
const namedRelation = new RegExp(
  "^(?<predicate>" +
    officialRoles.map(({ pattern }) => pattern.source).join("|") +
    ")(?:\\s+(?<subject>.+?))?(?:\\s*:\\s*|\\s+[—–-]\\s+|\\s+(?<negated>не\\s+)?(?:является|выступает)\\s+)(?<value>\\S.*)$",
  "iu"
);
const reversedRelation = new RegExp(
  "^(?<value>.+?)(?:\\s+[—–-]\\s+|\\s+(?<negated>не\\s+)?является\\s+|\\s+(?<denial>не)\\s+)" +
    "(?<predicate>" +
    [position, partnerRole, organizationRole]
      .map(({ source }) => source)
      .join("|") +
    ")(?:\\s+(?<subject>.+))?$",
  "iu"
);
const unconfirmedField =
  /(?:^\s*(?:н\/д|нет|[-—–]|уточняется)\s*$|(?:^|\s)не\s+(?:установ|подтвержд|извест|уточн[её]н|указан|определ[её]н)|нет\s+(?:сведений|данных))/iu;
const personName =
  /^(?:[А-ЯЁA-Z]\.|[А-ЯЁA-Z][\p{L}’'-]{1,38})(?:\s+(?:[А-ЯЁA-Z]\.|[А-ЯЁA-Z][\p{L}’'-]{1,38})){1,3}$/u;

const roleDefinitions = officialRoles.map(({ field, pattern }) => ({
  field,
  pattern: new RegExp("^(?:" + pattern.source + ")$", "iu"),
}));
function officialField(predicate: string): OfficialField | undefined {
  return roleDefinitions.find(({ pattern }) => pattern.test(predicate))?.field;
}

function namedClaim(pattern: RegExp, text: string): OfficialClaim | undefined {
  const groups = pattern.exec(text)?.groups;
  const field = groups && officialField(groups.predicate);
  if (field && groups) {
    const deniedValue = /^не\s+(?!только(?:\s|$))(.+)$/iu.exec(groups.value);
    return {
      field,
      predicate: groups.predicate,
      subject: groups.subject,
      value: deniedValue?.[1] ?? groups.value,
      negated: Boolean(groups.negated || groups.denial || deniedValue),
    };
  }
}

function officialClaims(statement: string): OfficialClaim[] {
  if (statement.length > 500) return [];
  const text = statement
    .replace(referenceLead, "")
    .replace(/[.;:!?]+$/u, "")
    .trim();
  const named =
    namedClaim(namedRelation, text) ?? namedClaim(reversedRelation, text);
  if (named) return [named];
  const head =
    /^(.+?)\s+(не\s+)?(руководит|возглавляет|заведует)\s+(.+)$/iu.exec(text);
  if (head) {
    const [, first, negated, predicate, last] = head;
    return [
      {
        field: "head",
        predicate,
        value: last,
        subject: first,
        negated: Boolean(negated),
      },
      {
        field: "head",
        predicate,
        value: first,
        subject: last,
        negated: Boolean(negated),
      },
    ];
  }
  const partner =
    /^(.+?)\s+(не\s+)?(?:работает|сотрудничает)\s+с\s+(партн[её]ром)\s+(.+)$/iu.exec(
      text
    );
  if (partner) {
    const [, subject, negated, predicate, value] = partner;
    return [
      {
        field: "partner",
        predicate,
        value,
        subject,
        negated: Boolean(negated),
      },
    ];
  }
  const inline = /^([^:]{1,180})\s*:\s*(.+)$/u.exec(text);
  if (inline) {
    const first = namedClaim(namedRelation, inline[2]);
    if (first && !first.subject) return [{ ...first, subject: inline[1] }];
  }
  return [];
}

function equivalentWords(first: string, second: string): boolean {
  const left = tokenizeKnowledgeText(first);
  const right = tokenizeKnowledgeText(second);
  return (
    left.length === right.length &&
    left.length > 0 &&
    left.every((word, index) => sameKnowledgeWord(word, right[index]))
  );
}

function scopeAliases(card: KnowledgeCard): string[] {
  const names = [card.title, projectTitle(card), card.id];
  if (card.type === "university") {
    names.push(
      getUniversityName(card.universityId),
      getUniversityFullName(card.universityId)
    );
  } else if (card.type === "campus") {
    names.push("кампус", "кампус Южный Урал");
  }
  return names;
}

/** Only a complete subject can bind an official role. A title in a nearby clause is insufficient. */
function officialScope(
  subject: string,
  cards: KnowledgeCard[],
  heading = false
): KnowledgeCard | undefined {
  const names = [subject];
  if (!heading) {
    names.push(
      subject.replace(
        /^(?:проект[а-яё]*|вуз[а-яё]*|университет[а-яё]*)\s+(?=[«"„“]|[А-ЯЁ\d])/u,
        ""
      )
    );
  }
  const matches = cards.filter((card) =>
    scopeAliases(card).some((alias) =>
      names.some(
        (name) =>
          normalize(name) === normalize(alias) ||
          (!heading && equivalentWords(name, alias))
      )
    )
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function positionKind(predicate: string) {
  if (/заместител/iu.test(predicate)) return "deputy";
  if (/исполняющ/iu.test(predicate)) return "acting";
  if (/заведу/iu.test(predicate)) return "chair";
  if (/директор/iu.test(predicate)) return "director";
  return "leader";
}

function headComparison(
  claim: OfficialClaim,
  lab: LaboratoryCard
): FactCheckLevel {
  const [name, detail = ""] = lab.head.trim().split(/\s*[,—]\s*/, 2);
  if (!name || unconfirmedField.test(lab.head)) return "yellow";
  const matchesName = normalize(claim.value) === normalize(name);
  if (!matchesName)
    return personName.test(claim.value) &&
      personName.test(name) &&
      !claim.negated
      ? "red"
      : "yellow";
  const requested = positionKind(claim.predicate);
  const actual = positionKind(detail);
  if (requested === "leader" && actual === "deputy") return "yellow";
  if (requested !== "leader" && actual === "leader") return "yellow";
  if (requested !== "leader" && requested !== actual)
    return claim.negated ? "yellow" : "red";
  return claim.negated ? "red" : "green";
}

const legalForm = /^(?:ооо|оао|зао|пао|ао|ано|нпо|гауз|гку|фгбу|гау|гбу)\s+/u;
function partnerPeriod(text: string) {
  const period =
    /(?<![\p{L}])(будущ|планируем|бывш|прежн|предыдущ)[а-яё]*\s+(?:(?:индустриальн|промышленн)[а-яё]*\s+)?партн[её]р/iu
      .exec(text)?.[1]
      .toLowerCase();
  if (!period) return "current";
  return period === "будущ" || period === "планируем" ? "future" : "past";
}

function organizationKey(text: string): string {
  return normalize(text).replace(/^компания\s+/u, "");
}

function organizationParts(value: string): string[] {
  // Quoted names can contain conjunctions and commas. Provenance outside the
  // quoted name does not form part of an entity's official name.
  const quoted = /[«"][^»"]*[»"]/gu;
  return value
    .replace(quoted, (name) =>
      name.replace(/[,/]/gu, "\u0001").replace(/\s+и\s+/giu, "\u0002")
    )
    .split(/\s+(?:и|\/)\s+|,\s+(?!\d)/iu)
    .map((piece) =>
      piece.replaceAll("\u0001", ",").replaceAll("\u0002", " и ").trim()
    );
}

const organizationAttribution =
  /\s+(?:по\s+(?:сообщени|сведени|публикаци|данным)|назван[а-яё]*\s+(?:будущ|планируем|бывш|прежн|предыдущ)|в\s+анонс)/iu;
const exactOrganizationSpelling =
  /^(?:(?:[А-ЯЁA-Z]{2,8}|[Кк]омпания)\s+)?(?:«[^»]+»|"[^"]+"|[А-ЯЁA-Z][\p{L}\p{N}.'’-]*(?:\s+[А-ЯЁA-Z][\p{L}\p{N}.'’-]*){0,4})$/u;

function companyMatches(claimed: string, source: string): boolean {
  return (
    claimed === source ||
    (!legalForm.test(claimed) && claimed === source.replace(legalForm, ""))
  );
}

function companyComparison(
  claim: OfficialClaim,
  expected: string
): FactCheckLevel {
  if (unconfirmedField.test(expected)) return "yellow";
  if (
    claim.field === "partner" &&
    partnerPeriod(expected) !== partnerPeriod(claim.predicate)
  )
    return "yellow";
  if (evidenceKey(claim.value) === evidenceKey(expected)) {
    return claim.negated ? "red" : "green";
  }
  const sourceLabel =
    /^(?:будущ|планируем|бывш|прежн|предыдущ)[а-яё]*\s+партн[её]р[а-яё]*\s*:\s*/iu;
  const sourceParts = organizationParts(expected.replace(sourceLabel, "")).map(
    (piece) => piece.split(organizationAttribution, 1)[0]
  );
  const sourceNames = sourceParts.map(organizationKey).filter(Boolean);
  const claimedParts = organizationParts(claim.value);
  const claimedNames = claimedParts.map(organizationKey).filter(Boolean);
  if (
    !sourceNames.length ||
    !claimedNames.length ||
    claim.value.length > 140 ||
    organizationAttribution.test(claim.value) ||
    !claimedParts.length ||
    claimedParts.some((piece) => !piece) ||
    /(?<![\p{L}])(?:не|только|новый|бывший|между)(?![\p{L}])/iu.test(
      claim.value
    )
  )
    return "yellow";
  const equal = claimedNames.every((name) =>
    sourceNames.some((source) => companyMatches(name, source))
  );
  if (equal) return claim.negated ? "red" : "green";
  // A generic description of a partner category cannot contradict a named company.
  return !claim.negated &&
    claimedParts.every((piece) => exactOrganizationSpelling.test(piece)) &&
    sourceParts.every((piece) => exactOrganizationSpelling.test(piece.trim()))
    ? "red"
    : "yellow";
}

function canonicalOfficialField(
  claim: OfficialClaim,
  card: KnowledgeCard
): string | undefined {
  switch (claim.field) {
    case "head":
      return card.type === "laboratory" ? card.head : undefined;
    case "partner":
      return card.type === "laboratory"
        ? card.partner
        : card.type === "project"
          ? card.industrialPartner
          : undefined;
    case "title":
      if (card.type === "university")
        return /кратк/iu.test(claim.predicate)
          ? getUniversityName(card.universityId)
          : getUniversityFullName(card.universityId);
      if (card.type === "project" || card.type === "laboratory")
        return projectTitle(card);
      return undefined;
    case "organization": {
      if (card.type !== "campus") return undefined;
      const role = organizationRole.exec(claim.predicate)?.[0];
      const roles = card.legalEntities.filter(
        (item) =>
          role &&
          [
            ...item.role.matchAll(new RegExp(organizationRole.source, "giu")),
          ].some(([value]) => equivalentWords(value, role))
      );
      return roles.length === 1 ? roles[0].name : undefined;
    }
  }
}

function officialComparison(
  claim: OfficialClaim,
  card: KnowledgeCard,
  expected: string
): FactCheckLevel {
  if (!expected) return "yellow";
  if (claim.field === "head" && card.type === "laboratory") {
    return headComparison(claim, card);
  }
  if (claim.field === "title") {
    const same = normalize(claim.value) === normalize(expected);
    if (same) return claim.negated ? "red" : "green";
    return claim.negated ? "yellow" : "red";
  }
  return companyComparison(claim, expected);
}

const attributeValue = /^[^:\n]{1,150}(?::\s*|\s+[—–]\s+)\S/u;
const standaloneOfficialTitle =
  /(?:^|\s)(?:руководит|руководят|возглавляет|возглавляют|заведует|заведуют)(?![\p{L}])/iu;

type DraftStatement = { text: string; standalone: boolean };

function collectOfficialFindings(
  statements: DraftStatement[],
  cards: KnowledgeCard[]
) {
  const findings: FactCheckFinding[] = [];
  const headings: (KnowledgeCard | undefined)[] = [];
  const unbound = new Set<number>();
  const checkedStatements = new Set<number>();
  const scopeCache = new Map<string, KnowledgeCard | undefined>();
  const resolve = (text: string, heading: boolean) => {
    const key = heading + ":" + text;
    if (!scopeCache.has(key))
      scopeCache.set(key, officialScope(text, cards, heading));
    return scopeCache.get(key);
  };
  let heading: KnowledgeCard | undefined;
  for (const [index, { text: statement, standalone }] of statements.entries()) {
    if (statement.endsWith("?")) {
      headings.push(undefined);
      heading = undefined;
      continue;
    }
    const namedHeading = standalone ? resolve(statement, true) : undefined;
    if (namedHeading) {
      heading = namedHeading;
      headings.push(undefined);
      findings.push(
        createFinding({
          level: "green",
          checkpoint: "names",
          title: "Название совпадает с утверждённой карточкой",
          quote: statement,
          explanation: "В тексте указано имя сущности из утверждённой базы.",
          suggestion: "Сохраните ссылку на официальную карточку.",
          ...sourceFromCard(namedHeading),
        })
      );
      checkedStatements.add(index);
      continue;
    }
    const claims = officialClaims(statement);
    const checked = claims.flatMap((claim) => {
      const card = claim.subject ? resolve(claim.subject, false) : heading;
      const expected = card && canonicalOfficialField(claim, card);
      return card && expected !== undefined ? [{ claim, card, expected }] : [];
    });
    if (checked.length === 1) {
      const { claim, card, expected } = checked[0];
      const level = officialComparison(claim, card, expected);
      findings.push(
        createFinding({
          level,
          checkpoint: "names",
          title:
            level === "green"
              ? "Сведения совпадают с официальной карточкой"
              : level === "red"
                ? "Сведения не совпадают с официальной карточкой"
                : "Утверждение требует подтверждения",
          quote: statement,
          explanation:
            level === "yellow"
              ? "В утверждённой карточке этой сущности нет достаточных сведений для такой формулировки."
              : "В утверждённой карточке этой сущности указано: " + expected,
          suggestion:
            level === "red"
              ? "Используйте сведения из утверждённой карточки именно этой сущности."
              : level === "green"
                ? "Сохраните ссылку на официальную карточку."
                : "Уточните связь, имя или должность по официальному источнику.",
          ...sourceFromCard(card),
        })
      );
      checkedStatements.add(index);
    } else if (claims.some((claim) => !claim.subject)) {
      unbound.add(index);
    }
    const attribute = attributeValue.test(statement);
    headings.push(attribute ? heading : undefined);
    if (!attribute) heading = undefined;
  }
  return { findings, headings, unbound, checkedStatements };
}

function cardEvidenceStatements(card: KnowledgeCard): string[] {
  const text = [card.title, projectTitle(card), card.referenceDescription];
  if (card.type === "project") {
    text.push(
      ...card.confirmedFigures,
      ...card.confirmedFigures.map((figure) => card.title + ": " + figure),
      card.sphere,
      "Инициатор: " + getUniversityName(card.initiatorUniversityId),
      "Участники: " +
        [
          ...new Set(
            card.isJoint
              ? card.participantUniversityIds.map(getUniversityName)
              : [
                  getUniversityName(card.initiatorUniversityId),
                  ...card.coExecutors,
                ]
          ),
        ].join(", "),
      "Индустриальный партнёр: " + card.industrialPartner,
      "Контур: " + card.contour,
      "Стадия готовности: " + card.readinessStage
    );
  } else if (card.type === "laboratory") {
    text.push(
      placementStatusLabels[card.placementStatus],
      card.placementDetails,
      ...card.confirmedIndicators,
      ...card.workDirections,
      ...card.equipment
    );
  } else if (card.type === "campus") {
    text.push(
      ...card.campusMetrics.flatMap((item) => [
        item.label + ": " + item.value,
        item.note,
      ])
    );
    text.push(
      ...card.legalEntities.map((item) => item.name + " — " + item.role)
    );
    text.push(...card.tariffs.map((item) => item.label + " — " + item.value));
  }
  return [...text, ...text.flatMap(factCheckStatements)];
}

const claimVerb =
  /(?<![\p{L}])(?:\p{L}{3,}(?:ается|яется|уются|иваются|ются|ется|ится|ают|яют|уют|яет|ает|или|али|ели|яла|ила|ала|овал[аи]?|ил[аи]?|ён[аыо]|ен[аыо])|создал[аи]?|получил[аи]?|стал[аи]?|был[аио]?|есть)(?![\p{L}])/iu;
const referenceLead =
  /^(?:по данным|согласно) (?:официальной |утвержденной )?карточк[а-я]*\s*[,—:]?\s*/iu;
const editorialLead =
  /^(?:кроме того|помимо этого|далее|затем|наконец|при этом|в частности|например|таким образом)\s*[,;:]\s*/iu;
const neutralQuestionHeading =
  /^(?:кто\s+участвует(?:\s+в\s+проекте)?|что\s+это(?:\s+(?:такое|означает))?|что\s+дальше|что\s+известно(?:\s+о\s+проекте)?|как\s+это\s+работает|зачем\s+это\s+нужно|где\s+найти\s+источники|где\s+отрабатывают\s+технологию)\s*[?]?$/iu;
const neutralTransition =
  /^(?:сначала|далее|теперь)\s+(?:разбер[её]мся|посмотрим|рассмотрим),\s+(?:как\s+это\s+работает|что\s+это\s+означает)\s*[.!?]?$/iu;
const navigationLead =
  /^(?:(?:(?:а|и)\s+)?(?:сначала|далее|дальше|теперь|затем|после\s+этого|в\s+заключение)|перейд[её]м|верн[её]мся|обратимся)[\s,—–:-]+/iu;
const navigationTopic =
  /^(?:к\s+(?:главному|итогам|выводам|контексту|деталям|подробностям|следующему\s+разделу)|(?:о|об|про)\s+(?:главном|сути|деталях|подробностях|итогах|выводах|контексте))\s*[.!?]?$/iu;
const questionLead =
  /^(?:кто|что|где|когда|как(?:ой|ая|ое|ие|ого|ому|ую|их|им|ими)?|зачем|почему|в\s+ч[её]м|сколько)(?![\p{L}])/iu;
const editorialDirective = /^(?:нельзя|не следует|запрещено)(?![\p{L}])/iu;

function checkableStatement(statement: string, models: string[]): boolean {
  const text = statement.replace(/^#{1,6}\s+/u, "").trim();
  if (neutralQuestionHeading.test(text) || neutralTransition.test(text) ||
      (navigationLead.test(text) && navigationTopic.test(text.replace(navigationLead, "")))) return false;
  if (
    text.endsWith("?") ||
    questionLead.test(text) ||
    attributeValue.test(text) ||
    /\d/u.test(text)
  ) {
    return true;
  }
  return (
    !editorialDirective.test(text) &&
    (claimVerb.test(text) || standaloneOfficialTitle.test(text) ||
      namedEquipmentMentions(text, models).length > 0)
  );
}

function uncoveredStatements(
  statements: string[],
  cards: KnowledgeCard[],
  covered: Set<string>,
  official: ReturnType<typeof collectOfficialFindings>
): FactCheckFinding[] {
  const models = recordedEquipmentModels(cards);
  const candidates = statements
    .map((statement, index) => ({ statement, index }))
    .filter(
      ({ statement, index }) =>
        (checkableStatement(statement, models) || official.unbound.has(index)) &&
        !official.checkedStatements.has(index) &&
        !covered.has(evidenceKey(statement))
    );
  if (!candidates.length) return [];
  const records = new Map(
    cards.map((card) => [
      card.id,
      cardEvidenceStatements(card).map(evidenceKey),
    ])
  );
  const references = new Set([...records.values()].flat());
  return candidates.flatMap(({ statement, index }) => {
    const scope = official.headings[index];
    const key = evidenceKey(statement).replace(editorialLead, "").replace(referenceLead, "");
    if (
      !official.unbound.has(index) &&
      (scope ? records.get(scope.id)?.includes(key) : references.has(key))
    )
      return [];
    return [
      createFinding({
        level: "yellow",
        checkpoint: /\d/u.test(statement) ? "figures" : "names",
        title: "Утверждение требует подтверждения",
        quote: statement,
        explanation:
          "Для этого утверждения нужна отдельная опора в утверждённой карточке.",
        suggestion:
          "Найдите подтверждение именно этого утверждения или уточните его у владельца карточки.",
        ...noSource,
      }),
    ];
  });
}

export function checkFactText(
  draft: string,
  cards: KnowledgeCard[]
): FactCheckResult {
  cards = cards
    .map(getApprovedVersion)
    .filter((card): card is KnowledgeCard => card !== null);
  const findings: FactCheckFinding[] = [];
  const confirmedFigures = new Set<string>();
  const normalizedDraft = normalize(draft);
  const draftEvidenceKey = evidenceKey(draft);
  const draftRoots = new Set(tokenRoots(draft));
  const exactDescriptionCard = cards.find(
    (card) =>
      draftEvidenceKey.length > 40 &&
      evidenceKey(card.referenceDescription) === draftEvidenceKey
  );
  const referencedCards = cards.filter((card) =>
    isCardReferenced(card, draftRoots, normalizedDraft)
  );

  const campusCard =
    referencedCards.find(
      (card): card is CampusCard => card.type === "campus"
    ) ??
    cards.find((card): card is CampusCard => card.type === "campus") ??
    null;

  const referencedProjects = referencedCards.filter(
    (card): card is ProjectCard => card.type === "project"
  );
  const referencedLabs = referencedCards.filter(
    (card): card is LaboratoryCard => card.type === "laboratory"
  );

  const primaryProject =
    referencedProjects.find((card) => card.isJoint) ?? referencedProjects[0];

  const draftStatements = draft.split(/[\r\n]/u).flatMap((line) => {
    const statements = lineStatements(line);
    return statements.map((text) => ({ text, standalone: statements.length === 1 }));
  });
  const statements = draftStatements.map(({ text }) => text);
  const official = collectOfficialFindings(draftStatements, cards);
  findings.push(...official.findings);
  const projectCards = cards.filter(
    (card): card is ProjectCard => card.type === "project"
  );
  const labCards = cards.filter(
    (card): card is LaboratoryCard => card.type === "laboratory"
  );
  findings.push(...collectScopedFindings(statements, projectCards, labCards));

  if (campusCard) {
    const areaRegex =
      /(\d[\d\s.,]*)\s*(тыс\.?\s*)?(?:кв\.?\s*м(?:2|²)?|кв\.?\s*метр[а-яё]*|м(?:2|²)|квадратн[а-яё]*\s+метр[а-яё]*)/gi;
    const nextAreaInClause = new RegExp(areaRegex.source, "i");
    const seenAreas = new Set<string>();
    let areaMatch: RegExpExecArray | null;
    let previousAreaEnd = 0;
    let previousAreaScope: CampusAreaScope | null = null;

    while ((areaMatch = areaRegex.exec(draft)) !== null) {
      const preceding = draft.slice(previousAreaEnd, areaMatch.index);
      previousAreaEnd = areaRegex.lastIndex;
      const restatementScope: CampusAreaScope | null =
        /^\s*\(\s*$/u.test(preceding) && /^\s*\)/u.test(draft.slice(previousAreaEnd))
        ? previousAreaScope
        : null;
      previousAreaScope = null;
      const sentence = sentenceAt(draft, areaMatch.index);
      const measure = areaMatch[0].trim();
      const quote = lineStatements(sentence).find((part) => part.includes(measure)) ?? sentence;

      if (!isCampusClaim(draft, areaMatch.index)) continue;

      const value = parseNumeric(areaMatch[1] ?? "");
      const multiplied = areaMatch[2] ? value * 1000 : value;

      if (!Number.isFinite(multiplied)) continue;

      // The next metric in the same sentence cannot label this number.
      const prefix = claimClause(preceding, preceding.length);
      const before: CampusAreaScope | null = campusAreaScope(prefix) ?? restatementScope;
      const tail: string = before ? "" : claimClause(draft.slice(previousAreaEnd), 0);
      const scope: CampusAreaScope | null = before ??
        (tail && !nextAreaInClause.test(tail) ? campusAreaScope(tail) : null) ??
        (/кампус/iu.test(prefix) && !/площад/iu.test(prefix) ? "campus" : null);
      previousAreaScope = scope;
      const key = `${scope}:${Math.round(multiplied)}`;
      if (seenAreas.has(key)) continue;
      seenAreas.add(key);

      const evidence = campusAreaEvidence(campusCard, scope);
      if (!evidence.some(({ low, high }) => multiplied >= low && multiplied <= high)) {
        const officialAreas = [...new Set(evidence.map(({ source }) => source))].join("; ");
        findings.push(
          createFinding({
            level: evidence.length ? "red" : "yellow",
            checkpoint: "campus",
            title: evidence.length ? "Площадь кампуса не совпадает с паспортом" : "Площадь кампуса требует подтверждения",
            quote,
            explanation: evidence.length
              ? `Показатель ${formatArea(multiplied)} не совпадает с соответствующей площадью в утверждённой версии паспорта: ${officialAreas}.`
              : "В утверждённом паспорте нет показателя площади для указанного объекта.",
            suggestion: evidence.length
              ? "Уточните значение площади по соответствующему полю паспорта."
              : "Сверьте площадь указанного объекта с актуальным официальным документом.",
            ...sourceFromCard(campusCard),
          })
        );
      }
    }

    const costRegex = /(\d[\d\s.,]*)\s*млрд/gi;
    let costMatch: RegExpExecArray | null;

    while ((costMatch = costRegex.exec(draft)) !== null) {
      const sentence = sentenceAt(draft, costMatch.index);

      if (!isCampusClaim(draft, costMatch.index)) continue;

      const value = parseNumeric(costMatch[1] ?? "");

      if (
        Number.isFinite(value) &&
        !isOfficialCampusMeasure(
          campusCard,
          "cost",
          value,
          claimClause(draft, costMatch.index)
        )
      ) {
        findings.push(
          createFinding({
            level: "red",
            checkpoint: "campus",
            title:
              "Стоимость или объём финансирования не совпадает с паспортом",
            quote: sentence,
            explanation: `В утверждённом паспорте: ${campusCard.campusMetrics
              .filter((metric) => /стоим|инвест|грант/i.test(metric.label))
              .map(
                (metric) => `${metric.label}: ${metric.value}. ${metric.note}`
              )
              .join("; ")}. В черновике другое значение.`,
            suggestion:
              "Уточните сумму с привязкой к году расчёта и структуре финансирования по паспорту CAMPUS-PASS-001.",
            ...sourceFromCard(campusCard),
          })
        );
      }
    }

    const placesRegex =
      /(\d[\d\s.,]*)\s*(?:учебн[а-яё]*\s+|жилых\s+)?мест[а-яё]*/gi;
    const hotelCapacityStatement =
      /^(?:(?:общая|проектная)\s+)?вместимость\s+гостиниц(?:\s+кампуса)?\s*[:—–-]?\s*\d[\d\s]*\s+мест[.!]?$/iu;
    let placesMatch: RegExpExecArray | null;

    while ((placesMatch = placesRegex.exec(draft)) !== null) {
      const sentence = sentenceAt(draft, placesMatch.index);

      if (!isCampusClaim(draft, placesMatch.index)) continue;

      const value = parseNumeric(placesMatch[1] ?? "");

      if (!Number.isFinite(value)) continue;
      const scope = campusMeasureContext(draft, placesMatch.index);
      if (
        !isOfficialCampusMeasure(
          campusCard,
          "places",
          value,
          scope
        )
      ) {
        findings.push(
          createFinding({
            level: "red",
            checkpoint: "campus",
            title: "Число мест не совпадает с паспортом кампуса",
            quote: sentence,
            explanation: `В утверждённом паспорте: ${campusCard.campusMetrics
              .filter((metric) => /вместимость|этап/i.test(metric.label))
              .map(
                (metric) => `${metric.label}: ${metric.value}. ${metric.note}`
              )
              .join("; ")}. В черновике другое число мест.`,
            suggestion:
              "Укажите число мест соответствующей очереди или общую вместимость по паспорту. Численность обучающихся — отдельный показатель.",
            ...sourceFromCard(campusCard),
          })
        );
      } else {
        const clause = claimClause(draft, placesMatch.index);
        if (hotelCapacityStatement.test(clause) &&
          isOfficialCampusMeasure(campusCard, "places", value, clause)) {
          confirmedFigures.add(evidenceKey(clause));
          findings.push(createFinding({
            level: "green",
            checkpoint: "campus",
            title: "Вместимость гостиниц подтверждена паспортом",
            quote: clause,
            explanation: "Число относится к проектной вместимости гостиниц кампуса.",
            suggestion: "Сохраните вид показателя и ссылку на официальный паспорт.",
            ...sourceFromCard(campusCard),
          }));
        }
      }
    }

    const queueRegex =
      /(?<![A-Za-zА-Яа-я0-9])(III|II|I|3|2|1|перв[а-яё]*|втор[а-яё]*|трет[а-яё]*)(?:-?[яей])?\s*(?:очеред[а-яё]*|этап[а-яё]*)[^.!?]{0,45}?(\d{4})(?!\d)/gi;
    let queueMatch: RegExpExecArray | null;

    while ((queueMatch = queueRegex.exec(draft)) !== null) {
      if (!isCampusClaim(draft, queueMatch.index)) continue;
      // «3 очереди» / «3 этапа» во множественном числе — это общее количество очередей, а не 3-я очередь
      if (
        /^(?:2|3)\s+(?:очереди|этапа)(?![а-яёa-z0-9])/i.test(queueMatch[0]) ||
        /(?:всего|строительства|разделено\s+на)\s*\(?\s*3\s+(?:очереди|этапа)/i.test(
          sentenceAt(draft, queueMatch.index)
        )
      ) {
        continue;
      }

      const queue = resolveQueue(queueMatch[1] ?? "");
      const year = Number.parseInt(queueMatch[2] ?? "", 10);
      const isValid =
        queue && officialQueueYears(campusCard, queue).includes(year);

      if (!queue || !Number.isFinite(year) || isValid) {
        continue;
      }

      findings.push(
        createFinding({
          level: "red",
          checkpoint: "campus",
          title: "Срок очереди кампуса не совпадает с паспортом",
          quote: sentenceAt(draft, queueMatch.index),
          explanation: `Указанный срок отсутствует у этой очереди в утверждённом паспорте. Подтверждённые годы: ${officialQueueYears(campusCard, queue).join(", ") || "не заданы"}.`,
          suggestion:
            "Уточните очередь, вид срока (строительство/полный запуск) и год по паспорту.",
          ...sourceFromCard(campusCard),
        })
      );
    }

    const nameRegex = /кампус[а-яё]*\s*[«"]([^»"]{3,80})[»"]/gi;
    let nameMatch: RegExpExecArray | null;

    while ((nameMatch = nameRegex.exec(draft)) !== null) {
      const name = normalize(nameMatch[1] ?? "");

      if (name.includes("южный урал")) continue;

      findings.push(
        createFinding({
          level: "red",
          checkpoint: "campus",
          title: "Официальное название кампуса искажено",
          quote: sentenceAt(draft, nameMatch.index),
          explanation:
            "Официальное название объекта — Межуниверситетский кампус мирового уровня «Южный Урал». В черновике использовано другое название.",
          suggestion: "Замените название на официальное: кампус «Южный Урал».",
          ...sourceFromCard(campusCard),
        })
      );
    }
  }

  const figureRegex =
    /(\d[\d\s.,]{0,12})\s+((?:[а-яё]{3,}\s+){0,2})(врач[а-яё]*|человек[а-яё]*|студент[а-яё]*|участник[а-яё]*|пациент[а-яё]*|школ[а-яё]*|наставник[а-яё]*|специалист[а-яё]*|команд[а-яё]*|прототип[а-яё]*|модул[а-яё]*|проект[а-яё]*|мест[а-яё]*|преподавател[а-яё]*|сотрудник[а-яё]*|аспирант[а-яё]*)/gi;
  const seenFigures = new Set<string>();
  let figureMatch: RegExpExecArray | null;

  while ((figureMatch = figureRegex.exec(draft)) !== null) {
    const rawNumber = figureMatch[1] ?? "";
    const key = `${figureMatch.index}:${rawNumber}`;

    if (seenFigures.has(key)) continue;

    seenFigures.add(key);

    const quote = sentenceAt(draft, figureMatch.index);
    const clause = claimClause(draft, figureMatch.index);
    const universityId = scopedUniversity(draft, figureMatch.index);
    const universityIds = universitiesIn(clause);
    const localRoots = new Set(tokenRoots(quote));
    const genericRoots = new Set([
      "вирту",
      "лабор",
      "проек",
      "цифро",
      "центр",
      "платф",
      "систе",
      "техно",
      "промы",
    ]);
    const localCards = cards.filter(
      (card) =>
        (card.type === "project" || card.type === "laboratory") &&
        (termMatches(card.title, localRoots) ||
          card.id === exactDescriptionCard?.id ||
          (referencedCards.some((reference) => reference.id === card.id) &&
            tokenRoots(card.title).some(
              (root) => !genericRoots.has(root) && localRoots.has(root)
            )))
    );
    const universityCard =
      universityId && localCards.length === 0
        ? cards.find(
            (card): card is UniversityCard =>
              card.type === "university" && card.universityId === universityId
          )
        : null;
    const campusScope =
      isCampusClaim(draft, figureMatch.index) ||
      (universityIds.length === 0 &&
        Boolean(
          campusCard?.campusMetrics.some((metric) =>
            normalize(clause).includes(normalize(metric.label))
          )
        ));
    const sourceCard =
      localCards.length === 1
        ? localCards[0]
        : localCards.length > 1
          ? null
          : universityIds.length > 0
            ? universityCard
            : campusScope
              ? campusCard
              : null;
    const value = parseNumeric(rawNumber);
    const unit = figureMatch[3] ?? "";
    const years = clause.match(/\b(?:19|20|21)\d{2}\b/g) ?? [];
    const year = years.length === 1 ? Number(years[0]) : null;
    const kind = /план|будет|будут|предстоит|предусмотр|к\s+\d{4}/i.test(clause)
      ? "plan"
      : "actual";

    let sameNumberDifferentClaim = false;
    if (universityCard) {
      const candidates = universityCard.structuredMetrics.filter(
        (metric) =>
          metric.year === year &&
          sameUnit(metric.unit, unit) &&
          namesUniversityMetric(metric, clause, universityCard.universityId)
      );
      const samePeriod = candidates.filter((metric) => metric.kind === kind);
      const metric =
        samePeriod.length === 1
          ? samePeriod[0]
          : candidates.length === 1
            ? candidates[0]
            : null;
      if (metric) {
        const matches = metric.value === value && metric.kind === kind;
        findings.push(
          createFinding({
            level: matches ? "green" : "red",
            checkpoint: "figures",
            title: matches
              ? "Показатель вуза подтверждён"
              : "Показатель вуза противоречит официальной карточке",
            quote: clause,
            explanation: `${getUniversityName(universityCard.universityId)}: ${metric.label} — ${metric.value} ${metric.unit}, ${metric.year}, ${metric.kind === "plan" ? "план" : "факт"}. Проверено ${metric.verifiedAt}; ответственный: ${metric.owner}.`,
            suggestion: matches
              ? "Сохраните год, статус и ссылку на документ."
              : "Уточните число, год и статус факт/план по документу в карточке этого вуза.",
            ...sourceFromCard(universityCard),
            sourceUrl: metric.evidenceUrl,
          })
        );
        continue;
      }
    } else if (sourceCard) {
      const sources = cardEvidenceStatements(sourceCard);
      const fullStatement = evidenceKey(
        sentenceAt(draft, figureMatch.index, false)
      );
      if (
        exactDescriptionCard?.id === sourceCard.id ||
        sources.some((source) => evidenceKey(source) === fullStatement)
      ) {
        confirmedFigures.add(fullStatement);
        continue;
      }
      if (
        sourceCard.type === "campus" &&
        sameUnit("мест", unit) &&
        isOfficialCampusMeasure(
          sourceCard,
          "places",
          value,
          campusMeasureContext(draft, figureMatch.index)
        )
      ) {
        // This typed rule covers the magnitude and its scope. The surrounding
        // sentence still needs evidence for any additional statement.
        continue;
      }
      sameNumberDifferentClaim = sources.some((source) =>
        Array.from(source.matchAll(new RegExp(figureRegex.source, "gi"))).some(
          (match) =>
            sameUnit(unit, match[3] ?? "") && parseNumeric(match[1]) === value
        )
      );
      // A direct contradiction already owns this numeric claim.
      if (
        findings.some(
          (finding) =>
            finding.level === "red" &&
            finding.sourceCardId === sourceCard.id &&
            finding.quote === quote
        )
      )
        continue;
    }

    findings.push(
      createFinding({
        level: "yellow",
        checkpoint: "figures",
        title: sameNumberDifferentClaim
          ? "Утверждение требует подтверждения"
          : "Цифра не подтверждена официальными данными",
        quote,
        explanation: sameNumberDifferentClaim
          ? "В карточке встречается такое число. Период, статус или связь с другими сведениями в этой формулировке требуют отдельного подтверждения."
          : "Метрики «" +
            figureMatch[0].trim() +
            "» нет в подтверждённых показателях этой сущности за указанный период. Число из другой карточки не является подтверждением.",
        suggestion: universityIds.length
          ? "Укажите вуз, год и статус факт/план; добавьте показатель с документом в паспорт этого вуза."
          : "Уточните сущность, период и единицу измерения; добавьте официальный источник.",
        ...(sourceCard ? sourceFromCard(sourceCard) : noSource),
      })
    );
  }

  for (const rule of AUDIT_STOP_RULES) {
    // The current approved object determines placement and participants.
    // The archived examples contain specific dates and generic pronouns.
    if (
      rule.category === "placement_status" ||
      rule.category === "coauthorship" ||
      rule.id === "RULE-CONTOUR-PISH-MIXUP"
    )
      continue;
    const checkpoint = AUDIT_CATEGORY_TO_CHECKPOINT[rule.category];
    const targetCard = cards.find((card) => card.id === rule.sourceCardId);
    if (!targetCard) continue;
    if (rule.id === "RULE-245-PRODUCTS-5REGIONS") {
      const numbers = /(?<![\p{L}\p{N}.,])(?:37\s+(?:продуктовых\s+)?программ|245\s+(?:решений|продуктов|направлений))(?![\p{L}\p{N}])/giu;
      const quotes = new Set<string>();
      for (const match of draft.matchAll(numbers)) {
        const quote = claimClause(draft, match.index);
        if (!/(?:кампус|челябинск)/iu.test(quote) ||
            /(?:пят[а-яё]*\s+(?:пилотн[а-яё]*\s+)?регион|сводн[а-яё]+\s+показател|федеральн[а-яё]+\s+показател)/iu.test(quote) ||
            locallyNegated(quote, quote.indexOf(match[0]))) continue;
        quotes.add(quote);
      }
      for (const quote of quotes) {
        findings.push(createFinding({
          level: rule.severity,
          checkpoint,
          title: `${rule.title} (аудит: кейсы ${rule.caseNumbers.join(", ")})`,
          quote,
          explanation: rule.wrongClaimDescription,
          suggestion: auditSuggestion(rule.id, targetCard, rule.canonicalCorrection),
          ...sourceFromCard(targetCard),
        }));
      }
      continue;
    }
    const match = rule.pattern.exec(draft);
    if (!match || match.index === undefined) continue;
    const matchQuote = sentenceAt(draft, match.index);
    const quoteIndex = matchQuote.indexOf(match[0]);
    if (quoteIndex >= 0 && locallyNegated(matchQuote, quoteIndex)) continue;

    if (rule.id === "RULE-AREA-OUTDATED") {
      const conflict = findings.find(finding => finding.level === "red" &&
        finding.title === "Площадь кампуса не совпадает с паспортом" &&
        finding.sourceCardId === targetCard.id && matchQuote.includes(finding.quote));
      if (conflict) conflict.title += ` (аудит: кейсы ${rule.caseNumbers.join(", ")})`;
      continue;
    }

    const normalizedMatchQuote = normalizeQuoteForCompare(matchQuote);

    // Избегаем дублирования одной и той же ошибки встроенной проверкой и правилом аудита
    const duplicate = findings.find((existing) => {
      if (existing.title.includes("аудит:")) return false;
      if (
        existing.level !== rule.severity ||
        existing.checkpoint !== checkpoint
      ) {
        return false;
      }
      const existingQuote = normalizeQuoteForCompare(existing.quote);
      return (
        existingQuote === normalizedMatchQuote ||
        existingQuote.includes(normalizedMatchQuote) ||
        normalizedMatchQuote.includes(existingQuote)
      );
    });

    if (duplicate) {
      const caseSuffix = `(аудит: кейсы ${rule.caseNumbers.join(", ")})`;
      if (!duplicate.title.includes("аудит:")) {
        duplicate.title = `${duplicate.title} ${caseSuffix}`;
      }
      continue;
    }

    findings.push(
      createFinding({
        level: rule.severity,
        checkpoint,
        title: `${rule.title} (аудит: кейсы ${rule.caseNumbers.join(", ")})`,
        quote: matchQuote,
        explanation: rule.wrongClaimDescription,
        suggestion: auditSuggestion(rule.id, targetCard, rule.canonicalCorrection),
        ...sourceFromCard(targetCard),
      })
    );
  }

  if (primaryProject) {
    const titleInDraft = normalizedDraft.includes(
      normalize(primaryProject.title)
    );

    if (titleInDraft) {
      findings.push(
        createFinding({
          level: "green",
          checkpoint: "names",
          title: "Название проекта совпадает с карточкой",
          quote: primaryProject.title,
          explanation:
            "Официальное название проекта в черновике совпадает с карточкой-источником.",
          suggestion: "Оставьте формулировку без изменений.",
          ...sourceFromCard(primaryProject),
        })
      );
    }

    const sphereRoots = uniqueRoots(primaryProject.sphere);
    const themeMatched = sphereRoots.some((root) => draftRoots.has(root));

    if (themeMatched) {
      findings.push(
        createFinding({
          level: "green",
          checkpoint: "names",
          title: "Тематика проекта подтверждена",
          quote: primaryProject.sphere,
          explanation:
            "Сфера проекта в черновике совпадает с полем «Сфера» карточки.",
          suggestion: "Тематику можно оставить без изменений.",
          ...sourceFromCard(primaryProject),
        })
      );
    }
  }

  const geographyMatched =
    /кампус/i.test(draft) && normalizedDraft.includes("челябинск");

  if (geographyMatched) {
    const geographyCard =
      campusCard ?? primaryProject ?? referencedLabs[0] ?? null;

    if (geographyCard) {
      findings.push(
        createFinding({
          level: "green",
          checkpoint: "campus",
          title: "География подтверждена базой",
          quote:
            /Челябинск[а-яё]*|Челябинской\s+области/i.exec(draft)?.[0] ??
            "Челябинск",
          explanation:
            "Кампус «Южный Урал» и проекты базы привязаны к Челябинской области — география в черновике корректна.",
          suggestion: "Географию можно оставить без изменений.",
          ...sourceFromCard(geographyCard),
        })
      );
    }
  }

  if (!exactDescriptionCard) {
    for (const finding of findings) {
      if (finding.level !== "green" || finding.checkpoint === "figures") {
        confirmedFigures.add(evidenceKey(finding.quote));
        for (const statement of factCheckStatements(finding.quote))
          confirmedFigures.add(evidenceKey(statement));
      }
    }
    findings.push(...uncoveredStatements(statements, cards, confirmedFigures, official));
  }

  if (findings.length === 0) {
    findings.push(
      exactDescriptionCard
        ? createFinding({
            level: "green",
            checkpoint: "names",
            title: "Описание совпадает с официальной карточкой",
            quote: draft.trim(),
            explanation:
              "Текст полностью совпадает с утверждённым описанием карточки.",
            suggestion: "Сохраните ссылку на официальную карточку.",
            ...sourceFromCard(exactDescriptionCard),
          })
        : createFinding({
            level: "yellow",
            checkpoint: "figures",
            title: "Подтверждение не найдено",
            quote: draft.trim(),
            explanation:
              "Для текста не найден проверяемый факт в официальных карточках. Отсутствие найденных противоречий не подтверждает текст.",
            suggestion:
              "Уточните предмет проверки и добавьте официальный источник.",
            ...noSource,
          })
    );
  }
  for (const finding of findings) {
    const offset = draft.indexOf(finding.quote);
    if (
      offset >= 0 &&
      finding.quote &&
      draft.indexOf(finding.quote, offset + 1) < 0
    ) {
      finding.quoteStart = offset;
      finding.quoteEnd = offset + finding.quote.length;
    }
  }
  const deduped = Array.from(
    new Map(findings.map((finding) => [finding.id, finding])).values()
  );

  const levelOrder: Record<FactCheckLevel, number> = {
    red: 0,
    yellow: 1,
    green: 2,
  };

  const sorted = deduped.sort(
    (a, b) => levelOrder[a.level] - levelOrder[b.level]
  );
  const summary = buildSummary(sorted);

  return {
    findings: sorted,
    summary,
    checkpoints: buildCheckpointSummaries(sorted),
    canPublish: summary.red === 0 && summary.yellow === 0 && summary.green > 0,
    coverage:
      summary.red || summary.yellow
        ? summary.green
          ? "partial"
          : "unverified"
        : "confirmed",
    checkedChars: draft.trim().length,
  };
}

function rewriteSection(
  id: string,
  heading: string,
  fields: string[],
  level: 2 | 3 = 2
): CanonicalRewriteSection {
  return {
    id,
    heading,
    level,
    chunks: fields
      .filter((field) => field.trim())
      .map((content, index) => ({
        id: id + "-" + (index + 1),
        content,
      })),
  };
}

function campusMetricSection(campus: CampusCard) {
  return rewriteSection(
    "campus-metrics",
    "Параметры кампуса",
    campus.campusMetrics.map((metric) =>
      [metric.label + ": " + metric.value, metric.note]
        .filter(Boolean)
        .join("\n")
    )
  );
}

function buildScopedRewrite(
  title: string,
  description: string,
  sections: CanonicalRewriteSection[],
  sourceCards: KnowledgeCard[]
): CanonicalRewrite {
  let lead = "";
  for (const statement of description
    .split(/[\r\n]/u)
    .filter((line) => !/(?:^|\s[—–-]\s)(?:https?:\/\/|www\.)/iu.test(line.trim()))
    .flatMap(factCheckSentenceRanges)
    .map(({ text }) => text.trim())
    .filter(Boolean)) {
    const next = lead ? lead + " " + statement : statement;
    if (next.length > 1_000) break;
    lead = next;
  }
  if (!lead) lead = title;
  const nonemptySections = sections.filter(
    (section) => section.chunks.length > 0
  );
  return renderCanonicalRewrite({
    title,
    lead,
    sections: nonemptySections,
    sourceCardIds: sourceCards.map((card) => card.id),
    sourceCardTitles: sourceCards.map((card) => card.title),
  });
}

export function renderCanonicalRewrite(rewrite: Omit<CanonicalRewrite, "plainText">): CanonicalRewrite {
  return {
    ...rewrite,
    plainText: [
      rewrite.title,
      rewrite.lead,
      ...rewrite.sections.flatMap((section) => [
        section.heading,
        ...section.chunks.map((chunk) => chunk.content),
      ]),
    ].join("\n\n"),
  };
}

function labPlacementSection(lab: LaboratoryCard) {
  return rewriteSection("lab-status", "Площадка и статус лаборатории", [
    lab.title,
    placementStatusLabels[lab.placementStatus],
    lab.placementDetails,
  ]);
}

function buildProjectRewrite(
  project: ProjectCard,
  lab: LaboratoryCard | null,
  campus: CampusCard | null
): CanonicalRewrite {
  const participants = project.isJoint
    ? project.participantUniversityIds.map(getUniversityName)
    : [
        getUniversityName(project.initiatorUniversityId),
        ...project.coExecutors,
      ];
  const sections = [
    rewriteSection("participants", "Вузы и партнёры", [
      project.title,
      "Инициатор: " + getUniversityName(project.initiatorUniversityId),
      "Участники: " + [...new Set(participants)].join(", "),
      project.industrialPartner
        ? "Индустриальный партнёр: " + project.industrialPartner
        : "",
    ]),
    rewriteSection("result", "Стадия и результаты проекта", [
      "Контур: " + project.contour,
      "Стадия готовности: " + project.readinessStage,
      ...project.confirmedFigures.map(
        (figure) => project.title + ": " + figure
      ),
    ]),
    ...(lab ? [labPlacementSection(lab)] : []),
    ...(campus ? [campusMetricSection(campus)] : []),
  ];
  return buildScopedRewrite(
    project.title,
    project.referenceDescription,
    sections,
    [project, ...(lab ? [lab] : []), ...(campus ? [campus] : [])]
  );
}

function buildLabRewrite(
  lab: LaboratoryCard,
  campus: CampusCard | null
): CanonicalRewrite {
  const sections = [
    labPlacementSection(lab),
    rewriteSection(
      "lab-directions",
      "Направления работы и оборудование",
      [...lab.workDirections, ...lab.equipment, ...lab.confirmedIndicators],
      3
    ),
    ...(campus ? [campusMetricSection(campus)] : []),
  ];
  return buildScopedRewrite(lab.title, lab.referenceDescription, sections, [
    lab,
    ...(campus ? [campus] : []),
  ]);
}

function buildCampusRewrite(campus: CampusCard): CanonicalRewrite {
  return buildScopedRewrite(
    campus.title,
    campus.referenceDescription,
    [
      campusMetricSection(campus),
      rewriteSection(
        "campus-entities",
        "Организации и их роли",
        campus.legalEntities.map((entity) => entity.name + " — " + entity.role),
        3
      ),
      rewriteSection(
        "campus-tariffs",
        "Тарифы",
        campus.tariffs.map((item) => item.label + " — " + item.value),
        3
      ),
    ],
    [campus]
  );
}

const typedEquipment =
  /(?<![\p{L}\p{N}])((?:робот[а-яё]*(?:[-‐‑]манипулятор[а-яё]*)?|манипулятор[а-яё]*|контроллер[а-яё]*|стан(?:ок|к[а-яё]*)|принтер[а-яё]*|датчик[а-яё]*|сканер[а-яё]*|тренаж[её]р[а-яё]*|стенд[а-яё]*|микроскоп[а-яё]*))(\s+модел[ьи])?\s+([«"“])?([\p{L}\p{N}][\p{L}\p{N}-]*)[»"”]?((?:[ \t]+[a-z0-9][a-z0-9-]*(?![\p{L}\p{N}-])[»"”]?)*)/giu;
const bareModel =
  /(?<![\p{L}\p{N}-])[\p{L}][\p{L}\p{N}-]{2,}(?![\p{L}\p{N}-])/gu;
const modelVariant =
  /^[»"”]?((?:[ \t]+[a-z0-9][a-z0-9-]*(?![\p{L}\p{N}-])[»"”]?)*)/iu;
const modelName = /(?<![\p{L}\p{N}])[A-Z][A-Za-z\d-]{2,}(?![\p{L}\p{N}])/gu;
const equipmentActivity =
  /(?<!\p{L})(?:действует|работает|установлен[ао]?|применяется|используется)\s+[«"“]?$/iu;
type EquipmentMention = { kind: string; model: string; variant: string };

function recordedEquipmentModels(cards: KnowledgeCard[]) {
  return [...new Set(cards.flatMap((card) => card.type === "laboratory"
    ? card.equipment.flatMap((item) => withoutSourceUrls(item).match(modelName) ?? [])
    : []
  ).map((model) => model.toLowerCase()))];
}

function namedEquipmentMentions(text: string, models: string[]): EquipmentMention[] {
  const input = withoutSourceUrls(text);
  // Capitalization alone also occurs in ordinary project names such as
  // «тренажёр Травмпункта». An unknown Cyrillic model needs an explicit label.
  const typed = [...input.matchAll(typedEquipment)].filter(([, kind, designation, openingQuote, model]) =>
    /[a-z0-9]/iu.test(model) || Boolean(designation || openingQuote) ||
    (/^робот/iu.test(kind) && /^куки$/iu.test(model)) ||
    models.some((known) => sameKnowledgeWord(model.toLowerCase(), known))
  );
  const mentions = typed.map(([, kind, , , model, variant]) => ({ kind, model, variant }));
  for (const match of input.matchAll(bareModel)) {
    const [model] = match;
    if (typed.some((other) => other.index <= match.index &&
        match.index < other.index + other[0].length)) continue;
    const known = models.some((name) => sameKnowledgeWord(model.toLowerCase(), name));
    if (known || (/^[a-z][a-z0-9-]{2,}$/iu.test(model) &&
        equipmentActivity.test(input.slice(Math.max(0, match.index - 50), match.index)))) {
      const variant = modelVariant.exec(input.slice(match.index + model.length))?.[1] ?? "";
      mentions.push({ kind: "", model, variant });
    }
  }
  return mentions;
}

function scopedEquipmentLab(
  mentions: EquipmentMention[],
  labs: LaboratoryCard[]
): LaboratoryCard | undefined {
  const matches = mentions.map(({ kind, model, variant }) => {
    const auditedTypo = /^робот/iu.test(kind) && /^куки$/iu.test(model);
    const terms = knowledgeQueryTerms(`${kind} ${auditedTypo ? "KUKA" : model}${variant}`);
    const eligible = labs.filter((lab) =>
      (!auditedTypo || lab.id === "lab-midis-kuka") &&
      knowledgeCardMatch(lab, terms, "equipment") > 0
    );
    return eligible.length === 1 ? eligible[0] : undefined;
  });
  const lab = matches[0];
  return lab && matches.every((match) => match?.id === lab.id) ? lab : undefined;
}

export function buildCanonicalRewrite(
  draft: string,
  cards: KnowledgeCard[]
): CanonicalRewrite | null {
  cards = cards
    .map(getApprovedVersion)
    .filter((card): card is KnowledgeCard => card !== null);
  const labs = cards.filter((card): card is LaboratoryCard => card.type === "laboratory");
  const equipment = namedEquipmentMentions(draft, recordedEquipmentModels(labs));
  if (equipment.length) {
    const lab = scopedEquipmentLab(equipment, labs);
    return lab
      ? buildScopedRewrite(lab.title, lab.referenceDescription, [], [lab])
      : null;
  }
  const normalizedDraft = normalize(draft);
  const draftRoots = new Set(tokenRoots(draft));
  const referencedCards = cards.filter((card) =>
    isCardReferenced(card, draftRoots, normalizedDraft)
  );

  const project =
    referencedCards.find(
      (card): card is ProjectCard => card.type === "project" && card.isJoint
    ) ??
    referencedCards.find(
      (card): card is ProjectCard => card.type === "project"
    ) ??
    null;

  const lab =
    referencedCards.find(
      (card): card is LaboratoryCard => card.type === "laboratory"
    ) ?? null;

  const campus =
    referencedCards.find(
      (card): card is CampusCard => card.type === "campus"
    ) ??
    (normalizedDraft.includes("кампус")
      ? (cards.find((card): card is CampusCard => card.type === "campus") ??
        null)
      : null);

  if (project) {
    return buildProjectRewrite(project, lab, campus);
  }

  if (lab) {
    return buildLabRewrite(lab, campus);
  }

  if (
    campus &&
    (referencedCards.includes(campus) ||
      checkFactText(draft, [campus]).findings.some((finding) =>
        finding.sourceCardId === campus.id && finding.level === "red"
      )) &&
    (universitiesIn(draft).length === 0 ||
      (universitiesIn(sentenceAt(draft, 0)).length === 0 &&
        /кампус/i.test(sentenceAt(draft, 0))))
  ) {
    return buildCampusRewrite(campus);
  }

  return null;
}
